import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renameWithRetry } from "./atomic.mjs";
import { acquireLock } from "./lock.mjs";
import { hasControl, stripControls } from "./sanitize.mjs";

const STATE_VERSION = 1;
const SAVE_LOCK_STALE_MS = 10_000;
const SAVE_LOCK_RETRIES = 5;
const SAVE_LOCK_RETRY_MS = 50;
const LINK_RETRIES = 2;
const LINK_RETRY_MS = 30;

export async function getSessionIdentity(codexHome, sessionId, capture, { linkImpl = link } = {}) {
  if (!codexHome || !sessionId) return null;
  const path = sessionStatePath(codexHome, sessionId).replace(/\.json$/, ".identity.json");
  try {
    return parseIdentity(await readFile(path, "utf8"));
  } catch (error) {
    // An unreadable/corrupt record must not silently adopt today's account.
    if (error.code !== "ENOENT") throw error;
  }
  let identity;
  try {
    identity = await capture(codexHome);
  } catch {
    // A failed capture (reader error, seat change, unreadable seat) is not "no account":
    // nothing is recorded now. A later resume of this session does not capture again, so it
    // records the session as unknown; only a start can record an identity.
    return null;
  }
  const record = { version: STATE_VERSION, identity };
  // Validate and whitelist the persisted shape; never retain account/read responses.
  const safeIdentity = parseIdentity(JSON.stringify(record));
  const temporary = `${path}.${randomUUID()}.tmp`;
  let published = false;
  try {
    await mkdir(join(codexHome, "cache-statusband-codex", "sessions"), { recursive: true });
    await writeFile(temporary, `${JSON.stringify({ version: STATE_VERSION, identity: safeIdentity })}\n`, { encoding: "utf8", mode: 0o600 });
    // Publishing a complete file with link is atomic and cannot replace a winner. A refusal
    // that may be momentary (EPERM/EBUSY: another process holding the file) is tried again
    // briefly.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await linkImpl(temporary, path);
        published = true;
        break;
      } catch (error) {
        if (error.code === "EEXIST") break;
        if ((error.code !== "EPERM" && error.code !== "EBUSY") || attempt >= LINK_RETRIES) throw error;
        await new Promise((resolve) => setTimeout(resolve, LINK_RETRY_MS));
      }
    }
  } catch {
    // The record could not be saved (a folder that refuses new files, a full disk, a file
    // system with no hard links...). A concurrent start may have published one meanwhile: if a
    // valid record is there, it is the answer. Otherwise the login just read is still this
    // session's login: use it now, unrecorded, rather than lose the whole usage display. A
    // later resume of this session finds no record and shows it as unknown.
    try {
      return parseIdentity(await readFile(path, "utf8"));
    } catch (readError) {
      // No record at all: use the login just read. A record that exists but cannot be read or
      // parsed is a corrupt one, and (as in the first read above) it must not be replaced by
      // today's account: the session is unknown.
      return readError?.code === "ENOENT" ? safeIdentity : null;
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
  // Either this call published the record, or another start won and its file is the answer.
  return published ? safeIdentity : parseIdentity(await readFile(path, "utf8"));
}

function parseIdentity(text) {
  const record = JSON.parse(text);
  if (record?.version !== STATE_VERSION) throw new Error("Unknown session identity version");
  const value = record.identity;
  if (value === null) return null;
  if (!value || typeof value.key !== "string" || !/^account:[^\s@]+@[^\s@]+$/.test(value.key) || hasControl(value.key)
      || typeof value.label !== "string" || !value.label || value.label.length > 320
      || hasControl(value.label) || value.unavailable !== false) {
    throw new Error("Invalid session identity");
  }
  return { key: value.key, label: value.label, unavailable: false };
}

export async function saveSessionState(codexHome, sessionId, summary, savedAt = Date.now(), { renameImpl } = {}) {
  const state = stateFromSummary(summary, savedAt);
  if (!codexHome || !sessionId || !state) return false;
  const path = sessionStatePath(codexHome, sessionId);
  await mkdir(join(codexHome, "cache-statusband-codex", "sessions"), { recursive: true });
  // One writer per session; a fresh lock means another Stop hook is saving right now, and a
  // lock file refused for a moment (acquireLock also returns null for that) takes the same
  // path. A save takes milliseconds, so wait briefly before giving up on this one.
  let lock = await acquireLock(`${path}.lock`, { staleMs: SAVE_LOCK_STALE_MS });
  for (let retry = 0; !lock && retry < SAVE_LOCK_RETRIES; retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, SAVE_LOCK_RETRY_MS));
    lock = await acquireLock(`${path}.lock`, { staleMs: SAVE_LOCK_STALE_MS });
  }
  if (!lock) return false;
  try {
    const previous = await loadSessionState(codexHome, sessionId);
    if (previous && timestamp(previous.contextAt) > timestamp(state.contextAt)) return false;
    // A report that names no model or effort (a rollout whose latest turn is out of reach)
    // does not erase what was saved before.
    if (previous) {
      state.model ??= previous.model ?? null;
      state.effort ??= previous.effort ?? null;
    }
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
      await renameWithRetry(temporary, path, renameImpl ? { rename: renameImpl } : {});
    } finally {
      await unlink(temporary).catch(() => {});
    }
    return true;
  } finally {
    await lock.release();
  }
}

export async function loadSessionState(codexHome, sessionId) {
  if (!codexHome || !sessionId) return null;
  try {
    const value = JSON.parse(await readFile(sessionStatePath(codexHome, sessionId), "utf8"));
    if (value?.version !== STATE_VERSION) return null;
    if (!Number.isFinite(value.contextUsed) || !Number.isFinite(value.contextWindow)) return null;
    // A saved file is untrusted too: a contextAt that is neither text nor a number (an array
    // would still parse as a date) is dropped rather than trusted.
    if (typeof value.contextAt !== "string" && !Number.isFinite(value.contextAt)) {
      const { contextAt, ...rest } = value;
      return rest;
    }
    return value;
  } catch {
    return null;
  }
}

export function mergeSavedContext(summary, state) {
  if (!state) return summary;
  const current = summary ?? {};
  const currentAt = timestamp(current.tokenReportAt ?? current.updatedAt);
  const savedAt = timestamp(state.contextAt);
  if (Number.isFinite(current.contextUsed) && Number.isFinite(current.contextWindow) && currentAt >= savedAt) return current;
  return {
    ...current,
    model: current.model ?? state.model ?? null,
    effort: current.effort ?? state.effort ?? null,
    tokenReportAt: state.contextAt,
    updatedAt: current.updatedAt ?? state.contextAt,
    contextUsed: state.contextUsed,
    contextWindow: state.contextWindow,
  };
}

function stateFromSummary(summary, savedAt) {
  if (!Number.isFinite(summary?.contextUsed) || !Number.isFinite(summary?.contextWindow)) return null;
  return {
    version: STATE_VERSION,
    savedAt,
    contextAt: summary.tokenReportAt ?? summary.updatedAt ?? new Date(savedAt).toISOString(),
    contextUsed: summary.contextUsed,
    contextWindow: summary.contextWindow,
    model: safeText(summary.model),
    effort: safeText(summary.effort),
  };
}

function sessionStatePath(codexHome, sessionId) {
  const name = createHash("sha256").update(String(sessionId)).digest("hex");
  return join(codexHome, "cache-statusband-codex", "sessions", `${name}.json`);
}

function timestamp(value) {
  const parsed = typeof value === "number" ? value : Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeText(value) {
  if (typeof value !== "string") return null;
  const text = stripControls(value);
  return text ? text.slice(0, 120) : null;
}
