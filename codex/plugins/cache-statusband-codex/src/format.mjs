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
    lines.push(`Banked resets: ${snapshot.availableCount}${expiry}`);
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
            lines.push(`  ${title} — expiration not supplied`);
            return;
          }
          const absolute = formatLocalDate(expiresAt, { locale, timeZone });
          const relative = expiresAt >= now
            ? `in ${formatDuration(expiresAt - now)}`
            : `${formatDuration(now - expiresAt)} ago`;
          lines.push(`  ${title} — expires ${absolute} (${relative})`);
        });
        if (credits.length < snapshot.availableCount) {
          lines.push(`  ${snapshot.availableCount - credits.length} additional reset expiration${snapshot.availableCount - credits.length === 1 ? " was" : "s were"} not supplied by Codex.`);
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
  if (identity) lines.push(identity);
  return lines.map(capFirst);
}

// Match the original mod: capitalize the first word past leading symbols/spacing.
// Email addresses and digit-led labels such as "5h" stay unchanged.
export function capFirst(text) {
  const value = String(text ?? "");
  if (/^\s*\S+@\S+\s*$/.test(value)) return value;
  return value.replace(/^([^\p{L}\p{N}]*)(\p{Ll})/u, (_, lead, letter) => lead + letter.toUpperCase());
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
  return new Intl.DateTimeFormat(locale, options).format(new Date(value));
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
