import { createHash, randomUUID } from "node:crypto";
import { link, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeFolder, renameWithRetry } from "./atomic.mjs";
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
    await makeSessionsFolder(codexHome);
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
    // valid record is there, it is the answer. If there is no record at all, the login just
    // read is still this session's login: use it now, unrecorded, rather than lose the whole
    // usage display; a later resume then finds no record and shows the session as unknown. If
    // a record is there but corrupt, this start shows the session as unknown too (below), and a
    // later resume finds that same corrupt record and shows it as unknown as well.
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

// Only the plugin's own two folders are created, one at a time; a Codex home that does not
// exist is never created (the error is thrown to the caller).
async function makeSessionsFolder(codexHome) {
  const dataDir = join(codexHome, "cache-statusband-codex");
  await makeFolder(dataDir);
  await makeFolder(join(dataDir, "sessions"));
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
  await makeSessionsFolder(codexHome);
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
    // One rule for the kept pair: a report that names neither model nor effort (a rollout
    // whose latest turn is out of reach; a turn record counts only if it names a model, so a
    // rollout never reports an effort alone) does not erase what was saved before. A report
    // that names a model replaces both, so a new model is never paired with an old effort.
    if (previous && state.model === null && state.effort === null) {
      state.model = safeText(previous.model);
      state.effort = safeText(previous.effort);
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
  const unnamed = !current.model && !current.effort;
  if (Number.isFinite(current.contextUsed) && Number.isFinite(current.contextWindow) && currentAt >= savedAt) {
    // The same rule as the save: a rollout whose own latest turn is out of reach names neither
    // model nor effort, and the report Stop saved is this very report, so Stop's model stands.
    if (unnamed && typeof current.tokenReportAt === "string" && savedAt > 0 && currentAt === savedAt) {
      return { ...current, model: safeText(state.model), effort: safeText(state.effort) };
    }
    return current;
  }
  return {
    ...current,
    // The rollout's own model and effort are taken together, or the saved pair is.
    model: unnamed ? safeText(state.model) : current.model ?? null,
    effort: unnamed ? safeText(state.effort) : current.effort ?? null,
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
