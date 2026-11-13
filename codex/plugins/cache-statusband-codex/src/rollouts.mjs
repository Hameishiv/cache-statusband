import { open, readdir, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;

export function defaultCodexHome(env = process.env) {
  if (env.CODEX_HOME) return resolve(env.CODEX_HOME);
  const home = env.USERPROFILE || env.HOME;
  if (!home) throw new Error("Could not locate CODEX_HOME; pass --codex-home.");
  return resolve(home, ".codex");
}

export async function parseRollout(path) {
  const fileStat = await stat(path);
  const edges = await readEdges(path, fileStat.size);
  const summary = {
    path: resolve(path),
    id: basename(path, ".jsonl"),
    cwd: null,
    source: null,
    model: null,
    effort: null,
    createdAt: null,
    updatedAt: fileStat.mtime.toISOString(),
    tokenReportAt: null,
    contextUsed: null,
    contextWindow: null,
    totalUsage: null,
    rateLimits: null,
  };

  // The head of a truncated file only says who/where the session is; its timestamps
  // and token counts are old news and must not outrank the tail.
  for (const [text, fromHead] of [[edges.head, true], [edges.tail, false]]) {
    if (!text) continue;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      consume(item, summary, fromHead);
    }
  }
  return summary;
}

export async function scanSessions(codexHome, { includeArchived = false, limit = Infinity, rolloutParser = parseRollout } = {}) {
  const roots = [{ path: join(codexHome, "sessions"), archived: false }];
  if (includeArchived) roots.push({ path: join(codexHome, "archived_sessions"), archived: true });
  const found = [];
  for (const root of roots) {
    for (const path of await findJsonl(root.path)) {
      try {
        found.push({ path, archived: root.archived, modifiedAt: (await stat(path)).mtimeMs });
      } catch {
        // A session may move between directory enumeration and stat.
      }
    }
  }
  found.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path));
  const summaries = [];
  for (const item of found) {
    if (summaries.length >= limit) break;
    try {
      summaries.push({ ...(await rolloutParser(item.path)), archived: item.archived });
    } catch {
      // A session can move or be written while scanning; omit that one snapshot.
    }
  }
  return summaries;
}

function consume(item, summary, fromHead = false) {
  const payload = item?.payload;
  if (fromHead && item?.type !== "session_meta" && item?.type !== "turn_context") return;
  if (!fromHead && typeof item?.timestamp === "string") summary.updatedAt = item.timestamp;

  if (item?.type === "session_meta" && payload) {
    summary.id = payload.id ?? summary.id;
    summary.cwd = payload.cwd ?? summary.cwd;
    summary.source = scalarSource(payload.source) ?? summary.source;
    summary.createdAt = payload.timestamp ?? item.timestamp ?? summary.createdAt;
    summary.contextWindow = number(payload.context_window) ?? summary.contextWindow;
    return;
  }

  if (item?.type === "turn_context" && payload) {
    summary.cwd = payload.cwd ?? summary.cwd;
    summary.model = payload.model ?? summary.model;
    summary.effort = payload.effort ?? payload.reasoning_effort ?? summary.effort;
    return;
  }

  if (item?.type !== "event_msg" || payload?.type !== "token_count") return;
  const info = payload.info;
  if (!info) return;
  const last = info.last_token_usage ?? info.lastTokenUsage;
  const total = info.total_token_usage ?? info.totalTokenUsage;
  summary.tokenReportAt = item.timestamp ?? summary.tokenReportAt;
  summary.contextUsed = number(last?.total_tokens ?? last?.totalTokens) ?? summary.contextUsed;
  summary.contextWindow = number(info.model_context_window ?? info.modelContextWindow) ?? summary.contextWindow;
  summary.totalUsage = usage(total) ?? summary.totalUsage;
  summary.rateLimits = safeRateLimits(info.rate_limits ?? info.rateLimits) ?? summary.rateLimits;
}

function safeRateLimits(value) {
  if (!value || typeof value !== "object") return null;
  const result = {};
  for (const name of ["primary", "secondary"]) {
    const window = value[name];
    if (!window || typeof window !== "object") continue;
    const numbers = {};
    for (const [key, entry] of Object.entries(window)) {
      if (/^[A-Za-z_]{1,40}$/.test(key) && Number.isFinite(entry)) numbers[key] = entry;
    }
    result[name] = numbers;
  }
  return Object.keys(result).length ? result : null;
}

function usage(value) {
  if (!value || typeof value !== "object") return null;
  return {
    inputTokens: number(value.input_tokens ?? value.inputTokens),
    cachedInputTokens: number(value.cached_input_tokens ?? value.cachedInputTokens),
    cacheWriteInputTokens: number(value.cache_write_input_tokens ?? value.cacheWriteInputTokens),
    outputTokens: number(value.output_tokens ?? value.outputTokens),
    reasoningOutputTokens: number(value.reasoning_output_tokens ?? value.reasoningOutputTokens),
    totalTokens: number(value.total_tokens ?? value.totalTokens),
  };
}

function number(value) {
  return Number.isFinite(value) ? value : null;
}

function scalarSource(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return value.type ?? null;
  return null;
}

async function readEdges(path, size) {
  const handle = await open(path, "r");
  try {
    if (size <= HEAD_BYTES + TAIL_BYTES) return { head: null, tail: await handle.readFile({ encoding: "utf8" }) };
    const head = Buffer.alloc(HEAD_BYTES);
    const tail = Buffer.alloc(TAIL_BYTES);
    await handle.read(head, 0, HEAD_BYTES, 0);
    await handle.read(tail, 0, TAIL_BYTES, size - TAIL_BYTES);
    const tailText = tail.toString("utf8");
    const firstNewline = tailText.indexOf("\n");
    return { head: head.toString("utf8"), tail: firstNewline >= 0 ? tailText.slice(firstNewline + 1) : "" };
  } finally {
    await handle.close();
  }
}

async function findJsonl(root) {
  const result = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(path);
    }
  }
  return result;
}

export function projectName(cwd) {
  if (!cwd) return "?";
  const pieces = cwd.split(/[\\/]/).filter(Boolean);
  return pieces.at(-1) || sep;
}
