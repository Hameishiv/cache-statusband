// ONE Retry-After parser, used for the structured error data and for the error message.
//
// The rule: when the input is ambiguous, err longer. The result is the LONGEST wait the input
// states, in milliseconds (never negative, never NaN), or null when it states none. Backing off
// too long costs a few minutes of a stale reading; backing off too short spends the account's
// quota. The caller applies its own five-minute floor and one-hour cap.

const MS = 1;
const SECOND = 1000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;

// Longest alternatives first; the lookahead stops a unit from being the start of a longer word
// ("3 more messages" is not 3 minutes).
const UNIT = String.raw`(ms|milliseconds?|secs?|seconds?|mins?|minutes?|hrs?|hours?|days?|weeks?|s|m|h|d|w)(?![a-z])`;
const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)`;
// "5 minutes", "5 more minutes", "5 (minutes)". A number may follow a unit letter (1h30m) but not
// other letters (v5, gpt5).
const NUMBER_UNIT = new RegExp(String.raw`(?<![\d_.,]|[a-ce-gi-lnp-rt-vx-z])${NUMBER}(?:\s*\(?\s*(?:(?:more|additional|extra|further)\s+)?${UNIT}\)?|-(?:ms|milliseconds?|secs?|seconds?|mins?|minutes?|hrs?|hours?|days?|weeks?)(?![a-z]))?`, "gi");
// What a number is the length of when it is followed by one of these.
const NAMES_A_LIMIT = /^\s*(?:window|limit|quota|cap)/i;
const ISO = String.raw`\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s?(?:Z|UTC|GMT|[+-]\d{2}:?\d{2}))?)?`;
const MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
// RFC 9110: "Fri, 13 Nov 2026 12:30:00 GMT".
const HTTP_DATE = String.raw`(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+)?\d{1,2}\s+(?:${MONTHS})[a-z]*\s+\d{4}\s+\d{2}:\d{2}(?::\d{2})?(?:\s?(?:GMT|UTC|Z|[+-]\d{2}:?\d{2}))?`;
const MOMENT = new RegExp(`${ISO}|${HTTP_DATE}`, "gi");
// "retry after" / "retry-after" / "retry at", with an optional unit in the key name
// (retry_after_seconds, retry-after-ms, "retry after ms").
const KEY = /retry[\s_-]*(?:after|at)(?![a-z])(?:(?:[_-]+|\s+(?=ms\b|milliseconds?\b))(ms|milliseconds?|secs?|seconds?|mins?|minutes?|hrs?|hours?|s|m|h)\b)?/gi;
// How far past a key its clause runs, unless a sentence ends first.
const CLAUSE_CHARS = 80;
const SENTENCE_END = /[.!?]+(?=\s+[A-Z]|\s*$)/;

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

// Never negative, never NaN; a count too big to hold is as long as a wait can be.
function clean(value) {
  if (Number.isNaN(value)) return null;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, value));
}

// Every wait stated in a piece of text. `defaultUnit` is what a bare number counts in (seconds,
// or the unit the key name gave); a bare number counts only when no number with a unit does.
function waitsInText(text, now, defaultUnit = SECOND, defaultUnitStated = false) {
  const waits = [];
  // Moments first, then blanked out so their digits are not read again as counts.
  let rest = text.replace(MOMENT, (found) => {
    const at = momentTime(found);
    if (Number.isFinite(at)) waits.push(Math.max(0, at - now));
    return " ".repeat(found.length);
  });
  const timed = [];
  const bare = [];
  for (const found of rest.matchAll(NUMBER_UNIT)) {
    const [whole, digits, unit] = found;
    const end = found.index + whole.length;
    const following = rest.slice(end);
    if (NAMES_A_LIMIT.test(following)) continue;
    // "5-hour window": the window's length, never the wait.
    if (!unit && /^-/.test(whole.slice(digits.length))) continue;
    // A clock time ("12:30") is not a count.
    if (!unit && (/^:\d/.test(following) || /\d:$/.test(rest.slice(Math.max(0, found.index - 2), found.index)))) continue;
    const value = toNumber(digits);
    if (unit) timed.push({ at: found.index, end, value: value * unitMilliseconds(unit), scale: unitMilliseconds(unit) });
    else bare.push(value * defaultUnit);
  }
  // Adjacent pairs in falling order are one compound wait: 1h30m, "1 hour 30 minutes", "2 min 30 s".
  let group = null;
  const groups = [];
  for (const token of timed) {
    if (group && token.scale < group.scale && /^\s*(?:,|and|&)?\s*$/i.test(rest.slice(group.end, token.at))) {
      group = { end: token.end, scale: token.scale, value: group.value + token.value };
    } else {
      if (group) groups.push(group.value);
      group = { end: token.end, scale: token.scale, value: token.value };
    }
  }
  if (group) groups.push(group.value);
  waits.push(...groups);
  if (defaultUnitStated || groups.length === 0) waits.push(...bare);
  return waits;
}

function messageWaits(message, now) {
  const waits = [];
  for (const key of message.matchAll(KEY)) {
    const start = key.index + key[0].length;
    let clause = message.slice(start, start + CLAUSE_CHARS);
    const end = clause.search(SENTENCE_END);
    if (end >= 0) clause = clause.slice(0, end);
    waits.push(...waitsInText(clause, now, key[1] ? unitMilliseconds(key[1]) : SECOND, Boolean(key[1])));
  }
  return waits;
}

// retry_after, retryAfterSeconds, retry-after-ms, retry_at, retryAtMs ... (any case).
const STRUCTURED_KEY = /^retry[_-]?(after|at)(?:[_-]?(ms|milliseconds?|secs?|seconds?|mins?|minutes?|hrs?|hours?|s|m|h))?$/i;

function structuredWaits(key, value, now) {
  const match = key.match(STRUCTURED_KEY);
  if (!match) return [];
  const [, kind, unit] = match;
  const scale = unit ? unitMilliseconds(unit) : null;
  const absolute = kind.toLowerCase() === "at" && (scale === null || scale <= SECOND);
  const numeric = typeof value === "number" ? value
    : typeof value === "string" && /^\s*-?(?:\d+(?:\.\d+)?|\.\d+)\s*$/.test(value) ? Number(value)
    : null;
  if (numeric !== null) {
    if (!absolute) return [numeric * (scale ?? SECOND)];
    // retry_at: a moment as an epoch count, in the unit the key names, else seconds unless it
    // is too large to be anything but milliseconds.
    const epoch = scale !== null ? numeric * scale : numeric > 10_000_000_000 ? numeric : numeric * SECOND;
    return [epoch - now];
  }
  if (typeof value !== "string" || !value.trim()) return [];
  // A string: a moment, or a count with a unit ("5 minutes", "1h30m").
  return waitsInText(value, now, scale ?? SECOND, scale !== null);
}

export function retryAfterMilliseconds(error, now = Date.now()) {
  const data = error?.rpcData ?? error?.data ?? null;
  const candidates = [];
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      candidates.push(...structuredWaits(key, child, now));
      if (child && typeof child === "object") walk(child);
    }
  };
  walk(data);
  const message = error?.rpcMessage ?? error?.message;
  if (typeof message === "string") candidates.push(...messageWaits(message, now));
  const waits = candidates.map(clean).filter((value) => value !== null);
  return waits.length ? Math.max(...waits) : null;
}
