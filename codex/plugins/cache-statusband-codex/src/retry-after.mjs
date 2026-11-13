// ONE Retry-After parser, used for the structured error data and for the error message.
//
// The rule is a strict grammar, not a search; nothing is scanned for a wait further on.
// A message has two kinds of key:
//   * HEADER form: only the spellings with no whitespace in them, "Retry-After", "retry-after",
//     "retry_after", "RetryAfter" or "retryAfter", with or without a unit suffix in the key name
//     (retry_after_seconds, retry-after-ms), followed by ":" or "=" (an optional closing quote
//     and spaces may come first).
//   * PROSE form: every other "retry after" or "retry at" (or the hyphen/underscore spellings,
//     any case) followed by a space, ":" or "=". "retry after:", "retry at:", "retryAt:" and
//     "retry at =" are prose: the ":" or "=" is just a prefix token.
// What is read is only what comes IMMEDIATELY after the key (spaces, ":", "=", a spaced dash, a
// quote, "(", "~" and the filler words in, about, approximately, around, at least are skipped), as one of:
//   * a duration: number+unit pairs (30s, 5 minutes, "1 hour 30 minutes"); pairs in falling order
//     are summed (1h30m); a number range sharing one unit ("5-10 minutes", "5 to 10 min", "5-10m")
//     is its larger number with the unit; and a list of durations joined by "or", "to", "and", "&",
//     "-", an en or em dash, a comma or spaces and tabs ("30 minutes or 2 hours", "30 minutes and
//     1 hour", "5m-3h", "1m 2h") is the LONGEST item. Neither a joiner nor a compound ever reaches
//     across a line break: the next line is not read;
//   * a moment: ISO 8601 (no zone = UTC), a zone after a space, or an HTTP-date; a date with no
//     time is the end of that day, UTC. A time with no zone that is followed by a space and a
//     letter or "(" ("12:30 EST", "12:30:00 America/New_York", "12:30 (UTC+2)") names a zone we
//     do not read, so it is unparsed, never UTC;
//   * a bare whole number (seconds, or the unit the key name gave), only when followed by the end
//     of the text, a newline, whitespace and then the end, or one of . , ; ) ] } (never before
//     ( ' " or a digit). If the text between the key and the number included a quote, that same
//     quote may directly follow the number ('Retry-After: "30"', {"retry_after":"120"}). After a
//     HEADER key the number may also be decimal (Retry-After: 30.5 is 30.5 seconds).
// A value that is not one of these is UNPARSED. After a PROSE key that means there is no key at
// all (so "retry after reconnecting", "retry at most 3 times" and "retry at any time" are
// nothing). After a HEADER key it means the server named a Retry-After it did not make readable,
// which answers with the longest wait we ever honour, MAX_RETRY_AFTER_MS. "null" or "none" after
// either key is no key. No key at all answers null (the caller's own five-minute floor).
// A parsed wait, structured or in text, always wins over a cap: the cap answers only when no
// value parsed at all. A retry key whose structured value is an object is read as {secs, nanos},
// {seconds} or {ms}; any other non-null object, array or boolean is the cap.
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
// Two numbers sharing one unit: "5-10 minutes", "5 to 10 min", "5–10m" (the larger, with the unit).
const RANGE = new RegExp(String.raw`${NUMBER}\s*(?:-|–|—|to(?![a-z0-9]))\s*${NUMBER}\s*\(?\s*(?:more\s+)?${UNIT}\)?`, "iy");
// Between the pairs of one compound duration: spaces and tabs only, never a line break.
const SEPARATOR = /[ \t]*(?:,|and(?![a-z0-9])|&)?[ \t]*/iy;
// A bare number is read in steps: its digits (whole after a prose key, whole or decimal after a
// header key), an optional closing quote, then what may follow: the end of the text, a newline,
// whitespace and then the end, or one of . , ; ) ] } (a "." or "," before a digit is a decimal or a
// list, not an end). Never before ( ' ".
const BARE_WHOLE = /(\d{1,3}(?:,\d{3})+|\d+)/y;
const BARE_DECIMAL = /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/y;
const BARE_END = /(?=[ \t]*(?:\r?\n|$)|[.,](?!\d)|[;)\]}])/y;
// Between two durations of a list: spaces and tabs (never a line break), a comma, a dash, or the
// words or, to, and, &.
const JOINER = /(?:[ \t]|,|-|–|—|&|(?:or|to|and)(?![a-z0-9]))+/iy;
// The header spellings of the key: no whitespace anywhere in it.
const HEADER_KEY = /^retry[_-]?after(?:[_-]+(?:ms|milliseconds?|secs?|seconds?|mins?|minutes?|hrs?|hours?|s|m|h))?$/i;
// What follows a time that has no zone when the next word is one we do not read: "12:30 EST", "12:30 (UTC+2)".
const ZONE_WORD = /^[ \t]+[A-Za-z(]/;
const NULLISH = /^(?:null|none)(?![a-z0-9])/i;
const WORD_END = /[A-Za-z0-9]/y;
const ISO = String.raw`\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s?(?:Z|UTC|GMT|[+-]\d{2}:?\d{2}))?)?`;
const MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
// RFC 9110: "Fri, 13 Nov 2026 12:30:00 GMT".
const HTTP_DATE = String.raw`(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+)?\d{1,2}\s+(?:${MONTHS})[a-z]*\s+\d{4}\s+\d{2}:\d{2}(?::\d{2})?(?:\s?(?:GMT|UTC|Z|[+-]\d{2}:?\d{2}))?`;
const MOMENT = new RegExp(String.raw`(?:${ISO}|${HTTP_DATE})(?![A-Za-z0-9])`, "iy");
// "retry after" / "retry-after" / "retry at", with an optional unit in the key name
// (retry_after_seconds, retry-after-ms, "retry after ms"). What follows decides header or prose.
const KEY = /retry[\s_-]*(?:after|at)(?![a-z0-9])(?:(?:[_-]+|\s+(?=ms\b|milliseconds?\b))(ms|milliseconds?|secs?|seconds?|mins?|minutes?|hrs?|hours?|s|m|h)\b)?/gi;
// What may sit between the key and the value: spaces, ":" or "=", a spaced dash, "in", a quote or
// "(", and a small fixed list of filler. Each token consumes at least one character.
const PREFIX_TOKEN = /(?:\s+[-–—]\s+|\s+|[:="'(~]|(?:in|about|approximately|around|at\s+least)(?![a-z0-9]))/iy;
const PREFIX_LIMIT = 16;
// After a header key: an optional closing quote, then ":" or "=".
const HEADER_SEPARATOR = /^["']?\s*[:=]/;
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
    // A date with no time is the end of that day (UTC).
    if (!time) return Date.parse(date) + DAY;
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

// One pair read at `at`: a number with a unit, or two numbers sharing one unit ("5-10 minutes":
// the larger). {number, unit, end}, or null.
function matchPair(tail, at) {
  const range = matchAt(RANGE, tail, at);
  if (range) return { number: Math.max(toNumber(range[1]), toNumber(range[2])), unit: range[3], end: range.index + range[0].length };
  const pair = matchAt(PAIR, tail, at);
  return pair ? { number: toNumber(pair[1]), unit: pair[2], end: pair.index + pair[0].length } : null;
}

// A compound duration read at `from`: pairs in falling order are one wait (1h30m, "1 hour and 30
// minutes"), and it must end at a word boundary (7d9f3, 41d4 and 8d1e are not durations).
// {total, end}, or null.
function readDuration(tail, from) {
  let total = 0;
  let scale = Infinity;
  let end = from;
  for (;;) {
    let pairAt = from;
    if (end > from) {
      const separator = matchAt(SEPARATOR, tail, end);
      pairAt = end + (separator ? separator[0].length : 0);
    }
    const pair = matchPair(tail, pairAt);
    if (!pair) break;
    const pairScale = unitMilliseconds(pair.unit);
    if (pairScale >= scale) break;
    total += pair.number * pairScale;
    scale = pairScale;
    end = pair.end;
  }
  if (end === from || matchAt(WORD_END, tail, end)) return null;
  return { total, end };
}

// A bare number at the start of `tail`, in `defaultUnit`: whole after a prose key, whole or decimal
// after a header key. When the text before it included a quote, that quote may close it. null when
// what follows is not one of the allowed ends.
function readBare(tail, defaultUnit, header, quote) {
  const digits = matchAt(header ? BARE_DECIMAL : BARE_WHOLE, tail, 0);
  if (!digits) return null;
  let end = digits[0].length;
  if (quote && tail[end] === quote) end += 1;
  return matchAt(BARE_END, tail, end) ? toNumber(digits[1]) * defaultUnit : null;
}

// The wait stated by `text` read from its start, in milliseconds; null when it is not one of the
// forms (unparsed); NO_VALUE for "null" / "none". `defaultUnit` is what a bare number counts in
// (seconds, or the unit the key name gave); `header` is true after a header key. Text after a
// complete duration or moment is not read.
const NO_VALUE = Symbol("no value");
function waitFromTail(text, now, defaultUnit = SECOND, header = false) {
  let at = 0;
  let quote = "";
  for (let i = 0; i < PREFIX_LIMIT; i += 1) {
    const token = matchAt(PREFIX_TOKEN, text, at);
    if (!token) break;
    if (token[0] === '"' || token[0] === "'") quote = token[0];
    at += token[0].length;
  }
  const tail = text.slice(at, at + TAIL_CHARS);
  if (NULLISH.test(tail)) return NO_VALUE;
  const moment = matchAt(MOMENT, tail, 0);
  if (moment) {
    // A time with no zone, then a space and a word or "(": a zone we do not read, never UTC.
    const zoneless = /:\d{2}(?:\.\d+)?$/.test(moment[0]) && !/(?:Z|UTC|GMT|[+-]\d{2}:?\d{2})$/i.test(moment[0]);
    if (zoneless && ZONE_WORD.test(tail.slice(moment[0].length))) return null;
    const time = momentTime(moment[0]);
    return Number.isFinite(time) ? Math.max(0, time - now) : null;
  }
  // A duration, or a list of durations: the longest.
  const first = readDuration(tail, 0);
  if (first) {
    let longest = first.total;
    let end = first.end;
    for (;;) {
      const joiner = matchAt(JOINER, tail, end);
      if (!joiner) break;
      const next = readDuration(tail, end + joiner[0].length);
      if (!next) break;
      longest = Math.max(longest, next.total);
      end = next.end;
    }
    return longest;
  }
  return readBare(tail, defaultUnit, header, quote);
}

// Record one stated value: a number is a parsed wait, null an unparsed one (the cap), NO_VALUE nothing.
function record(wait, found) {
  if (wait === NO_VALUE) return;
  if (wait === null) found.caps += 1;
  else found.waits.push(wait);
}

// Every wait stated in a message: one per retry key; an unparsed HEADER key counts as a cap,
// an unparsed PROSE key as nothing.
function messageWaits(message, now, found) {
  for (const key of message.matchAll(KEY)) {
    const start = key.index + key[0].length;
    const rest = message.slice(start, start + TAIL_CHARS + 64);
    const unit = key[1] ? unitMilliseconds(key[1]) : SECOND;
    const header = HEADER_KEY.test(key[0]) ? HEADER_SEPARATOR.exec(rest) : null;
    if (header) {
      record(waitFromTail(rest.slice(header[0].length), now, unit, true), found);
    } else if (/^[\s:=]/.test(rest)) {
      const wait = waitFromTail(rest, now, unit);
      if (typeof wait === "number") found.waits.push(wait);
    }
  }
}

// retry_after, retryAfterSeconds, retry-after-ms, retry_at, retryAtMs ... (any case).
const STRUCTURED_KEY = /^retry[_-]?(after|at)(?:[_-]?(ms|milliseconds?|secs?|seconds?|mins?|minutes?|hrs?|hours?|s|m|h))?$/i;

// {secs, nanos}, {seconds} or {ms} read as a wait in milliseconds; null for any other shape.
function objectWait(value) {
  if (Array.isArray(value)) return null;
  const count = (field) => (typeof field === "number" && Number.isFinite(field) ? field : null);
  const secs = count(value.secs) ?? count(value.seconds);
  if (secs !== null) return secs * SECOND + (count(value.nanos) ?? 0) / 1e6;
  return count(value.ms) ?? count(value.milliseconds);
}

// Records what a structured key states, if it is a retry key. null or undefined states nothing.
function structuredWaits(key, value, now, found) {
  const match = key.match(STRUCTURED_KEY);
  if (!match || value === null || value === undefined) return;
  const [, kind, unit] = match;
  const scale = unit ? unitMilliseconds(unit) : null;
  const absolute = kind.toLowerCase() === "at" && (scale === null || scale <= SECOND);
  if (typeof value === "object") {
    record(absolute ? null : objectWait(value), found);
    return;
  }
  if (typeof value === "boolean") { found.caps += 1; return; }
  const text = typeof value === "string" ? value.slice(0, STRING_CHARS) : null;
  const numeric = typeof value === "number" ? value
    : text !== null && /^\s*-?(?:\d+(?:\.\d+)?|\.\d+)\s*$/.test(text) ? Number(text)
    : null;
  if (numeric !== null) {
    if (Number.isNaN(numeric)) { found.caps += 1; return; }
    if (!absolute) { found.waits.push(numeric * (scale ?? SECOND)); return; }
    // retry_at: a moment as an epoch count, in the unit the key names, else seconds unless it
    // is too large to be anything but milliseconds.
    const epoch = scale !== null ? numeric * scale : numeric > 10_000_000_000 ? numeric : numeric * SECOND;
    found.waits.push(epoch - now);
    return;
  }
  if (text === null || !text.trim()) return;
  // A string: a moment, a duration or a bare number, by the same grammar as message text.
  record(waitFromTail(text, now, scale ?? SECOND, true), found);
}

// Never negative, never NaN; a count too big to hold is as long as a wait can be.
function clean(value) {
  return Number.isNaN(value) ? MAX_RETRY_AFTER_MS : Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, value));
}

export function retryAfterMilliseconds(error, now = Date.now()) {
  const data = error?.rpcData ?? error?.data ?? null;
  const found = { waits: [], caps: 0 };
  const seen = new WeakSet();
  const walk = (value, depth) => {
    if (!value || typeof value !== "object" || depth > MAX_DEPTH || seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      structuredWaits(key, child, now, found);
      walk(child, depth + 1);
    }
  };
  walk(data, 0);
  const message = error?.rpcMessage ?? error?.message;
  if (typeof message === "string") messageWaits(message, now, found);
  // A parsed wait always wins; the cap answers only when nothing parsed at all.
  if (found.waits.length > 0) return found.waits.reduce((longest, wait) => Math.max(longest, clean(wait)), 0);
  return found.caps > 0 ? MAX_RETRY_AFTER_MS : null;
}
