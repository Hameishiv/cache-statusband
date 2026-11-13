import { stripControls } from "./sanitize.mjs";
import { MIN_POLL_INTERVAL_MS } from "./usage.mjs";

export function formatTokens(value) {
  if (!Number.isFinite(value)) return "?";
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${trim(value / 1_000_000)}m`;
  if (absolute >= 1_000) return `${trim(value / 1_000)}k`;
  return String(Math.round(value));
}

export function formatPercent(used, total) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return "?";
  return `${Math.round((used / total) * 100)}%`;
}

export function formatAge(value, now = Date.now()) {
  const then = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(then)) return "unknown";
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  return compactMinutes(minutes);
}

export function formatUsageLines(snapshot, now = Date.now(), {
  includeResetDetails = false,
  identity = null,
  locale,
  timeZone,
} = {}) {
  const lines = [];
  if (Number.isFinite(snapshot?.availableCount)) {
    const expiries = (snapshot.credits ?? [])
      .map((credit) => epochMilliseconds(credit.expiresAt))
      .filter((value) => Number.isFinite(value) && value > now)
      .sort((a, b) => a - b);
    const expiry = expiries.length ? `; next expires in ${formatDuration(expiries[0] - now)}` : "";
    lines.push(`Banked resets: ${snapshot.availableCount}${expiry}${checkedSuffix(snapshot, now)}`);
    if (includeResetDetails && snapshot.availableCount > 0) {
      const credits = Array.isArray(snapshot.credits) ? [...snapshot.credits] : [];
      credits.sort((a, b) => (epochMilliseconds(a.expiresAt) ?? Number.POSITIVE_INFINITY) - (epochMilliseconds(b.expiresAt) ?? Number.POSITIVE_INFINITY));
      if (!credits.length) {
        lines.push("  Expiration details were not supplied by Codex.");
      } else {
        credits.forEach((credit, index) => {
          const title = credit.title || `Reset ${index + 1}`;
          const expiresAt = epochMilliseconds(credit.expiresAt);
          if (!Number.isFinite(expiresAt)) {
            // Codex sending an explicit null means the reset never expires; a missing or
            // malformed value means Codex did not say.
            lines.push(`  ${title} — ${credit.neverExpires === true ? "does not expire" : "expiration not supplied"}`);
            return;
          }
          const absolute = formatLocalDate(expiresAt, { locale, timeZone });
          const relative = expiresAt >= now
            ? `in ${formatDuration(expiresAt - now)}`
            : `${formatDuration(now - expiresAt)} ago`;
          lines.push(`  ${title} — expires ${absolute} (${relative})`);
        });
        // Rows this plugin cut off are "not shown"; only the remainder is "not supplied".
        // The count says how many rows should exist beyond those listed: rows cut beyond that
        // are ones Codex sent over its own count, which is a different statement again.
        const omitted = Number.isFinite(snapshot.creditsOmitted) ? Math.max(0, snapshot.creditsOmitted) : 0;
        const expected = Math.max(0, snapshot.availableCount - credits.length);
        const notShown = Math.min(omitted, expected);
        const beyondCount = omitted - notShown;
        const missing = expected - notShown;
        if (notShown > 0) {
          lines.push(`  ${notShown} more reset expiration${notShown === 1 ? "" : "s"} not shown.`);
        }
        if (missing > 0) {
          lines.push(`  ${missing} additional reset expiration${missing === 1 ? " was" : "s were"} not supplied by Codex.`);
        }
        if (beyondCount > 0) {
          lines.push(`  ${beyondCount} more row${beyondCount === 1 ? "" : "s"} beyond Codex's count of ${snapshot.availableCount} not shown.`);
        }
      }
    }
  } else {
    lines.push("Banked resets: unavailable");
  }
  for (const window of [snapshot?.primary, snapshot?.secondary]) {
    if (!Number.isFinite(window?.usedPercent)) continue;
    const label = formatWindowDuration(window.windowDurationMins);
    const resetAt = epochMilliseconds(window.resetsAt);
    const reset = Number.isFinite(resetAt) ? ` · ${formatDuration(Math.max(0, resetAt - now))}` : "";
    lines.push(`${label} ${Math.round(window.usedPercent)}%${reset}`);
  }
  if (Number.isFinite(snapshot?.fetchedAt)) lines.push(`Checked ${formatAge(snapshot.fetchedAt, now)} ago (${snapshot.source})`);
  const unwritable = cacheUnwritableLine(snapshot);
  if (unwritable) lines.push(unwritable);
  if (identity) lines.push(identity);
  return lines.map(capFirst);
}

// Said when the usage cache cannot be written: no live read is made then (the five-minute
// limit could not hold), so the reader must be told why nothing newer is shown. The path is
// ours but still passes through the control-character filter before it is printed.
export function cacheUnwritableLine(snapshot) {
  if (snapshot?.cacheUnwritable !== true) return null;
  const directory = typeof snapshot.cacheDir === "string" ? stripControls(snapshot.cacheDir).slice(0, 500) : "";
  return `Usage not read: cannot write ${directory || "the cache directory"}`;
}

// Match the original mod: capitalize the first word past leading symbols/spacing.
// Email addresses and digit-led labels such as "5h" stay unchanged.
export function capFirst(text) {
  const value = String(text ?? "");
  if (/^\s*\S+@\S+\s*$/.test(value)) return value;
  return value.replace(/^([^\p{L}\p{N}]*)(\p{Ll})/u, (_, lead, letter) => lead + letter.toUpperCase());
}

// A count that was not just read says how old it is, so it is not mistaken for live.
function checkedSuffix(snapshot, now) {
  if (!Number.isFinite(snapshot?.fetchedAt)) {
    return snapshot?.source === "live" || snapshot?.source === "cache" ? "" : " (check time unknown)";
  }
  const stale = !["live", "cache"].includes(snapshot.source) || now - snapshot.fetchedAt > 2 * MIN_POLL_INTERVAL_MS;
  return stale ? ` (checked ${formatAge(snapshot.fetchedAt, now)} ago)` : "";
}

export function formatLocalDate(value, { locale, timeZone } = {}) {
  const options = {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  };
  if (timeZone) options.timeZone = timeZone;
  // Newer ICU builds put a narrow no-break space before AM/PM; keep output plain.
  return new Intl.DateTimeFormat(locale, options).format(new Date(value)).replace(/[\u202f\u00a0]/g, " ");
}

export function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "unknown";
  const minutes = Math.max(0, Math.ceil(milliseconds / 60_000));
  return compactMinutes(minutes);
}

function formatWindowDuration(minutes) {
  if (!Number.isFinite(minutes)) return "Limit";
  if (minutes === 10_080) return "Week";
  if (minutes % 10_080 === 0) return `${minutes / 10_080}w`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function compactMinutes(minutes) {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

function epochMilliseconds(value) {
  if (!Number.isFinite(value)) return null;
  return value < 10_000_000_000 ? value * 1000 : value;
}

function trim(value) {
  return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2).replace(/\.0+$/, "");
}
