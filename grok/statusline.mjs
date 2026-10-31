/**
 * Grok Build status-line command for the portable part of cache-statusband.
 *
 * Grok writes one JSON object to stdin. This prints at most one coloured line.
 * A missing field is left out. Nothing here is invented.
 *
 * Weekly usage is not in that JSON. /usage reads it from the credits config
 * Grok logs as "billing: fetched credits config". This script reads the last
 * of those lines and shows the percent and reset only when the period is
 * weekly, still open, and fetched within the last day. It does not use the network and does not read a token.
 */

import { closeSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
const WEEKLY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
  if (pct !== null) label += ` ${pct}%`;
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
  if (read !== null) parts.push(`cache read ${formatTokens(read)}`);
  if (write !== null) parts.push(`write ${formatTokens(write)}`);
  return parts.length ? parts.join(" · ") : null;
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
 * Time left, matching the Claude Code band.
 * Under an hour: "40m". Under a day: "23h05m". Past a day: "7d9h".
 * A non-positive duration returns null.
 */
export function remaining(ms) {
  const v = finite(ms);
  if (v === null || v <= 0) return null;
  const hours = Math.floor(v / 3600000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d${hours % 24}h`;
  const mins = Math.round(v / 60000);
  if (mins <= 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m`;
}

/**
 * Weekly percent and reset, or null.
 * `record` is `{ percent, periodType, periodEnd }`. A monthly period, a
 * missing percent, a reset that has already passed, or a reading fetched
 * more than a day ago is left out.
 */
export function weeklyLabel(record, nowMs) {
  if (!record || typeof record !== "object") return null;
  const type = text(record.periodType);
  if (!type || !type.includes("WEEKLY")) return null;
  const pct = finite(record.percent);
  if (pct === null || pct < 0) return null;
  const end = Date.parse(record.periodEnd);
  const now = finite(nowMs);
  if (!Number.isFinite(end) || now === null || end <= now) return null;
  const fetched = Date.parse(record.fetchedAt);
  if (Number.isFinite(fetched) && now - fetched > WEEKLY_MAX_AGE_MS) return null;
  const left = remaining(end - now);
  if (!left) return null;
  return `week ${percentText(pct)}% · ${left}`;
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

/** One status line, or "" when there is nothing we can show. */
export function render(payload, extras) {
  const parts = segments(payload, extras);
  if (parts.length === 0) return "";
  return parts.map((part, i) => paint(part.label, part.kind, i, parts[i + 1]?.kind)).join("");
}

/** Grok's billing log, or null when CSB_BILLING_LOG is set to an empty string. */
export function billingLogPath() {
  if (process.env.CSB_BILLING_LOG === "") return null;
  if (process.env.CSB_BILLING_LOG) return process.env.CSB_BILLING_LOG;
  const home = process.env.GROK_HOME || join(homedir(), ".grok");
  return join(home, "logs", "unified.jsonl");
}

/** Shared cache of the last weekly reading. Never holds a token or the raw line. */
export function usageCachePath() {
  if (process.env.CSB_USAGE_CACHE) return process.env.CSB_USAGE_CACHE;
  const base = process.platform === "win32"
    ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
    : process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "cache-statusband-grok", "usage.json");
}

function billingRecord(line) {
  if (!line.includes(BILLING_MARKER)) return null;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const cfg = obj && obj.ctx && obj.ctx.config;
  if (!cfg || typeof cfg !== "object") return null;
  const period = cfg.currentPeriod && typeof cfg.currentPeriod === "object" ? cfg.currentPeriod : {};
  const percent = finite(cfg.creditUsagePercent);
  const periodType = text(period.type);
  const periodEnd = text(period.end) || text(cfg.billingPeriodEnd);
  if (percent === null || !periodType || !periodEnd) return null;
  return {
    percent,
    periodType,
    periodEnd,
    fetchedAt: text(obj.ts),
  };
}

/** Last credits reading in the file, scanning at most `maxBytes` from the end. */
export function readLastBilling(path, maxBytes = 4 * 1024 * 1024) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  let fh;
  try {
    fh = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    let offset = st.size;
    let pending = "";
    let readTotal = 0;
    const chunkSize = 256 * 1024;
    while (offset > 0 && readTotal < maxBytes) {
      const len = Math.min(chunkSize, offset, maxBytes - readTotal);
      offset -= len;
      const buf = Buffer.alloc(len);
      readSync(fh, buf, 0, len, offset);
      readTotal += len;
      const text = buf.toString("utf8") + pending;
      const lines = text.split("\n");
      pending = offset > 0 ? lines.shift() ?? "" : "";
      for (let i = lines.length - 1; i >= 0; i--) {
        const found = billingRecord(lines[i].replace(/\r$/, ""));
        if (found) return { ...found, sourceMtimeMs: st.mtimeMs, sourceSize: st.size };
      }
    }
    if (offset === 0 && pending) {
      const found = billingRecord(pending.replace(/\r$/, ""));
      if (found) return { ...found, sourceMtimeMs: st.mtimeMs, sourceSize: st.size };
    }
    return null;
  } finally {
    closeSync(fh);
  }
}

function storedRecord(cached) {
  const record = cached && cached.record;
  if (!record || typeof record !== "object") return null;
  const percent = finite(record.percent);
  const periodType = text(record.periodType);
  const periodEnd = text(record.periodEnd);
  if (percent === null || !periodType || !periodEnd) return null;
  return { percent, periodType, periodEnd, fetchedAt: text(record.fetchedAt) };
}

const MAX_CACHED_LOGS = 8;

// The cache file holds { logs: { [logPath]: entry } }. A file from an earlier version (one bare record) has no `logs`: a miss.
function readCache(cachePath) {
  if (!cachePath) return {};
  try {
    const logs = JSON.parse(readFileSync(cachePath, "utf8")).logs;
    if (!logs || typeof logs !== "object" || Array.isArray(logs)) return {};
    return logs;
  } catch {
    return {};
  }
}

function cachedEntry(logs, logPath) {
  if (!logPath || !Object.hasOwn(logs, logPath)) return null;
  const entry = logs[logPath];
  return entry && typeof entry === "object" ? entry : null;
}

function writeCache(cachePath, logPath, entry) {
  if (!cachePath || !logPath) return;
  try {
    // Merge into what is stored now, so another home's entry stays; the eight newest scans are kept.
    const logs = readCache(cachePath);
    const kept = Object.entries(logs).filter(([key, value]) => key !== logPath && value && typeof value === "object");
    kept.sort((a, b) => (finite(b[1].scannedAt) ?? 0) - (finite(a[1].scannedAt) ?? 0));
    const next = Object.fromEntries([...kept.slice(0, MAX_CACHED_LOGS - 1), [logPath, entry]]);
    mkdirSync(dirname(cachePath), { recursive: true });
    // A temporary file beside it, then a rename: a reader never sees half a file (two writers can still each lose the other's entry)
    const temporary = `${cachePath}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ logs: next }));
      renameSync(temporary, cachePath);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // nothing was left to remove
      }
      throw error;
    }
  } catch {
    // This run can still show the reading it already has.
  }
}

/**
 * Last weekly reading. Re-reads each log at most once per five minutes: the wait is kept per log, so two Grok homes
 * (GROK_HOME or CSB_BILLING_LOG) that share one cache file each keep their own, and neither forces the other to rescan.
 * A failed re-read keeps the last good record and only moves the next check.
 * The cache stores, per log, the percent, period type, period end, and fetch time, with when the log was last scanned.
 * It keeps the eight most recently scanned logs. A cache file in the earlier single-record shape is a miss.
 */
export function loadWeekly(logPath, cachePath, nowMs = Date.now()) {
  const cached = cachedEntry(readCache(cachePath), logPath);
  const prior = storedRecord(cached);
  const freshScan = cached && finite(cached.scannedAt) !== null && nowMs - cached.scannedAt < RESCAN_MS;
  if (freshScan) return prior;

  let st = null;
  if (logPath) {
    try {
      st = statSync(logPath);
    } catch {
      st = null;
    }
  }
  const sameFile = st && cached && cached.sourceMtimeMs === st.mtimeMs && cached.sourceSize === st.size;
  if (sameFile) return prior;

  const found = st ? readLastBilling(logPath) : null;
  if (!found) {
    // A miss is cached too, so a log with no billing line is not rescanned on every run.
    writeCache(cachePath, logPath, {
      sourceMtimeMs: prior ? cached.sourceMtimeMs : st ? st.mtimeMs : null,
      sourceSize: prior ? cached.sourceSize : st ? st.size : null,
      scannedAt: nowMs,
      record: prior,
    });
    return prior;
  }
  const record = {
    percent: found.percent,
    periodType: found.periodType,
    periodEnd: found.periodEnd,
    fetchedAt: found.fetchedAt,
  };
  writeCache(cachePath, logPath, {
    sourceMtimeMs: found.sourceMtimeMs,
    sourceSize: found.sourceSize,
    scannedAt: nowMs,
    record,
  });
  return record;
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  // Compare real paths so a symlinked entry still counts as a direct run.
  try {
    return fileURLToPath(import.meta.url) === realpathSync(entry);
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (isDirectRun()) {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.stderr.write("statusline: stdin is not a JSON object\n");
    process.exit(1);
  }
  const logPath = billingLogPath();
  const weekly = logPath ? loadWeekly(logPath, usageCachePath()) : null;
  const line = render(payload, { weekly });
  if (line) process.stdout.write(`${line}\n`);
}
