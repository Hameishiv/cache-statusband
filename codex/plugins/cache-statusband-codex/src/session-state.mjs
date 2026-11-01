import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const STATE_VERSION = 1;

export async function saveSessionState(codexHome, sessionId, summary, savedAt = Date.now()) {
  const state = stateFromSummary(summary, savedAt);
  if (!codexHome || !sessionId || !state) return false;
  const path = sessionStatePath(codexHome, sessionId);
  const previous = await loadSessionState(codexHome, sessionId);
  if (previous && timestamp(previous.contextAt) > timestamp(state.contextAt)) return false;
  await mkdir(join(codexHome, "cache-statusband-codex", "sessions"), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return true;
}

export async function loadSessionState(codexHome, sessionId) {
  if (!codexHome || !sessionId) return null;
  try {
    const value = JSON.parse(await readFile(sessionStatePath(codexHome, sessionId), "utf8"));
    if (value?.version !== STATE_VERSION) return null;
    if (!Number.isFinite(value.contextUsed) || !Number.isFinite(value.contextWindow)) return null;
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
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text ? text.slice(0, 120) : null;
}
