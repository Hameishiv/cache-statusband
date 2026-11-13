// ONE Retry-After parser, used for the structured error data and for the error message.
//
// The rule is a strict grammar, not a search. In message text only what comes IMMEDIATELY after
// a "retry after" / "retry-after" / "retry at" key is read, and only as one of:
//   * a duration: one or more number+unit pairs (30s, 5 minutes, 1h30m, "1 hour 30 minutes");
//   * a moment: ISO 8601 (no zone = UTC) or an HTTP-date;
//   * a bare whole number followed by the end of the clause or punctuation (seconds).
// Anything else after the key (words, ids, a year, a clock time alone, a unit glued to more
// letters or digits) is UNPARSED. An unparsed key still means the server asked us to wait, so it
// answers with the longest wait we ever honour, MAX_RETRY_AFTER_MS: not knowing how long is a
// reason to err longer. No key at all answers null (the caller's own five-minute floor).
// The result is never negative or NaN; a moment already past is 0.

export const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

const MS = 1;
const SECOND = 1000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;

const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)`;
// Longest alternatives first; the lookahead stops a unit from being the start of a longer word
// ("3 more messages" is not 3 minutes). A digit may follow it (1h30m); the pair loop checks that.
const UNIT = String.raw`(ms|msecs?|milliseconds?|secs?|seconds?|mins?|minutes?|hrs?|hours?|days?|weeks?|wks?|s|m|h|d|w)(?![a-z])`;
// "5 minutes", "5 more minutes", "5 (minutes)".
const PAIR = new RegExp(String.raw`${NUMBER}\s*\(?\s*(?:more\s+)?${UNIT}\)?`, "iy");
const SEPARATOR = /\s*(?:,|and|&)?\s*/iy;
const BARE_INTEGER = /(\d{1,3}(?:,\d{3})+|\d+)(?=\s*(?:$|[;)\]"'}(]|[.,:!?]+(?:\s|$)))/iy;
const ISO = String.raw`\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s?(?:Z|UTC|GMT|[+-]\d{2}:?\d{2}))?)?`;
const MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
// RFC 9110: "Fri, 13 Nov 2026 12:30:00 GMT".
const HTTP_DATE = String.raw`(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+)?\d{1,2}\s+(?:${MONTHS})[a-z]*\s+\d{4}\s+\d{2}:\d{2}(?::\d{2})?(?:\s?(?:GMT|UTC|Z|[+-]\d{2}:?\d{2}))?`;
const MOMENT = new RegExp(String.raw`(?:${ISO}|${HTTP_DATE})(?![A-Za-z0-9])`, "iy");
// "retry after" / "retry-after" / "retry at", with an optional unit in the key name
// (retry_after_seconds, retry-after-ms, "retry after ms").
const KEY = /retry[\s_-]*(?:after|at)(?![a-z0-9])(?:(?:[_-]+|\s+(?=ms\b|milliseconds?\b))(ms|milliseconds?|secs?|seconds?|mins?|minutes?|hrs?|hours?|s|m|h)\b)?/gi;
// What may sit between the key and the value: spaces, ":" or "=", a spaced dash, "in", a quote or
// "(", and a small fixed list of filler. Each token consumes at least one character.
const PREFIX_TOKEN = /(?:\s+[-–—]\s+|\s+|[:="'(~]|(?:in|about|approximately|around|at\s+least)(?![a-z0-9]))/iy;
const PREFIX_LIMIT = 16;
// A moment or a duration is far shorter than this; the rest of a long message is never looked at.
const TAIL_CHARS = 160;
const STRING_CHARS = 200;
const MAX_DEPTH = 8;

export function unitMilliseconds(unit) {
  const name = String(unit).toLowerCase();
  if (name.startsWith("ms") || name.startsWith("milli")) return MS;
  if (name.startsWith("w")) return WEEK;
  if (name.startsWith("d")) return DAY;
  if (name.startsWith("h")) return HOUR;
  if (name.startsWith("m")) return MINUTE;
  return SECOND;
}

// A moment: ISO with a zone, ISO with none (UTC), or an HTTP-date. Milliseconds since the epoch, or NaN.
function momentTime(text) {
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(?:\s?(Z|UTC|GMT|[+-]\d{2}:?\d{2}))?)?$/i);
  if (iso) {
    const [, date, time, zone = ""] = iso;
    if (!time) return Date.parse(date);
    const offset = /^[+-]/.test(zone) ? (zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`) : "Z";
    return Date.parse(`${date}T${time}${offset}`);
  }
  // An HTTP-date with no zone is UTC, as the format always is.
  return Date.parse(/(?:GMT|UTC|Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text} GMT`);
}

function toNumber(text) {
  return Number(text.replaceAll(",", ""));
}

function matchAt(regex, text, at) {
  regex.lastIndex = at;
  return regex.exec(text);
}

// The wait stated by `text` read from its start, in milliseconds, or null when it is not one of
// the three forms. `defaultUnit` is what a bare number counts in (seconds, or the unit the key
// name gave). Text after a complete duration or moment is not read.
function waitFromTail(text, now, defaultUnit = SECOND) {
  let at = 0;
  for (let i = 0; i < PREFIX_LIMIT; i += 1) {
    const token = matchAt(PREFIX_TOKEN, text, at);
    if (!token) break;
    at += token[0].length;
  }
  const tail = text.slice(at, at + TAIL_CHARS);
  const moment = matchAt(MOMENT, tail, 0);
  if (moment) {
    const time = momentTime(moment[0]);
    return Number.isFinite(time) ? Math.max(0, time - now) : null;
  }
  // A duration: pairs in falling order are one compound wait, and the last one ends at a word
  // boundary (7d9f3, 41d4 and 8d1e are not durations).
  let total = 0;
  let scale = Infinity;
  let end = 0;
  for (;;) {
    let pairAt = end;
    if (end > 0) {
      const separator = matchAt(SEPARATOR, tail, end);
      pairAt = end + (separator ? separator[0].length : 0);
    }
    const pair = matchAt(PAIR, tail, pairAt);
    if (!pair) break;
    const pairScale = unitMilliseconds(pair[2]);
    if (pairScale >= scale) break;
    total += toNumber(pair[1]) * pairScale;
    scale = pairScale;
    end = pair.index + pair[0].length;
  }
  if (end > 0) return /^[A-Za-z0-9]/.test(tail.slice(end)) ? null : total;
  const bare = matchAt(BARE_INTEGER, tail, 0);
  return bare ? toNumber(bare[1]) * defaultUnit : null;
}

// Every wait stated in a message: one per retry key, the cap for a key whose value is unparsed.
function messageWaits(message, now) {
  const waits = [];
  for (const key of message.matchAll(KEY)) {
    const start = key.index + key[0].length;
    const wait = waitFromTail(message.slice(start, start + TAIL_CHARS + 64), now, key[1] ? unitMilliseconds(key[1]) : SECOND);
    waits.push(wait ?? MAX_RETRY_AFTER_MS);
  }
  return waits;
}

// retry_after, retryAfterSeconds, retry-after-ms, retry_at, retryAtMs ... (any case).
const STRUCTURED_KEY = /^retry[_-]?(after|at)(?:[_-]?(ms|milliseconds?|secs?|seconds?|mins?|minutes?|hrs?|hours?|s|m|h))?$/i;

// [] when the key is not a retry key or has no value; otherwise the wait it states.
function structuredWaits(key, value, now) {
  const match = key.match(STRUCTURED_KEY);
  if (!match) return [];
  const [, kind, unit] = match;
  const scale = unit ? unitMilliseconds(unit) : null;
  const absolute = kind.toLowerCase() === "at" && (scale === null || scale <= SECOND);
  const text = typeof value === "string" ? value.slice(0, STRING_CHARS) : null;
  const numeric = typeof value === "number" ? value
    : text !== null && /^\s*-?(?:\d+(?:\.\d+)?|\.\d+)\s*$/.test(text) ? Number(text)
    : null;
  if (numeric !== null) {
    if (Number.isNaN(numeric)) return [MAX_RETRY_AFTER_MS];
    if (!absolute) return [numeric * (scale ?? SECOND)];
    // retry_at: a moment as an epoch count, in the unit the key names, else seconds unless it
    // is too large to be anything but milliseconds.
    const epoch = scale !== null ? numeric * scale : numeric > 10_000_000_000 ? numeric : numeric * SECOND;
    return [epoch - now];
  }
  if (text === null || !text.trim()) return [];
  // A string: a moment, a duration or a bare number, by the same grammar as message text.
  return [waitFromTail(text, now, scale ?? SECOND) ?? MAX_RETRY_AFTER_MS];
}

// Never negative, never NaN; a count too big to hold is as long as a wait can be.
function clean(value) {
  return Number.isNaN(value) ? MAX_RETRY_AFTER_MS : Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, value));
}

export function retryAfterMilliseconds(error, now = Date.now()) {
  const data = error?.rpcData ?? error?.data ?? null;
  const candidates = [];
  const seen = new WeakSet();
  const walk = (value, depth) => {
    if (!value || typeof value !== "object" || depth > MAX_DEPTH || seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      for (const wait of structuredWaits(key, child, now)) candidates.push(wait);
      walk(child, depth + 1);
    }
  };
  walk(data, 0);
  const message = error?.rpcMessage ?? error?.message;
  if (typeof message === "string") for (const wait of messageWaits(message, now)) candidates.push(wait);
  let longest = null;
  for (const candidate of candidates) {
    const value = clean(candidate);
    if (longest === null || value > longest) longest = value;
  }
  return longest;
}
