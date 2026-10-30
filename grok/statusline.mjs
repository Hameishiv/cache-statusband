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

import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const COLORS = {
  model: { fg: 255, bg: 24 },
  effort: { fg: 255, bg: 90 },
  context: { fg: 235, bg: 123 },
  cache: { fg: 235, bg: 114 },
  week: { fg: 255, bg: 63 },
  cost: { fg: 235, bg: 220 },
};

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

/** Remaining time until a reset, from a millisecond duration. */
export function countdown(ms) {
  const v = finite(ms);
  if (v === null || v <= 0) return null;
  const totalMin = Math.floor(v / 60000);
  if (totalMin < 1) return "<1m";
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

/**
 * Weekly percent and reset, or null.
 * `record` is `{ percent, periodType, periodEnd }`. A monthly period, a
 * missing percent, or a reset that has already passed is left out.
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
  const left = countdown(end - now);
  if (!left) return null;
  return `week ${percentText(pct)}% · ${left}`;
}

/** Uppercase the first letter of the first word. The rest of the label stays as written. */
export function capitalizeFirstWord(label) {
  return label.charAt(0).toUpperCase() + label.slice(1);
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
    .map(([kind, label]) => ({ kind, label: capitalizeFirstWord(label) }));
}

function paint(label, kind, nextKind) {
  const color = COLORS[kind];
  let out = `\x1b[38;5;${color.fg};48;5;${color.bg}m ${label} `;
  if (nextKind) {
    const next = COLORS[nextKind];
    out += `\x1b[38;5;${color.bg};48;5;${next.bg}m▶`;
  } else {
    out += `\x1b[38;5;${color.bg}m▶\x1b[0m`;
  }
  return out;
}

/** One status line, or "" when there is nothing we can show. */
export function render(payload, extras) {
  const parts = segments(payload, extras);
  if (parts.length === 0) return "";
  return parts.map((part, i) => paint(part.label, part.kind, parts[i + 1]?.kind)).join("");
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
  const base = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
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

/**
 * Last weekly reading. Re-reads the log at most once per five minutes.
 * The cache stores the percent, period type, period end, and fetch time.
 */
export function loadWeekly(logPath, cachePath, nowMs = Date.now()) {
  if (!logPath) return null;
  let st;
  try {
    st = statSync(logPath);
  } catch {
    return null;
  }
  let cached = null;
  if (cachePath) {
    try {
      cached = JSON.parse(readFileSync(cachePath, "utf8"));
    } catch {
      cached = null;
    }
  }
  const sameFile = cached && cached.sourceMtimeMs === st.mtimeMs && cached.sourceSize === st.size;
  const freshScan = cached && finite(cached.scannedAt) !== null && nowMs - cached.scannedAt < RESCAN_MS;
  if (sameFile || freshScan) {
    const record = storedRecord(cached);
    if (record) return record;
  }
  const found = readLastBilling(logPath);
  if (!found) return null;
  const record = {
    percent: found.percent,
    periodType: found.periodType,
    periodEnd: found.periodEnd,
    fetchedAt: found.fetchedAt,
  };
  if (cachePath) {
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(
        cachePath,
        JSON.stringify({
          sourceMtimeMs: found.sourceMtimeMs,
          sourceSize: found.sourceSize,
          scannedAt: nowMs,
          record,
        }),
      );
    } catch {
      // This run can still show the reading it just parsed.
    }
  }
  return record;
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
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
