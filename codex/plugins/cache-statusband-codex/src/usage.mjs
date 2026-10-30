import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { configuredSeatIdentity } from "./settings.mjs";

const CACHE_VERSION = 3;
export const MIN_POLL_INTERVAL_MS = 5 * 60 * 1000;
export const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;
const LOCK_STALE_MS = 30 * 1000;

export async function getUsageSnapshot({
  codexHome,
  now = Date.now(),
  fetcher = fetchRateLimitsViaAppServer,
  env = process.env,
  identity: suppliedIdentity,
} = {}) {
  if (!codexHome) throw new Error("codexHome is required");
  const dataDir = join(codexHome, "cache-statusband-codex");
  await mkdir(dataDir, { recursive: true });

  const identity = suppliedIdentity === undefined
    ? await configuredSeatIdentity(codexHome, env)
    : suppliedIdentity;
  const suffix = cacheSuffix(identity);
  const cachePath = join(dataDir, `rate-limits${suffix}.json`);
  const lockPath = join(dataDir, `rate-limits${suffix}.lock`);
  const legacyPath = join(dataDir, "rate-limits.json");
  let aligned = alignCache(await readScopedCache(cachePath, legacyPath, identity), identity);
  let cached = aligned.cache;
  if (fresh(cached, now)) return present(cached, aligned.mismatch ? "identity-changed" : "cache");

  const lock = await acquireLock(lockPath, now);
  if (!lock) return present(cached, aligned.mismatch ? "identity-changed" : "cache-busy");
  try {
    aligned = alignCache(await readScopedCache(cachePath, legacyPath, identity), identity);
    cached = aligned.cache;
    if (fresh(cached, now)) return present(cached, aligned.mismatch ? "identity-changed" : "cache");

    const attempted = {
      ...emptyCache(),
      ...cached,
      identityKey: identity?.key ?? cached?.identityKey ?? null,
      attemptedAt: now,
      nextAllowedAt: now + MIN_POLL_INTERVAL_MS,
    };
    await writeCache(cachePath, attempted);

    try {
      const raw = await fetcher({ codexHome, env });
      const safe = sanitizeRateLimits(raw);
      if (identity?.key?.startsWith("account:") && safe.accountEmail && safe.accountEmail !== identity.label) {
        throw new Error("Codex account changed during the usage read");
      }
      const saved = {
        ...emptyCache(),
        ...safe,
        identityKey: identity?.key ?? (safe.accountEmail ? `account:${safe.accountEmail}` : null),
        fetchedAt: now,
        attemptedAt: now,
        nextAllowedAt: now + MIN_POLL_INTERVAL_MS,
      };
      await writeCache(cachePath, saved);
      return present(saved, "live");
    } catch (error) {
      const retryMs = retryAfterMilliseconds(error, now);
      const failed = {
        ...attempted,
        nextAllowedAt: now + Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_POLL_INTERVAL_MS, retryMs ?? 0)),
        lastErrorAt: now,
      };
      await writeCache(cachePath, failed);
      return present(failed, "stale");
    }
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}

export async function captureUsageIdentity(codexHome, {
  env = process.env,
  accountReader = readAccountViaAppServer,
} = {}) {
  const seat = await configuredSeatIdentity(codexHome, env);
  if (seat) return seat;
  try {
    const account = await accountReader({ codexHome, env });
    const email = safeEmail(account?.email);
    return email ? { key: `account:${email}`, label: email, unavailable: false } : null;
  } catch {
    return null;
  }
}

// Node cannot spawn the npm codex.cmd shim directly on Windows, so the default launch goes through cmd.exe.
function appServerLaunch(command, args) {
  if (process.platform === "win32" && command === "codex" && !process.env.CODEX_BIN) {
    return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", "codex", ...args] };
  }
  return { command, args };
}

export async function readAccountViaAppServer({
  codexHome,
  command = process.env.CODEX_BIN || "codex",
  args = ["app-server"],
  timeoutMs = 10_000,
  spawnImpl = spawn,
  env = process.env,
} = {}) {
  const childEnv = { ...env };
  if (codexHome) childEnv.CODEX_HOME = codexHome;
  const launch = appServerLaunch(command, args);
  const child = spawnImpl(launch.command, launch.args, {
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout });
  let settled = false;
  return await new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      child.kill();
      callback(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("Codex account read timed out")), timeoutMs);
    child.once("error", (error) => finish(reject, error));
    child.stdin.once("error", (error) => finish(reject, error));
    child.once("exit", (code) => {
      if (!settled) finish(reject, new Error(`Codex app-server exited before the account response (${code ?? "unknown"})`));
    });
    child.stderr.on("data", () => {});
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id !== 2) return;
      if (message.error) finish(reject, new Error("Codex account read failed"));
      else finish(resolve, message.result?.account ?? null);
    });
    const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
    send({
      method: "initialize",
      id: 1,
      params: { clientInfo: { name: "cache_statusband_codex", title: "Cache Statusband Codex", version: "0.4.0" } },
    });
    send({ method: "initialized", params: {} });
    send({ method: "account/read", id: 2, params: { refreshToken: false } });
  });
}

export async function fetchRateLimitsViaAppServer({
  codexHome,
  command = process.env.CODEX_BIN || "codex",
  args = ["app-server"],
  timeoutMs = 10_000,
  spawnImpl = spawn,
  env = process.env,
} = {}) {
  const childEnv = { ...env };
  if (codexHome) childEnv.CODEX_HOME = codexHome;
  const launch = appServerLaunch(command, args);
  const child = spawnImpl(launch.command, launch.args, {
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout });
  let settled = false;
  let accountDone = false;
  let rateLimitsDone = false;
  let account = null;
  let rateLimits = null;

  return await new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      child.kill();
      callback(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("Codex rate-limit read timed out")), timeoutMs);

    child.once("error", (error) => finish(reject, error));
    child.stdin.once("error", (error) => finish(reject, error));
    child.once("exit", (code) => {
      if (!settled) finish(reject, new Error(`Codex app-server exited before the rate-limit response (${code ?? "unknown"})`));
    });
    child.stderr.on("data", () => {});
    const maybeFinish = () => {
      if (accountDone && rateLimitsDone) finish(resolve, { ...rateLimits, account });
    };
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 2) {
        accountDone = true;
        account = message.error ? null : message.result?.account ?? null;
        maybeFinish();
        return;
      }
      if (message.id !== 3) return;
      if (message.error) {
        const error = new Error("Codex rate-limit read failed");
        error.rpcData = message.error.data;
        error.rpcMessage = message.error.message;
        finish(reject, error);
      } else {
        rateLimitsDone = true;
        rateLimits = message.result ?? {};
        maybeFinish();
      }
    });

    const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
    send({
      method: "initialize",
      id: 1,
      params: { clientInfo: { name: "cache_statusband_codex", title: "Cache Statusband Codex", version: "0.4.0" } },
    });
    send({ method: "initialized", params: {} });
    send({ method: "account/read", id: 2, params: { refreshToken: false } });
    send({ method: "account/rateLimits/read", id: 3, params: {} });
  });
}

export function sanitizeRateLimits(raw) {
  const bank = raw?.rateLimitResetCredits;
  const availableCount = finiteNonnegative(bank?.availableCount);
  const credits = Array.isArray(bank?.credits)
    ? bank.credits.slice(0, 20).map((credit) => ({
        title: safeText(credit?.title),
        expiresAt: finiteNonnegative(credit?.expiresAt),
      }))
    : null;
  const rateLimits = raw?.rateLimits;
  return {
    accountEmail: safeEmail(raw?.account?.email),
    availableCount,
    credits,
    primary: safeWindow(rateLimits?.primary),
    secondary: safeWindow(rateLimits?.secondary),
  };
}

export function retryAfterMilliseconds(error, now = Date.now()) {
  const data = error?.rpcData ?? error?.data ?? null;
  const candidates = [];
  if (data && typeof data === "object") {
    walk(data, (key, value) => {
      const normalized = key.toLowerCase().replaceAll("_", "").replaceAll("-", "");
      if (normalized === "retryafterms" && Number.isFinite(Number(value))) candidates.push(Number(value));
      if (normalized === "retryafter") {
        if (Number.isFinite(Number(value))) candidates.push(Number(value) * 1000);
        else {
          const at = Date.parse(value);
          if (Number.isFinite(at)) candidates.push(Math.max(0, at - now));
        }
      }
      if (normalized === "retryat" || normalized === "retryatms") {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) {
          const timestamp = normalized === "retryatms" || numeric > 10_000_000_000 ? numeric : numeric * 1000;
          candidates.push(Math.max(0, timestamp - now));
        } else {
          const at = Date.parse(value);
          if (Number.isFinite(at)) candidates.push(Math.max(0, at - now));
        }
      }
    });
  }
  const message = error?.rpcMessage ?? error?.message;
  if (typeof message === "string") {
    const match = message.match(/retry[\s_-]*after[^0-9]*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec(?:ond)?s?)?/i);
    if (match) candidates.push(Number(match[1]) * (/^m/i.test(match[2] ?? "s") ? 1 : 1000));
  }
  return candidates.length ? Math.max(...candidates.filter((value) => value >= 0)) : null;
}

function emptyCache() {
  return {
    version: CACHE_VERSION,
    attemptedAt: null,
    fetchedAt: null,
    nextAllowedAt: null,
    lastErrorAt: null,
    identityKey: null,
    accountEmail: null,
    availableCount: null,
    credits: null,
    primary: null,
    secondary: null,
  };
}

function alignCache(cache, identity) {
  if (!cache || !identity || cache.identityKey === identity.key) return { cache, mismatch: false };
  return {
    mismatch: true,
    cache: {
      ...emptyCache(),
      attemptedAt: cache.attemptedAt,
      nextAllowedAt: cache.nextAllowedAt,
      lastErrorAt: cache.lastErrorAt,
      identityKey: identity.key,
    },
  };
}

function present(cache, source) {
  return cache ? { ...cache, source } : { ...emptyCache(), source };
}

function fresh(cache, now) {
  return Number.isFinite(cache?.nextAllowedAt) && now < cache.nextAllowedAt;
}

async function readCache(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value?.version === CACHE_VERSION ? value : null;
  } catch {
    return null;
  }
}

async function readScopedCache(path, legacyPath, identity) {
  const scoped = await readCache(path);
  if (scoped || path === legacyPath) return scoped;
  const legacy = await readCache(legacyPath);
  return legacy?.identityKey === identity?.key ? legacy : null;
}

function cacheSuffix(identity) {
  if (!identity?.key) return "";
  return `-${createHash("sha256").update(identity.key).digest("hex").slice(0, 16)}`;
}

async function writeCache(path, value) {
  const temporary = `${path}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function acquireLock(path, now) {
  try {
    return await open(path, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  try {
    const info = await stat(path);
    if (now - info.mtimeMs <= LOCK_STALE_MS) return null;
    await unlink(path);
    return await open(path, "wx", 0o600);
  } catch {
    return null;
  }
}

function safeWindow(value) {
  if (!value || typeof value !== "object") return null;
  return {
    usedPercent: finiteNonnegative(value.usedPercent),
    windowDurationMins: finiteNonnegative(value.windowDurationMins),
    resetsAt: finiteNonnegative(value.resetsAt),
  };
}

function finiteNonnegative(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function safeText(value) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200) : null;
}

function safeEmail(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return /^[^\s@]+@[^\s@]+$/.test(text) ? text.slice(0, 320) : null;
}

function walk(value, callback) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    callback(key, child);
    if (child && typeof child === "object") walk(child, callback);
  }
}
