import { open, readdir, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;
// How far back past the tail we look for the session's latest turn_context when the tail has none.
const CONTEXT_CHUNK_BYTES = 256 * 1024;
const CONTEXT_CHUNKS = 4;
// The look-back's last chunk reaches this far below the head window, so a turn_context line
// that crosses the head's cut-off (and so is whole in neither the head nor the chunks above
// it) is still seen. A line longer than this that crosses the cut is not.
const HEAD_OVERLAP_BYTES = 64 * 1024;

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

  // The head of a truncated file only says who the session is and where it started (its
  // session_meta); its timestamps and token counts are old news and must not outrank the tail.
  // A turn_context in the head is held back whole, model, effort and cwd alike, because it may
  // be many turns out of date: it is used only if the look-back reaches the head without
  // finding anything later (see below), and never lends its cwd to an unknown model.
  let headContext = null;
  let tailHasContext = false;
  for (const [chunk, fromHead] of [[edges.head, true], [edges.tail, false]]) {
    if (!chunk) continue;
    for (const line of chunk.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      if (fromHead && item?.type === "turn_context" && item.payload) {
        headContext = item.payload;
        continue;
      }
      if (!fromHead && item?.type === "turn_context" && item.payload) tailHasContext = true;
      consume(item, summary, fromHead);
    }
  }
  if (edges.truncated && !tailHasContext) {
    // The tail window did not include a turn_context. Look in the stretch just before it; if
    // that stretch reaches the head, the head's context is the latest there is. Otherwise the
    // model and effort are unknown, which is better than showing a first-turn value.
    const found = await edges.findEarlierContext();
    if (found?.payload) {
      summary.cwd = text(found.payload.cwd) ?? summary.cwd;
      summary.model = text(found.payload.model) ?? summary.model;
      summary.effort = text(found.payload.effort) ?? text(found.payload.reasoning_effort) ?? summary.effort;
    } else if (found?.reachedHead && headContext) {
      summary.cwd = text(headContext.cwd) ?? summary.cwd;
      summary.model = text(headContext.model) ?? summary.model;
      summary.effort = text(headContext.effort) ?? text(headContext.reasoning_effort) ?? summary.effort;
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
  if (fromHead && item?.type !== "session_meta") return;
  if (!fromHead && typeof item?.timestamp === "string") summary.updatedAt = item.timestamp;

  if (item?.type === "session_meta" && payload) {
    summary.id = text(payload.id) ?? summary.id;
    summary.cwd = text(payload.cwd) ?? summary.cwd;
    summary.source = scalarSource(payload.source) ?? summary.source;
    summary.createdAt = text(payload.timestamp) ?? text(item.timestamp) ?? summary.createdAt;
    summary.contextWindow = number(payload.context_window) ?? summary.contextWindow;
    return;
  }

  if (item?.type === "turn_context" && payload) {
    summary.cwd = text(payload.cwd) ?? summary.cwd;
    summary.model = text(payload.model) ?? summary.model;
    summary.effort = text(payload.effort) ?? text(payload.reasoning_effort) ?? summary.effort;
    return;
  }

  if (item?.type !== "event_msg" || payload?.type !== "token_count") return;
  const info = payload.info;
  if (!info) return;
  const last = info.last_token_usage ?? info.lastTokenUsage;
  const total = info.total_token_usage ?? info.totalTokenUsage;
  summary.tokenReportAt = text(item.timestamp) ?? summary.tokenReportAt;
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
    if (Object.keys(numbers).length) result[name] = numbers;
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

// Transcript fields are untrusted: a field of the wrong type is ignored, never displayed.
function text(value) {
  return typeof value === "string" ? value : null;
}

function number(value) {
  return Number.isFinite(value) ? value : null;
}

function scalarSource(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return text(value.type);
  return null;
}

async function readEdges(path, size) {
  const handle = await open(path, "r");
  try {
    if (size <= HEAD_BYTES + TAIL_BYTES) return { head: null, tail: await handle.readFile({ encoding: "utf8" }), truncated: false };
    const head = Buffer.alloc(HEAD_BYTES);
    const tail = Buffer.alloc(TAIL_BYTES);
    await handle.read(head, 0, HEAD_BYTES, 0);
    await handle.read(tail, 0, TAIL_BYTES, size - TAIL_BYTES);
    const firstNewline = tail.indexOf(0x0a);
    return {
      head: head.toString("utf8"),
      tail: firstNewline >= 0 ? tail.subarray(firstNewline + 1).toString("utf8") : "",
      truncated: true,
      findEarlierContext: () => findEarlierContext(path, size),
    };
  } finally {
    await handle.close();
  }
}

// Reads fixed-size chunks backwards from just before the tail window, down to a little below
// the head window's end (HEAD_OVERLAP_BYTES) -- a chunk that starts within the head window
// itself is extended to that floor and counts as reaching the head -- and returns { payload } for the latest
// turn_context found, { reachedHead: true } if the chunks ran all the way back to the head
// without finding one, or null.
async function findEarlierContext(path, size) {
  const handle = await open(path, "r");
  try {
    let end = size - TAIL_BYTES;
    // The tail window starts part-way through a line: the bytes from `end` up to the first
    // newline are the end of a line that begins earlier, so they are carried back.
    const probe = Buffer.alloc(Math.min(CONTEXT_CHUNK_BYTES, size - end));
    await handle.read(probe, 0, probe.length, end);
    const probeNewline = probe.indexOf(0x0a);
    let carry = probeNewline >= 0 ? probe.subarray(0, probeNewline) : probe;
    const floor = Math.max(0, HEAD_BYTES - HEAD_OVERLAP_BYTES);
    for (let i = 0; i < CONTEXT_CHUNKS; i += 1) {
      let start = Math.max(floor, end - CONTEXT_CHUNK_BYTES);
      // A chunk that would start inside the head window already joins it: it is read down to the
      // floor so the line crossing the head's cut-off is whole, and the head is then reached.
      if (end - CONTEXT_CHUNK_BYTES <= HEAD_BYTES) start = floor;
      if (start >= end) return { reachedHead: true };
      const chunk = Buffer.alloc(end - start);
      await handle.read(chunk, 0, chunk.length, start);
      const whole = Buffer.concat([chunk, carry]);
      // The first line of a chunk begins in an earlier chunk (or in the head's cut-off end).
      const firstNewline = whole.indexOf(0x0a);
      const complete = firstNewline >= 0 ? whole.subarray(firstNewline + 1) : Buffer.alloc(0);
      const lines = complete.toString("utf8").split(/\r?\n/);
      for (let j = lines.length - 1; j >= 0; j -= 1) {
        if (!lines[j].trim()) continue;
        let item;
        try {
          item = JSON.parse(lines[j]);
        } catch {
          continue;
        }
        if (item?.type === "turn_context" && item.payload) return { payload: item.payload };
      }
      carry = firstNewline >= 0 ? whole.subarray(0, firstNewline) : whole;
      end = start;
      if (start <= HEAD_BYTES) return { reachedHead: true };
    }
    return null;
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
  if (typeof cwd !== "string" || !cwd) return "?";
  const pieces = cwd.split(/[\\/]/).filter(Boolean);
  return pieces.at(-1) || sep;
}
