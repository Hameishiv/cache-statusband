import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { acquireLock } from "./lock.mjs";
import { hasControl, stripControls } from "./sanitize.mjs";
import { configuredSeatIdentity } from "./settings.mjs";

const CACHE_VERSION = 3;
export const MIN_POLL_INTERVAL_MS = 5 * 60 * 1000;
export const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;
const LOCK_STALE_MS = 30 * 1000;
const CLIENT_VERSION = "0.4.2";

export async function getUsageSnapshot({
  codexHome,
  now = Date.now(),
  fetcher = fetchRateLimitsViaAppServer,
  env = process.env,
  identity: suppliedIdentity,
  timeoutMs,
  cacheOnly = false,
} = {}) {
  if (!codexHome) throw new Error("codexHome is required");
  const dataDir = join(codexHome, "cache-statusband-codex");
  await mkdir(dataDir, { recursive: true });

  const identity = suppliedIdentity === undefined
    ? await captureUsageIdentity(codexHome, { env })
    : suppliedIdentity;
  // A seat is a display label, not proof of which account the client will use.
  const expectedEmail = identity?.key?.startsWith("account:") ? safeEmail(identity.key.slice(8)) : null;
  if (!expectedEmail || identity?.unavailable) return present(null, "identity-unavailable");
  const suffix = cacheSuffix(identity);
  const cachePath = join(dataDir, `rate-limits${suffix}.json`);
  const lockPath = join(dataDir, `rate-limits${suffix}.lock`);
  const legacyPath = join(dataDir, "rate-limits.json");
  let aligned = alignCache(await readScopedCache(cachePath, legacyPath, identity), identity);
  let cached = aligned.cache;
  if (fresh(cached, now) && !cached?.migrateSeatDeadline) return present(cached, aligned.mismatch ? "identity-changed" : "cache");
  if (cacheOnly) {
    // The caller has no time left for a read. Report what is stored and change nothing,
    // so no attempt or error is recorded and the next caller may still poll.
    const { migrateSeatDeadline, ...stored } = cached ?? {};
    return present(cached ? stored : null, aligned.mismatch ? "identity-changed" : "stale");
  }

  const lock = await acquireLock(lockPath, { now, staleMs: LOCK_STALE_MS });
  if (!lock) return present(cached, aligned.mismatch ? "identity-changed" : "cache-busy");
  try {
    aligned = alignCache(await readScopedCache(cachePath, legacyPath, identity), identity);
    cached = aligned.cache;
    if (fresh(cached, now)) {
      const { migrateSeatDeadline, ...saved } = cached;
      if (migrateSeatDeadline) await writeCache(cachePath, saved);
      return present(saved, aligned.mismatch ? "identity-changed" : "cache");
    }

    const attempted = {
      ...emptyCache(),
      ...cached,
      migrateSeatDeadline: undefined,
      identityKey: identity?.key ?? cached?.identityKey ?? null,
      attemptedAt: now,
      nextAllowedAt: now + MIN_POLL_INTERVAL_MS,
    };
    await writeCache(cachePath, attempted);

    try {
      const raw = await fetcher({ codexHome, env, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
      const safe = sanitizeRateLimits(raw);
      if (safe.accountEmail !== expectedEmail) {
        // The read is verified, just for a different account. Keep it for that account
        // (never for this one), so the next caller on that login need not poll again.
        if (safe.accountEmail) await storeVerifiedAccount(dataDir, safe, now).catch(() => {});
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
    await lock.release();
  }
}

async function storeVerifiedAccount(dataDir, safe, now) {
  const identity = { key: `account:${safe.accountEmail}` };
  const suffix = cacheSuffix(identity);
  const path = join(dataDir, `rate-limits${suffix}.json`);
  if (fresh(await readCache(path), now)) return;
  const lock = await acquireLock(join(dataDir, `rate-limits${suffix}.lock`), { now, staleMs: LOCK_STALE_MS });
  if (!lock) return;
  try {
    if (fresh(await readCache(path), now)) return;
    await writeCache(path, {
      ...emptyCache(),
      ...safe,
      identityKey: identity.key,
      fetchedAt: now,
      attemptedAt: now,
      nextAllowedAt: now + MIN_POLL_INTERVAL_MS,
    });
  } finally {
    await lock.release();
  }
}

export async function captureUsageIdentity(codexHome, {
  env = process.env,
  accountReader = readAccountViaAppServer,
  throwOnFailure = false,
  timeoutMs,
} = {}) {
  const fail = (message) => {
    if (throwOnFailure) throw new Error(message);
    return null;
  };
  const seat = await configuredSeatIdentity(codexHome, env);
  // A configured seat that cannot be read must never fall back to the account email.
  if (seat?.unavailable) return fail("The configured seat label is unavailable");
  let account;
  try {
    account = await accountReader({ codexHome, env, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  } catch (error) {
    if (throwOnFailure) throw error;
    return null;
  }
  const email = safeEmail(account?.email);
  const seatAfter = await configuredSeatIdentity(codexHome, env);
  if (seat?.key !== seatAfter?.key) return fail("The seat changed during the account read");
  // No signed-in account is a real answer (null), not a failure.
  return email ? { key: `account:${email}`, label: seat ? seat.label : email, unavailable: false } : null;
}

// Node cannot spawn codex.cmd (npm installs) without a shell and refuses .cmd/.bat
// directly. Resolve what to run: CODEX_BIN, else a codex executable found on PATH,
// with .cmd/.bat wrapped through cmd.exe.
export function resolveCodexLaunch(env = process.env, platform = process.platform, args = ["app-server"]) {
  const configured = env.CODEX_BIN || null;
  const windows = platform === "win32";
  let target = configured;
  if (!target && windows) target = findOnWindowsPath(env);
  if (!target) return { command: "codex", args };
  if (windows && /\.(cmd|bat)$/i.test(target)) {
    // cmd.exe expands %VAR% inside a quoted command line and offers no way to escape it.
    if (target.includes("%")) {
      throw new Error(`Cannot launch ${target}: cmd.exe cannot safely run a path containing "%". Set CODEX_BIN to codex.exe or move the Codex install.`);
    }
    const line = [`"${target}"`, ...args].join(" ");
    return {
      command: env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", `"${line}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command: target, args };
}

function findOnWindowsPath(env) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  const directories = String(pathKey ? env[pathKey] : "").split(delimiter).map((value) => value.trim().replace(/^"|"$/g, "")).filter(Boolean);
  for (const directory of directories) {
    for (const extension of [".exe", ".cmd", ".bat"]) {
      const candidate = join(directory, `codex${extension}`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

// Stop a finished or abandoned app-server and release every handle on it, so a hung
// server cannot keep this process alive. Through cmd.exe (npm's codex.cmd) the real
// server is a grandchild that child.kill() does not reach, so on Windows take the whole
// tree. Killing cmd.exe first would orphan the server before taskkill could see it, so
// child.kill() is only the fallback when taskkill cannot run or fails.
function disposeChild(child) {
  let taskkilled = false;
  if (process.platform === "win32" && Number.isInteger(child.pid)) {
    try {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      const fallback = () => { try { child.kill(); } catch {} };
      killer.once("error", fallback);
      killer.once("exit", (code) => { if (code !== 0) fallback(); });
      taskkilled = true;
    } catch {}
  }
  for (const action of [
    () => child.stdin.end(),
    () => { if (!taskkilled) child.kill(); },
    () => child.stdin.destroy(),
    () => child.stdout.destroy(),
    () => child.stderr.destroy(),
    () => child.unref(),
  ]) {
    try {
      action();
    } catch {}
  }
}

export async function readAccountViaAppServer({
  codexHome,
  command,
  args,
  timeoutMs = 10_000,
  spawnImpl = spawn,
  env = process.env,
  platform = process.platform,
} = {}) {
  const childEnv = { ...env };
  if (codexHome) childEnv.CODEX_HOME = codexHome;
  const launch = command === undefined
    ? resolveCodexLaunch(env, platform, args)
    : { command, args: args ?? ["app-server"] };
  const child = spawnImpl(launch.command, launch.args, {
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  const lines = createInterface({ input: child.stdout });
  let settled = false;
  return await new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      disposeChild(child);
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
      // Server notifications/requests may reuse ids; only a bare response is ours.
      if (message.method !== undefined || message.id !== 2) return;
      if (message.error) finish(reject, new Error("Codex account read failed"));
      else finish(resolve, message.result?.account ?? null);
    });
    const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
    send({
      method: "initialize",
      id: 1,
      params: { clientInfo: { name: "cache_statusband_codex", title: "Cache Statusband Codex", version: CLIENT_VERSION } },
    });
    send({ method: "initialized", params: {} });
    send({ method: "account/read", id: 2, params: { refreshToken: false } });
  });
}

export async function fetchRateLimitsViaAppServer({
  codexHome,
  command,
  args,
  timeoutMs = 10_000,
  spawnImpl = spawn,
  env = process.env,
  platform = process.platform,
} = {}) {
  const childEnv = { ...env };
  if (codexHome) childEnv.CODEX_HOME = codexHome;
  const launch = command === undefined
    ? resolveCodexLaunch(env, platform, args)
    : { command, args: args ?? ["app-server"] };
  const child = spawnImpl(launch.command, launch.args, {
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
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
      disposeChild(child);
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
      if (message.method !== undefined) return;
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
      params: { clientInfo: { name: "cache_statusband_codex", title: "Cache Statusband Codex", version: CLIENT_VERSION } },
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
    const match = message.match(/retry[\s_-]*after(?:[\s_-]*(ms|milliseconds?)\b)?[^0-9]*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)?(?![a-z])/i);
    if (match) {
      const unit = (match[1] ?? match[3] ?? "s").toLowerCase();
      const scale = unit.startsWith("ms") || unit.startsWith("milli") ? 1
        : unit.startsWith("h") ? 3_600_000
        : unit.startsWith("m") ? 60_000
        : 1000;
      candidates.push(Number(match[2]) * scale);
    }
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
  // A deadline further out than any backoff we would write is corrupt, not a backoff.
  return Number.isFinite(cache?.nextAllowedAt) && now < cache.nextAllowedAt && cache.nextAllowedAt <= now + MAX_RETRY_AFTER_MS;
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
  if (legacy?.identityKey === identity?.key) return legacy;
  if (!identity?.label?.startsWith("Seat ")) return null;
  const oldIdentity = { key: `seat:${identity.label.slice(5)}` };
  const oldPath = join(dirname(path), `rate-limits${cacheSuffix(oldIdentity)}.json`);
  const old = await readCache(oldPath);
  if (old?.identityKey !== oldIdentity.key) return null;
  // Earlier versions keyed by seat. Preserve their backoff on upgrade, but their
  // readings were not bound to an account and must never be migrated as facts.
  return {
    ...emptyCache(),
    identityKey: identity.key,
    attemptedAt: old.attemptedAt,
    nextAllowedAt: old.nextAllowedAt,
    lastErrorAt: old.lastErrorAt,
    migrateSeatDeadline: true,
  };
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
  return typeof value === "string" ? stripControls(value).slice(0, 200) : null;
}

function safeEmail(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return !hasControl(text) && /^[^\s@]+@[^\s@]+$/.test(text) ? text.slice(0, 320) : null;
}

function walk(value, callback) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    callback(key, child);
    if (child && typeof child === "object") walk(child, callback);
  }
}
