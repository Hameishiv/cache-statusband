/**
 * Grok Build status-line command for the portable part of cache-statusband.
 *
 * Grok writes one JSON object to stdin. This prints at most one coloured line.
 * A missing field is left out. Nothing here is invented.
 *
 * Weekly usage is not in that JSON. /usage reads it from the credits config
 * Grok logs as "billing: fetched credits config". This script reads the last
 * of those lines and shows the percent and reset only when the period is
 * weekly and still open. It does not use the network and does not read a token.
 */

import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

/** Each family is [dark, light], the same pairs the Claude Code band already checked. */
export const HUES = {
  model: ["#1a4f99", "#99c1f1"],
  effort: ["#5a3d8a", "#c9a8f0"],
  context: ["#6b4b00", "#f6d32d"],
  cache: ["#1d5c3d", "#8ff0a4"],
  week: ["#0a5960", "#7fe0e0"],
  cost: ["#7f302a", "#f5a99f"],
};

const TEXT_ON_DARK = "#ffffff";
const TEXT_ON_LIGHT = "#1e1e1e";

function hexRgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

/** WCAG contrast ratio of two #rrggbb colours. */
export function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = hexRgb(hex)
      .map((n) => n / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Dark shade on even positions, light shade on odd ones. */
export function shade(kind, index) {
  const pair = HUES[kind] || HUES.cost;
  const dark = index % 2 === 0;
  return { bg: pair[dark ? 0 : 1], fg: dark ? TEXT_ON_DARK : TEXT_ON_LIGHT };
}

const BILLING_MARKER = "billing: fetched credits config";
const RESCAN_MS = 5 * 60 * 1000;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function trimFixed(value) {
  return value.replace(/\.0$/, "");
}

/** Compact a token count. Non-finite input returns null. */
export function formatTokens(value) {
  const v = finite(value);
  if (v === null) return null;
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  if (abs >= 1e6) {
    const millions = abs / 1e6;
    const body = millions >= 10 ? millions.toFixed(0) : trimFixed(millions.toFixed(1));
    return `${sign}${body}M`;
  }
  if (abs >= 1000) {
    const thousands = abs / 1000;
    const body = thousands >= 100 ? thousands.toFixed(0) : trimFixed(thousands.toFixed(1));
    return `${sign}${body}k`;
  }
  return `${sign}${Math.round(abs)}`;
}

export function modelLabel(model) {
  if (!model || typeof model !== "object") return null;
  return text(model.display_name) || text(model.id);
}

export function contextLabel(window) {
  if (!window || typeof window !== "object") return null;
  const pct = finite(window.used_percentage);
  const used = finite(window.context_tokens);
  const size = finite(window.context_window_size);
  if (pct === null && used === null) return null;
  let label = "ctx";
  if (pct !== null) label += ` ${percentText(pct)}%`;
  if (used !== null) {
    label += pct !== null ? " · " : " ";
    label += formatTokens(used);
    if (size !== null) label += `/${formatTokens(size)}`;
  }
  return label;
}

export function cacheLabel(usage) {
  if (!usage || typeof usage !== "object") return null;
  const read = finite(usage.cache_read_input_tokens);
  const write = finite(usage.cache_creation_input_tokens);
  const parts = [];
  if (read !== null) parts.push(`read ${formatTokens(read)}`);
  if (write !== null) parts.push(`write ${formatTokens(write)}`);
  // the word "cache" leads the segment, whichever counts are present
  return parts.length ? `cache ${parts.join(" · ")}` : null;
}

export function costLabel(usd) {
  const v = finite(usd);
  if (v === null) return null;
  const abs = Math.abs(v);
  if (abs === 0) return "session $0";
  if (abs < 0.01) return v < 0 ? "session >-$0.01" : "session <$0.01";
  if (abs < 10) return `session $${v.toFixed(2)}`;
  return `session $${v.toFixed(0)}`;
}

/** Whole percents stay whole. A tenth is kept. Non-finite input returns null. */
export function percentText(value) {
  const v = finite(value);
  if (v === null) return null;
  const tenths = Math.round(v * 10) / 10;
  return Number.isInteger(tenths) ? String(tenths) : tenths.toFixed(1);
}

/**
 * Time left, in the Claude Code band's format, rounded to the minute first.
 * Up to an hour: "40m". Under a day: "23h05m". A day or more: "7d9h".
 * A non-positive duration returns null.
 */
export function remaining(ms) {
  const v = finite(ms);
  if (v === null || v <= 0) return null;
  // round to the minute first, so just under a day reads "1d0h", not "24h00m"
  const mins = Math.round(v / 60000);
  if (mins >= 1440) {
    const hours = Math.floor(mins / 60);
    return `${Math.floor(hours / 24)}d${hours % 24}h`;
  }
  if (mins <= 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m`;
}

/**
 * Weekly percent and reset, or null.
 * `record` is `{ percent, periodType, periodEnd, fetchedAt }`. A monthly period,
 * a missing percent, or a reset that has already passed is left out.
 * The reading is as old as the credits line Grok last logged, so once it is an
 * hour old the age is shown. A missing or unreadable fetch time, or one more than
 * five minutes in the future, is shown as unknown.
 */
export function weeklyLabel(record, nowMs) {
  if (!record || typeof record !== "object") return null;
  const type = text(record.periodType);
  if (!type || !/_WEEKLY$/.test(type)) return null;
  const pct = finite(record.percent);
  if (pct === null || pct < 0) return null;
  const end = Date.parse(record.periodEnd);
  const now = finite(nowMs);
  if (!Number.isFinite(end) || now === null || end <= now) return null;
  const left = remaining(end - now);
  if (!left) return null;
  const fetched = Date.parse(record.fetchedAt);
  let age = "";
  // a read time well in the future means the clock moved: the age is not known
  if (!Number.isFinite(fetched) || fetched - now > 5 * 60000) age = " (read time unknown)";
  else if (now - fetched >= 3600000) age = ` (read ${remaining(now - fetched)} ago)`;
  return `week ${percentText(pct)}%${age} · ${left}`;
}

/**
 * Capitalise the first word. A leading symbol is skipped, a digit stays
 * ("5h"), and an email stays as written.
 */
export function capFirst(label) {
  if (/^\S+@\S+$/.test(label)) return label;
  return String(label).replace(/^([^\p{L}\p{N}]*)(\p{Ll})/u, (_, lead, letter) => lead + letter.toUpperCase());
}

/** Plain segments, in band order. Missing inputs are skipped, not zeroed. */
export function segments(payload, extras = {}) {
  if (!payload || typeof payload !== "object") return [];
  const now = finite(extras.now) ?? Date.now();
  const effort = text(payload.effort && payload.effort.level);
  const parts = [
    ["model", modelLabel(payload.model)],
    ["effort", effort],
    ["context", contextLabel(payload.context_window)],
    ["cache", cacheLabel(payload.context_window && payload.context_window.session_usage)],
    ["week", weeklyLabel(extras.weekly, now)],
    ["cost", costLabel(payload.cost && payload.cost.total_cost_usd)],
  ];
  return parts
    .map(([kind, label]) => [kind, label && label.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/ {2,}/g, " ").trim()])
    .filter(([, label]) => label)
    .map(([kind, label]) => ({ kind, label: capFirst(label) }));
}

function ansi(fg, bg) {
  const [fr, fgG, fb] = hexRgb(fg);
  const [br, bgG, bb] = hexRgb(bg);
  return `\x1b[38;2;${fr};${fgG};${fb};48;2;${br};${bgG};${bb}m`;
}

function paint(label, kind, index, nextKind) {
  const color = shade(kind, index);
  let out = `${ansi(color.fg, color.bg)} ${label} `;
  if (nextKind) {
    const next = shade(nextKind, index + 1);
    out += `${ansi(color.bg, next.bg)}▶`;
  } else {
    out += "\x1b[0m";
  }
  return out;
}

/**
 * Visible columns of the painted band: a space either side of each label, and
 * one arrow between. Counts code points, so a wide character (an emoji or CJK
 * in a model name) counts as one column.
 */
export function bandWidth(parts) {
  return parts.reduce((sum, part, i) => sum + [...part.label].length + 2 + (i < parts.length - 1 ? 1 : 0), 0);
}

/**
 * One status line, or "" when there is nothing we can show. With
 * extras.columns set (Grok's COLUMNS), trailing segments are dropped whole
 * until the band fits, and a lone segment that still does not fit prints
 * nothing, so a cut never leaves part of a number behind.
 */
export function render(payload, extras) {
  const parts = segments(payload, extras);
  if (parts.length === 0) return "";
  const columns = finite(extras && extras.columns);
  if (columns !== null && columns > 0) {
    while (parts.length > 1 && bandWidth(parts) > columns) parts.pop();
    // a lone segment that still does not fit would be cut: even a model name carries a version figure
    if (bandWidth(parts) > columns) return "";
  }
  return parts.map((part, i) => paint(part.label, part.kind, i, parts[i + 1]?.kind)).join("");
}

/**
 * A path setting, or null when it is unset or relative. The script runs in the
 * repository Grok has open, so a relative path would point inside it.
 */
function absoluteSetting(name) {
  const value = process.env[name];
  if (!value || !isAbsolute(value)) return null;
  // on Windows "\x" is relative to the current drive: require a drive letter or a UNC path
  if (process.platform === "win32" && !/^([a-zA-Z]:[\\/]|[\\/]{2}[^\\/])/.test(value)) return null;
  return normalize(value);
}

/**
 * Grok's billing log as a full path, or null when CSB_BILLING_LOG is set to an
 * empty string or to a relative path: a log that was asked for and cannot be
 * found shows no weekly segment, never another log's reading. The same holds
 * for a relative GROK_HOME: it may be another account's home.
 */
export function billingLogPath() {
  if (process.env.CSB_BILLING_LOG !== undefined) return absoluteSetting("CSB_BILLING_LOG");
  if (process.env.GROK_HOME) {
    const home = absoluteSetting("GROK_HOME");
    return home ? join(home, "logs", "unified.jsonl") : null;
  }
  const home = join(homedir(), ".grok");
  return join(home, "logs", "unified.jsonl");
}

/**
 * Cache of the last weekly reading, one entry per log. Never holds a token or
 * the raw line. A relative CSB_USAGE_CACHE, XDG_CACHE_HOME or LOCALAPPDATA is
 * ignored.
 */
export function usageCachePath() {
  const set = absoluteSetting("CSB_USAGE_CACHE");
  if (set) return set;
  let base;
  if (process.platform === "win32") base = absoluteSetting("LOCALAPPDATA") || join(homedir(), "AppData", "Local");
  else base = absoluteSetting("XDG_CACHE_HOME") || join(homedir(), ".cache");
  return join(base, "cache-statusband-grok", "usage.json");
}

/**
 * undefined: not a credits line. null: a credits line that cannot be used.
 * Otherwise the reading.
 */
function billingRecord(line) {
  if (!line.includes(BILLING_MARKER)) return undefined;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!obj || obj.msg !== BILLING_MARKER) return undefined;
  const cfg = obj && obj.ctx && obj.ctx.config;
  if (!cfg || typeof cfg !== "object") return null;
  const period = cfg.currentPeriod && typeof cfg.currentPeriod === "object" ? cfg.currentPeriod : {};
  const percent = finite(cfg.creditUsagePercent);
  const periodType = text(period.type);
  // the billing period is its own thing: only the weekly period's end is the weekly reset
  const periodEnd = text(period.end);
  if (percent === null || !periodType || !periodEnd) return null;
  return {
    percent,
    periodType,
    periodEnd,
    fetchedAt: text(obj.ts),
  };
}

/**
 * Last credits reading in the file, scanning at most `maxBytes` from the end.
 * The newest credits line decides: if it cannot be used, there is no reading.
 */
export function readLastBilling(path, maxBytes = 4 * 1024 * 1024) {
  const found = scanBilling(path, maxBytes);
  return found === READ_FAILED ? null : found ?? null;
}

const READ_FAILED = Symbol("read failed");

/**
 * READ_FAILED: the log could not be read. undefined: no credits line in range.
 * null: the newest credits line cannot be used. Otherwise the reading.
 */
function scanBilling(path, maxBytes = 4 * 1024 * 1024) {
  // opening a named pipe would wait for a writer: check before opening as well as after
  try {
    if (!statSync(path).isFile()) return READ_FAILED;
  } catch {
    return READ_FAILED;
  }
  let fh;
  try {
    fh = openSync(path, "r");
  } catch {
    return READ_FAILED;
  }
  try {
    // the size and time are the opened file's, not a stat taken before it was opened
    const st = fstatSync(fh);
    if (!st.isFile()) return READ_FAILED;
    let offset = st.size;
    let pending = "";
    let readTotal = 0;
    const chunkSize = 256 * 1024;
    while (offset > 0 && readTotal < maxBytes) {
      const len = Math.min(chunkSize, offset, maxBytes - readTotal);
      offset -= len;
      const buf = Buffer.alloc(len);
      // a short read means the log shrank or was replaced while it was read
      if (readSync(fh, buf, 0, len, offset) !== len) return READ_FAILED;
      readTotal += len;
      const text = buf.toString("utf8") + pending;
      const lines = text.split("\n");
      pending = offset > 0 ? lines.shift() ?? "" : "";
      for (let i = lines.length - 1; i >= 0; i--) {
        const found = billingRecord(lines[i].replace(/\r$/, ""));
        if (found !== undefined) return found && { ...found, sourceMtimeMs: st.mtimeMs, sourceSize: st.size };
      }
    }
    if (offset === 0 && pending) {
      const found = billingRecord(pending.replace(/\r$/, ""));
      if (found !== undefined) return found && { ...found, sourceMtimeMs: st.mtimeMs, sourceSize: st.size };
    }
    return undefined;
  } catch {
    return READ_FAILED;
  } finally {
    try {
      closeSync(fh);
    } catch {
      // the handle is gone either way
    }
  }
}

function storedRecord(entry) {
  const record = entry && entry.record;
  if (!record || typeof record !== "object") return null;
  const percent = finite(record.percent);
  const periodType = text(record.periodType);
  const periodEnd = text(record.periodEnd);
  if (percent === null || !periodType || !periodEnd) return null;
  return { percent, periodType, periodEnd, fetchedAt: text(record.fetchedAt) };
}

/**
 * Per-log entries of the cache file, or null when the file exists but cannot
 * be read (locked, no permission). A missing file, unparseable text, or the old
 * single-entry format counts as empty.
 */
export function readSources(cachePath) {
  if (!cachePath) return {};
  let text;
  try {
    text = readFileSync(cachePath, "utf8");
  } catch (err) {
    return err && err.code === "ENOENT" ? {} : null;
  }
  try {
    const body = JSON.parse(text);
    const sources = body && body.v === 2 ? body.sources : null;
    return sources && typeof sources === "object" && !Array.isArray(sources) ? sources : {};
  } catch {
    return {};
  }
}

function writeSources(cachePath, sources) {
  if (!cachePath) return;
  // write then rename, so a reader never sees a half-written file
  const tmp = `${cachePath}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ v: 2, sources }));
    renameSync(tmp, cachePath);
  } catch {
    // This run can still show the reading it already has.
    try {
      unlinkSync(tmp);
    } catch {
      // nothing was left behind
    }
  }
}

/**
 * Last weekly reading. Re-reads each readable log at most once per five
 * minutes, even when it has no credits line, as long as the cache can be
 * read and written; otherwise every run re-reads it. A re-read that finds no credits line keeps the last good record
 * and only moves the next check. A re-read whose newest
 * credits line cannot be used drops it. A log that cannot be read keeps the
 * last good record and is tried again on the next run. A cache file that
 * exists but cannot be read is left as it is, and its entries are not used.
 * The cache holds one entry per log: the log's size and time, when it was read,
 * and the percent, period type, period end, and fetch time.
 */
export function loadWeekly(logPath, cachePath, nowMs = Date.now(), readCache = readSources) {
  // one cache file serves every log: a reading from another log (another GROK_HOME) is not this one's
  const read = readCache(cachePath);
  // a cache that cannot be read is not rewritten: that would drop every entry in it
  const canWrite = read !== null;
  const sources = read || {};
  const raw = logPath && Object.hasOwn(sources, logPath) ? sources[logPath] : null;
  const entry = raw && typeof raw === "object" ? raw : null;
  const prior = storedRecord(entry);
  // a scan time in the future (the clock went back) does not hold the throttle
  const age = entry && finite(entry.scannedAt) !== null ? nowMs - entry.scannedAt : null;
  if (age !== null && age >= 0 && age < RESCAN_MS) return prior;

  let st = null;
  if (logPath) {
    try {
      st = statSync(logPath);
    } catch {
      st = null;
    }
  }
  if (!st) return prior;
  if (entry && entry.sourceMtimeMs === st.mtimeMs && entry.sourceSize === st.size) return prior;

  // no credits line keeps the last reading; an unusable newest line shows none
  const found = scanBilling(logPath);
  // a failed read says nothing about the log: keep the reading and try again next run
  if (found === READ_FAILED) return prior;
  const record =
    found === undefined
      ? prior
      : found && { percent: found.percent, periodType: found.periodType, periodEnd: found.periodEnd, fetchedAt: found.fetchedAt };
  if (!canWrite) return record;
  writeSources(cachePath, {
    ...sources,
    [logPath]: {
      sourceMtimeMs: found ? found.sourceMtimeMs : st.mtimeMs,
      sourceSize: found ? found.sourceSize : st.size,
      scannedAt: nowMs,
      record,
    },
  });
  return record;
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  // a junction or symlink makes the typed path differ from the real one; on
  // Windows, where paths ignore case, a file URL also lowercases a UNC host
  const same = process.platform === "win32" ? (p) => p.toLowerCase() : (p) => p;
  try {
    return same(realpathSync(fileURLToPath(import.meta.url))) === same(realpathSync(entry));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  let input;
  try {
    input = readFileSync(0, "utf8");
  } catch (err) {
    process.stderr.write(`statusline: could not read stdin (${(err && err.code) || "error"})\n`);
    process.exit(1);
  }
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    process.stderr.write("statusline: stdin is not a JSON object\n");
    process.exit(1);
  }
  let weekly = null;
  try {
    const logPath = billingLogPath();
    weekly = logPath ? loadWeekly(logPath, usageCachePath()) : null;
  } catch {
    // the other segments do not depend on the log
  }
  const line = render(payload, { weekly, columns: Number(process.env.COLUMNS) || null });
  if (line) process.stdout.write(`${line}\n`);
}
