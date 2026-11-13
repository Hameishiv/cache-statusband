import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { hasControl, stripControls } from "./sanitize.mjs";

export async function configuredSeatIdentity(codexHome, env = process.env) {
  let configured = env.CACHE_STATUSBAND_CODEX_SEAT_FILE;
  if (!configured) {
    try {
      configured = await configuredSeatFile(codexHome);
    } catch {
      return { key: "seat:unavailable", label: null, unavailable: true };
    }
  }
  if (!configured) return null;
  const seat = await readSeatLabel(expandPath(configured, codexHome, env));
  return seat
    ? { key: `seat:${seat}`, label: `Seat ${seat}`, unavailable: false }
    : { key: "seat:unavailable", label: null, unavailable: true };
}

export async function usagePresentation(snapshot, {
  codexHome,
  env = process.env,
  identity: suppliedIdentity,
} = {}) {
  const seat = codexHome ? await configuredSeatIdentity(codexHome, env) : null;
  const identity = suppliedIdentity === undefined ? seat : suppliedIdentity;
  // A supplied identity may be a RECORDED one (a resumed session's), made when no seat was
  // configured, so its label can be the account email. With a seat configured NOW (available
  // or not) the email is never shown: only a recorded seat label is. The reading itself
  // belongs to the recorded account, so it stays; the email and key do not.
  if (seat && suppliedIdentity !== undefined && !identity?.unavailable && !isSeatLabel(identity)) {
    const { accountEmail, identityKey, ...rest } = snapshot ?? {};
    return { snapshot: rest, identity: null };
  }
  if (!identity) return { snapshot, identity: sanitizeEmail(snapshot?.accountEmail) };
  // A snapshot with a null or missing identityKey now comes only from an "identity-unavailable"
  // result (no verified account, so no reading was looked up); every other empty result names
  // its account. It names no other account either, so it is not "a different account's".
  if (!identity.unavailable && snapshot && (snapshot.identityKey === null || snapshot.identityKey === undefined || snapshot.identityKey === identity.key)) return { snapshot, identity: identity.label };
  return {
    identity: identity.label,
    snapshot: {
      ...snapshot,
      accountEmail: null,
      availableCount: null,
      credits: null,
      creditsOmitted: null,
      creditsNotAvailable: null,
      primary: null,
      secondary: null,
      source: "identity-changed",
    },
  };
}

// A seat label is "Seat <label>"; an account email never starts with that prefix.
function isSeatLabel(identity) {
  return typeof identity?.label === "string" && identity.label.startsWith("Seat ");
}

// Resolves to the configured seat label file, or null when none is configured (no
// settings.json at all, or one without a seatFile). Anything else that stops the setting
// being read, or a seatFile that is not a non-empty string, throws: a seat that may have been
// configured but cannot be read must never fall back to showing the account email.
// The installer replaces settings.json while sessions may be starting, and an editor may save
// it in two steps, so a failed read or parse is tried again (up to SETTINGS_RETRIES more
// times, SETTINGS_RETRY_MS apart) before it counts as a failure. A missing file is also tried
// again, but only twice (about 100 ms in all), and only when a replacement may be under way:
// the installer writes a `.settings.json.<something>.tmp` file beside settings.json and then
// swaps it in, so such a file in the folder means a missing settings.json may be about to
// reappear. With no such file a missing file is an immediate answer, "no seat". A file still
// missing after the retries also means no seat. A well-formed file with a bad value is an
// answer and is not retried.
const SETTINGS_RETRIES = 3;
const SETTINGS_MISSING_RETRIES = 2;
const SETTINGS_RETRY_MS = 50;

export async function configuredSeatFile(codexHome, {
  reader = readFile,
  retryMs = SETTINGS_RETRY_MS,
  retries = SETTINGS_RETRIES,
  missingRetries = SETTINGS_MISSING_RETRIES,
  lister = readdir,
} = {}) {
  const directory = resolve(codexHome, "cache-statusband-codex");
  const path = resolve(directory, "settings.json");
  let settings;
  let missing = 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const raw = await reader(path, "utf8");
      settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
      break;
    } catch (error) {
      if (error?.code === "ENOENT") {
        if (missing >= missingRetries || !await replacementMayBeUnderway(directory, lister)) return null;
        missing += 1;
      } else if (attempt - missing >= retries) {
        throw error;
      }
      await new Promise((done) => setTimeout(done, retryMs));
    }
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("settings.json is not an object");
  if (!Object.hasOwn(settings, "seatFile")) return null;
  const value = settings.seatFile;
  if (typeof value !== "string" || !value.trim()) throw new Error("settings.json seatFile is not a non-empty string");
  return value.trim();
}

// The installer's temporary file for a settings.json it is about to swap in.
async function replacementMayBeUnderway(directory, lister) {
  try {
    return (await lister(directory)).some((name) => /^\.settings\.json\..+\.tmp$/.test(name));
  } catch {
    return false;
  }
}

// The seat file is rewritten by whatever manages the seat, possibly in two steps (truncate,
// then write), so a read that fails or finds nothing is tried again, as settings.json's is
// (up to SETTINGS_RETRIES more times, SETTINGS_RETRY_MS apart), before the seat counts as
// unavailable. A seat file that is still empty or unreadable after that is unavailable.
export async function readSeatLabel(path, {
  reader = readFile,
  retryMs = SETTINGS_RETRY_MS,
  retries = SETTINGS_RETRIES,
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const label = sanitizeLabel(await reader(path, "utf8"));
      if (label) return label;
    } catch {}
    if (attempt >= retries) return null;
    await new Promise((done) => setTimeout(done, retryMs));
  }
}

function expandPath(value, codexHome, env) {
  let path = String(value).trim();
  if (/^~[\\/]/.test(path)) {
    const home = env.USERPROFILE || env.HOME;
    if (home) path = resolve(home, path.slice(2));
  }
  return isAbsolute(path) ? path : resolve(codexHome, path);
}

function sanitizeLabel(value) {
  const text = stripControls(value).replace(/\s+/g, " ");
  return text ? text.slice(0, 80) : null;
}

function sanitizeEmail(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return !hasControl(text) && /^[^\s@]+@[^\s@]+$/.test(text) ? text.slice(0, 320) : null;
}
