import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

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
  const configured = env.CACHE_STATUSBAND_CODEX_SEAT_FILE || await configuredSeatFile(codexHome);
  if (!configured) return null;
  const seat = await readSeatLabel(expandPath(configured, codexHome, env));
  // A missing or empty seat file falls back to the account identity.
  return seat ? { key: `seat:${seat}`, label: `Seat ${seat}`, unavailable: false } : null;
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
      primary: null,
      secondary: null,
      source: "identity-changed",
    },
  };
}

export async function configuredSeatFile(codexHome) {
  try {
    const raw = await readFile(resolve(codexHome, "cache-statusband-codex", "settings.json"), "utf8");
    const value = JSON.parse(raw)?.seatFile;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
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
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().replace(/\s+/g, " ");
  return text ? text.slice(0, 80) : null;
}

function sanitizeEmail(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return /^[^\s@]+@[^\s@]+$/.test(text) ? text.slice(0, 320) : null;
}
