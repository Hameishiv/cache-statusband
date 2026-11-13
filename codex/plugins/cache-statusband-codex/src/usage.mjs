import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { renameWithRetry } from "./atomic.mjs";
import { acquireLock } from "./lock.mjs";
import { hasControl, stripControls } from "./sanitize.mjs";
import { configuredSeatIdentity } from "./settings.mjs";

const CACHE_VERSION = 3;
export const MIN_POLL_INTERVAL_MS = 5 * 60 * 1000;
export const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;
const LOCK_STALE_MS = 30 * 1000;
const CLIENT_VERSION = "0.4.2";
const MAX_CREDIT_ROWS = 20;

export async function getUsageSnapshot({
  codexHome,
  now = Date.now(),
  fetcher = fetchRateLimitsViaAppServer,
  env = process.env,
  identity: suppliedIdentity,
  timeoutMs,
  cacheOnly = false,
  renameImpl,
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
      if (migrateSeatDeadline) await tryWriteCache(cachePath, saved, renameImpl);
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
    // A cache that cannot be written (a Windows rename that keeps failing) must not stop the
    // read: the reading is still worth showing, it just will not be shared.
    await tryWriteCache(cachePath, attempted, renameImpl);

    let saved;
    try {
      // The fetcher is told whose usage is wanted so it can check the login first and
      // send no rate-limit request for any other account (see fetchRateLimitsViaAppServer).
      const raw = await fetcher({ codexHome, env, expectedEmail, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
      const safe = sanitizeRateLimits(raw);
      if (!sameEmail(safe.accountEmail, expectedEmail)) throw new Error("Codex account changed during the usage read");
      saved = {
        ...emptyCache(),
        ...safe,
        identityKey: identity?.key ?? (safe.accountEmail ? `account:${safe.accountEmail}` : null),
        fetchedAt: now,
        attemptedAt: now,
        nextAllowedAt: now + MIN_POLL_INTERVAL_MS,
      };
    } catch (error) {
      const retryMs = retryAfterMilliseconds(error, now);
      const failed = {
        ...attempted,
        nextAllowedAt: now + Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_POLL_INTERVAL_MS, retryMs ?? 0)),
        lastErrorAt: now,
      };
      await tryWriteCache(cachePath, failed, renameImpl);
      return present(failed, "stale");
    }
    await tryWriteCache(cachePath, saved, renameImpl);
    return present(saved, "live");
  } finally {
    await lock.release();
  }
}

export async function captureUsageIdentity(codexHome, {
  env = process.env,
  accountReader = readAccountViaAppServer,
  accountsReader = accountReader === readAccountViaAppServer ? readAccountsViaAppServer : twoReadsWith(accountReader),
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
  const readOptions = { codexHome, env, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
  if (!seat) {
    let email;
    try {
      email = safeEmail((await accountReader(readOptions))?.email);
    } catch (error) {
      if (throwOnFailure) throw error;
      return null;
    }
    const seatAfter = await configuredSeatIdentity(codexHome, env);
    if (seatAfter?.key !== undefined) return fail("The seat changed during the account read");
    // No signed-in account is a real answer (null), not a failure.
    return email ? { key: `account:${email}`, label: email, unavailable: false } : null;
  }
  // A seat label asserts which login this session runs under, so a signed-out reading is
  // not an answer. The login is read twice on ONE app-server connection, with the seat file
  // checked in between: the pair is trusted only if the login did not change while the seat
  // was being confirmed. (A custom accountReader is called twice, as before.)
  const between = async (account) => {
    const seatAfter = await configuredSeatIdentity(codexHome, env);
    if (seat.key !== seatAfter?.key) throw new Error("The seat changed during the account read");
    if (!safeEmail(account?.email)) throw new Error("No account is signed in for the configured seat");
  };
  let email;
  let again;
  try {
    const [first, second] = await accountsReader({ ...readOptions, between });
    email = safeEmail(first?.email);
    again = safeEmail(second?.email);
  } catch (error) {
    if (throwOnFailure) throw error;
    return null;
  }
  if (!email || again !== email) return fail("The Codex account changed while the seat was being confirmed");
  return { key: `account:${email}`, label: seat.label, unavailable: false };
}

// Adapts a single-read reader to the two-read contract (reads, then between(), then reads).
function twoReadsWith(reader) {
  return async ({ between, ...options }) => {
    const first = await reader(options);
    await between(first);
    return [first, await reader(options)];
  };
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
      // /v:off: delayed expansion would treat "!" in a path as a variable reference.
      args: ["/d", "/v:off", "/s", "/c", `"${line}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command: target, args };
}

// A .cmd/.bat wrapper in a directory whose name contains % cannot be run safely through
// cmd.exe, so look past it for a usable candidate; only when nothing else exists is the
// unsafe one returned, so that resolveCodexLaunch can explain why it was refused.
function findOnWindowsPath(env) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  const directories = String(pathKey ? env[pathKey] : "").split(delimiter).map((value) => value.trim().replace(/^"|"$/g, "")).filter(Boolean);
  let refused = null;
  for (const directory of directories) {
    for (const extension of [".exe", ".cmd", ".bat"]) {
      const candidate = join(directory, `codex${extension}`);
      try {
        if (!statSync(candidate).isFile()) continue;
      } catch {
        continue;
      }
      if (extension !== ".exe" && candidate.includes("%")) refused ??= candidate;
      else return candidate;
    }
  }
  return refused;
}

// Every app-server this process has started and not yet finished with. A hook that
// reaches its deadline calls disposeAllAppServers() before exiting, so a server whose
// reader is still waiting is not left running.
const liveChildren = new Set();

// Stop a finished or abandoned app-server and release every handle on it, so a hung
// server cannot keep this process alive. Through cmd.exe (npm's codex.cmd) the real
// server is a grandchild that child.kill() does not reach, so on Windows take the whole
// tree. Killing cmd.exe first would orphan the server before taskkill could see it, so
// child.kill() is only the fallback when taskkill cannot run or fails. A child that has
// already exited is not signalled once its exit is known: its pid may be reused by an
// unrelated process.
// Returns a promise that settles once taskkill (if any) has finished.
function disposeChild(child, { platform = process.platform, spawnKiller = spawn } = {}) {
  const gone = child.exitCode != null || child.signalCode != null;
  let taskkilled = false;
  let finished = Promise.resolve();
  if (!gone && platform === "win32" && Number.isInteger(child.pid)) {
    try {
      const killer = spawnKiller("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      const fallback = () => { try { child.kill(); } catch {} };
      finished = new Promise((resolve) => {
        killer.once("error", () => { fallback(); resolve(); });
        killer.once("exit", (code) => { if (code !== 0) fallback(); resolve(); });
      });
      taskkilled = true;
    } catch {}
  }
  for (const action of [
    () => child.stdin.end(),
    () => { if (!taskkilled && !gone) child.kill(); },
    () => child.stdin.destroy(),
    () => child.stdout.destroy(),
    () => child.stderr.destroy(),
    () => child.unref(),
  ]) {
    try {
      action();
    } catch {}
  }
  return finished;
}

// Dispose every app-server still running, waiting briefly (never longer than waitMs) for
// taskkill so it has actually run before the caller exits the process.
export async function disposeAllAppServers({ waitMs = 1000, platform = process.platform, spawnKiller = spawn } = {}) {
  const pending = [...liveChildren].map((child) => disposeChild(child, { platform, spawnKiller }));
  liveChildren.clear();
  let timer;
  await Promise.race([
    Promise.all(pending),
    new Promise((resolve) => { timer = setTimeout(resolve, waitMs); }),
  ]);
  clearTimeout(timer);
}

export async function readAccountViaAppServer(options = {}) {
  return readAccountSession(options, 1);
}

// Two account reads on one app-server connection (so one start, not two). After the first
// response `between(firstAccount)` runs; if it throws, the session ends with that error and
// no second read is made. Resolves [firstAccount, secondAccount].
export async function readAccountsViaAppServer(options = {}) {
  return readAccountSession(options, 2);
}

async function readAccountSession({
  codexHome,
  command,
  args,
  timeoutMs = 10_000,
  spawnImpl = spawn,
  env = process.env,
  platform = process.platform,
  spawnKiller,
  between,
} = {}, reads) {
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
  liveChildren.add(child);
  const lines = createInterface({ input: child.stdout });
  let settled = false;
  let first;
  return await new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      liveChildren.delete(child);
      disposeChild(child, { platform, ...(spawnKiller ? { spawnKiller } : {}) });
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
      if (message.method !== undefined || (message.id !== 2 && message.id !== 4)) return;
      if (message.error) {
        finish(reject, new Error("Codex account read failed"));
        return;
      }
      const account = message.result?.account ?? null;
      if (reads === 1) {
        finish(resolve, account);
      } else if (message.id === 2) {
        if (first !== undefined) return;
        first = account;
        Promise.resolve()
          .then(() => between?.(account))
          .then(() => { if (!settled) send({ method: "account/read", id: 4, params: { refreshToken: false } }); })
          .catch((error) => finish(reject, error));
      } else if (first !== undefined) {
        finish(resolve, [first, account]);
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
  spawnKiller,
  expectedEmail,
} = {}) {
  // Only a named account may be read: without one there is nothing to check the login
  // against, and a rate-limit request would spend whichever account happens to be signed in.
  if (!safeEmail(expectedEmail)) throw new Error("fetchRateLimitsViaAppServer requires the expected account email");
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
  liveChildren.add(child);
  const lines = createInterface({ input: child.stdout });
  let settled = false;
  let account = null;

  return await new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      liveChildren.delete(child);
      disposeChild(child, { platform, ...(spawnKiller ? { spawnKiller } : {}) });
      callback(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("Codex rate-limit read timed out")), timeoutMs);

    child.once("error", (error) => finish(reject, error));
    child.stdin.once("error", (error) => finish(reject, error));
    child.once("exit", (code) => {
      if (!settled) finish(reject, new Error(`Codex app-server exited before the rate-limit response (${code ?? "unknown"})`));
    });
    child.stderr.on("data", () => {});
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.method !== undefined) return;
      if (message.id === 2) {
        if (account !== null) return;
        account = message.error ? {} : message.result?.account ?? {};
        // Only the account the caller wants is read: a rate-limit request made while a
        // different login is active would spend that account's quota, and any Retry-After
        // would be its, not ours. On a mismatch answer with the account alone.
        if (!sameEmail(safeEmail(account.email), expectedEmail)) {
          finish(resolve, { account });
          return;
        }
        try {
          send({ method: "account/rateLimits/read", id: 3, params: {} });
        } catch (error) {
          finish(reject, error);
        }
        return;
      }
      if (message.id !== 3) return;
      if (message.error) {
        const error = new Error("Codex rate-limit read failed");
        error.rpcData = message.error.data;
        error.rpcMessage = message.error.message;
        finish(reject, error);
      } else {
        finish(resolve, { ...(message.result ?? {}), account });
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
  });
}

export function sanitizeRateLimits(raw) {
  const bank = raw?.rateLimitResetCredits;
  const availableCount = finiteNonnegative(bank?.availableCount);
  // Rows beyond the cap are cut here, so how many were cut is recorded: "not shown" (this
  // plugin cut them) is a different statement from "not supplied" (Codex sent fewer).
  const creditsOmitted = Array.isArray(bank?.credits) ? Math.max(0, bank.credits.length - MAX_CREDIT_ROWS) : 0;
  const credits = Array.isArray(bank?.credits)
    ? bank.credits.slice(0, MAX_CREDIT_ROWS).map((credit) => ({
        title: safeText(credit?.title),
        expiresAt: finiteNonnegative(credit?.expiresAt),
      }))
    : null;
  const rateLimits = raw?.rateLimits;
  return {
    accountEmail: safeEmail(raw?.account?.email),
    availableCount,
    credits,
    creditsOmitted,
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

async function writeCache(path, value, renameImpl) {
  const temporary = `${path}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    await renameWithRetry(temporary, path, renameImpl ? { rename: renameImpl } : {});
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

// Cache writes are best effort once a reading exists: report whether it stuck, never throw.
async function tryWriteCache(path, value, renameImpl) {
  try {
    await writeCache(path, value, renameImpl);
    return true;
  } catch {
    return false;
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

function sameEmail(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
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
