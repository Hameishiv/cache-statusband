import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { hasControl, stripControls } from "./sanitize.mjs";

export async function displayIdentity(snapshot, {
  codexHome,
  env = process.env,
} = {}) {
  if (!codexHome) return sanitizeEmail(snapshot?.accountEmail);
  const seat = await configuredSeatIdentity(codexHome, env);
  if (seat) return seat.label;
  return sanitizeEmail(snapshot?.accountEmail);
}

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
  const identity = suppliedIdentity === undefined
    ? (codexHome ? await configuredSeatIdentity(codexHome, env) : null)
    : suppliedIdentity;
  if (!identity) return { snapshot, identity: sanitizeEmail(snapshot?.accountEmail) };
  if (!identity.unavailable && snapshot?.identityKey === identity.key) return { snapshot, identity: identity.label };
  return {
    identity: identity.label,
    snapshot: {
      ...snapshot,
      accountEmail: null,
      availableCount: null,
      credits: null,
      creditsOmitted: null,
      primary: null,
      secondary: null,
      source: "identity-changed",
    },
  };
}

// Resolves to the configured seat label file, or null when none is configured (no
// settings.json at all, or one without a seatFile). Anything else that stops the setting
// being read, or a seatFile that is not a non-empty string, throws: a seat that may have been
// configured but cannot be read must never fall back to showing the account email.
export async function configuredSeatFile(codexHome) {
  let raw;
  try {
    raw = await readFile(resolve(codexHome, "cache-statusband-codex", "settings.json"), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("settings.json is not an object");
  if (!Object.hasOwn(settings, "seatFile")) return null;
  const value = settings.seatFile;
  if (typeof value !== "string" || !value.trim()) throw new Error("settings.json seatFile is not a non-empty string");
  return value.trim();
}

export async function readSeatLabel(path) {
  try {
    const value = await readFile(path, "utf8");
    return sanitizeLabel(value);
  } catch {
    return null;
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
