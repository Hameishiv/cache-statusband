import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { capFirst, formatAge, formatDuration, formatUsageLines } from "../src/format.mjs";
import { getSessionIdentity, saveSessionState } from "../src/session-state.mjs";
import { usagePresentation } from "../src/settings.mjs";
import {
  fetchRateLimitsViaAppServer,
  captureUsageIdentity,
  codexHomeIsMissing,
  getUsageSnapshot,
  MAX_RETRY_AFTER_MS,
  MIN_POLL_INTERVAL_MS,
  readAccountViaAppServer,
  resolveCodexLaunch,
  retryAfterMilliseconds,
  sanitizeRateLimits,
} from "../src/usage.mjs";

const TEST_EMAIL = ["person", "example.invalid"].join("@");
const FAKE_EMAIL = ["test", "example.invalid"].join("@");
const OTHER_EMAIL = ["other", "example.invalid"].join("@");
const ACCOUNT_IDENTITY = { key: `account:${TEST_EMAIL}`, label: TEST_EMAIL, unavailable: false };
const SEAT_PREFIX = ["S", "eat"].join("");
const FIRST_SEAT = ["fixture", "one"].join("-");
const SECOND_SEAT = ["fixture", "two"].join("-");
const RAW = {
  account: { type: "chatgpt", email: TEST_EMAIL, token: "fixture-private-value" },
  rateLimits: {
    primary: { usedPercent: 70, windowDurationMins: 300, resetsAt: 1_793_285_913 },
    secondary: { usedPercent: 14, windowDurationMins: 10_080, resetsAt: 1_793_796_876 },
  },
  rateLimitResetCredits: {
    availableCount: 2,
    credits: [{ id: "RateLimitResetCredit_private", title: "Full reset", expiresAt: 1_793_302_971 }],
  },
  accountId: "private-account-id",
};

test("sanitizes rate-limit data down to display-safe fields", () => {
  const safe = sanitizeRateLimits(RAW);
  assert.equal(safe.availableCount, 2);
  assert.equal(safe.accountEmail, TEST_EMAIL);
  assert.deepEqual(safe.credits, [{ title: "Full reset", expiresAt: 1_793_302_971 }]);
  assert.equal(safe.primary.windowDurationMins, 300);
  assert.doesNotMatch(JSON.stringify(safe), /RateLimitResetCredit|account-id|fixture-private-value/);
});

test("shares one rate-limit read for at least five minutes", async (t) => {
  const root = await fixtureRoot(t);
  const now = Date.parse("2026-10-29T12:00:00.000Z");
  let calls = 0;
  const fetcher = async () => { calls += 1; return RAW; };
  const first = await getUsageSnapshot({ codexHome: root, now, fetcher, identity: ACCOUNT_IDENTITY });
  const second = await getUsageSnapshot({ codexHome: root, now: now + MIN_POLL_INTERVAL_MS - 1, fetcher, identity: ACCOUNT_IDENTITY });
  assert.equal(first.source, "live");
  assert.equal(second.source, "cache");
  assert.equal(second.availableCount, 2);
  assert.equal(calls, 1);
  const cacheName = `rate-limits-${createHash("sha256").update(ACCOUNT_IDENTITY.key).digest("hex").slice(0, 16)}.json`;
  const stored = await readFile(join(root, "cache-statusband-codex", cacheName), "utf8");
  assert.match(stored, new RegExp(TEST_EMAIL.replace(".", "\\.")));
  assert.doesNotMatch(stored, /RateLimitResetCredit|account-id|fixture-private-value/);
  await assert.rejects(access(join(root, "cache-statusband-codex", `${cacheName}.tmp`)));
});

test("honors a Retry-After longer than the five-minute floor", async (t) => {
  const root = await fixtureRoot(t);
  const now = Date.parse("2026-10-29T12:00:00.000Z");
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    const error = new Error("limited");
    error.rpcData = { retry_after: 900 };
    throw error;
  };
  const first = await getUsageSnapshot({ codexHome: root, now, fetcher, identity: ACCOUNT_IDENTITY });
  const second = await getUsageSnapshot({ codexHome: root, now: now + 10 * 60_000, fetcher, identity: ACCOUNT_IDENTITY });
  assert.equal(first.nextAllowedAt, now + 15 * 60_000);
  assert.equal(second.source, "cache");
  assert.equal(calls, 1);
  assert.equal(retryAfterMilliseconds({ rpcData: { retryAfterMs: 45_000 } }, now), 45_000);
  assert.equal(retryAfterMilliseconds({ rpcMessage: "limited; retry after 75 seconds" }, now), 75_000);
});

test("caps Retry-After at one hour and keeps the last good reading", async (t) => {
  const root = await fixtureRoot(t);
  const now = Date.parse("2026-10-29T12:00:00.000Z");
  const identity = { ...ACCOUNT_IDENTITY, label: `${SEAT_PREFIX} ${FIRST_SEAT}` };
  const good = await getUsageSnapshot({ codexHome: root, now, identity, fetcher: async () => RAW });
  const failed = await getUsageSnapshot({
    codexHome: root,
    now: now + MIN_POLL_INTERVAL_MS,
    identity,
    fetcher: async () => {
      const error = new Error("limited");
      error.rpcData = { retry_after: 86_400 };
      throw error;
    },
  });
  assert.equal(good.availableCount, 2);
  assert.equal(failed.source, "stale");
  assert.equal(failed.availableCount, 2);
  assert.equal(failed.primary.usedPercent, 70);
  assert.equal(failed.fetchedAt, now);
  assert.equal(failed.nextAllowedAt, now + MIN_POLL_INTERVAL_MS + MAX_RETRY_AFTER_MS);
});

test("a one-hour backoff written by a caller whose clock is a few seconds ahead still holds for a slightly earlier caller", async (t) => {
  const root = await fixtureRoot(t);
  const now = Date.parse("2026-10-29T12:00:00.000Z");
  const identity = { ...ACCOUNT_IDENTITY, label: `${SEAT_PREFIX} ${FIRST_SEAT}` };
  await getUsageSnapshot({ codexHome: root, now, identity, fetcher: async () => RAW });
  const writerNow = now + MIN_POLL_INTERVAL_MS;
  const failed = await getUsageSnapshot({
    codexHome: root,
    now: writerNow,
    identity,
    fetcher: async () => {
      const error = new Error("limited");
      error.rpcData = { retry_after: 86_400 };
      throw error;
    },
  });
  assert.equal(failed.nextAllowedAt, writerNow + MAX_RETRY_AFTER_MS);
  let calls = 0;
  const reader = await getUsageSnapshot({
    codexHome: root,
    now: writerNow - 5_000,
    identity,
    fetcher: async () => { calls += 1; return RAW; },
  });
  assert.equal(calls, 0, "the backoff holds; no fetch");
  assert.equal(reader.source, "cache");
  assert.equal(reader.nextAllowedAt, writerNow + MAX_RETRY_AFTER_MS);
});

test("speaks the documented app-server protocol", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const selectedHome = join(tmpdir(), "selected-codex-home");
  const result = await fetchRateLimitsViaAppServer({
    codexHome: selectedHome,
    command: process.execPath,
    args: [join(here, "..", "fixtures", "fake-app-server.mjs")],
    timeoutMs: 2_000,
    expectedEmail: FAKE_EMAIL,
    env: { ...process.env, EXPECT_CODEX_HOME: selectedHome },
  });
  assert.equal(result.rateLimitResetCredits.availableCount, 2);
  assert.equal(result.account.email, ["test", "example.invalid"].join("@"));
});

test("keeps usage polling and presentation scoped to the captured seat", async (t) => {
  const root = await fixtureRoot(t);
  const seatPath = join(root, "active-seat.txt");
  await writeFile(seatPath, `${FIRST_SEAT}\n`, "utf8");
  await mkdir(join(root, "cache-statusband-codex"), { recursive: true });
  await writeFile(
    join(root, "cache-statusband-codex", "settings.json"),
    `${JSON.stringify({ version: 1, seatFile: seatPath })}\n`,
    "utf8",
  );
  const now = Date.parse("2026-10-29T12:00:00.000Z");
  let calls = 0;
  let currentEmail = TEST_EMAIL;
  const accountReader = async () => ({ email: currentEmail });
  const fetcher = async () => { calls += 1; return { ...RAW, account: { email: currentEmail } }; };

  const firstIdentity = await captureUsageIdentity(root, { env: {}, accountReader });
  const first = await getUsageSnapshot({ codexHome: root, now, fetcher, env: {}, identity: firstIdentity });
  assert.equal(first.identityKey, `account:${TEST_EMAIL}`);
  assert.equal(first.availableCount, 2);
  await writeFile(seatPath, `${SECOND_SEAT}\n`, "utf8");
  currentEmail = OTHER_EMAIL;

  const firstPresented = await usagePresentation(first, { codexHome: root, env: {}, identity: firstIdentity });
  assert.equal(firstPresented.identity, `${SEAT_PREFIX} ${FIRST_SEAT}`);
  assert.equal(firstPresented.snapshot.primary.usedPercent, 70);
  assert.equal(calls, 1);

  const secondIdentity = await captureUsageIdentity(root, { env: {}, accountReader });
  const second = await getUsageSnapshot({ codexHome: root, now: now + 1_000, fetcher, env: {}, identity: secondIdentity });
  assert.equal(second.source, "live");
  assert.equal(second.identityKey, `account:${OTHER_EMAIL}`);
  assert.equal(second.availableCount, 2);
  assert.equal(calls, 2);

  await writeFile(seatPath, `${FIRST_SEAT}\n`, "utf8");
  currentEmail = TEST_EMAIL;
  const backToFirst = await getUsageSnapshot({
    codexHome: root,
    now: now + 2_000,
    fetcher,
    env: {},
    identity: await captureUsageIdentity(root, { env: {}, accountReader }),
  });
  assert.equal(backToFirst.source, "cache");
  assert.equal(backToFirst.identityKey, `account:${TEST_EMAIL}`);
  assert.equal(calls, 2);
});

test("rotation after seat capture cannot replace the original account's usage", async (t) => {
  const root = await fixtureRoot(t);
  const now = Date.parse("2026-10-29T12:00:00.000Z");
  const identity = { ...ACCOUNT_IDENTITY, label: `${SEAT_PREFIX} ${FIRST_SEAT}` };
  await getUsageSnapshot({ codexHome: root, now, identity, fetcher: async () => RAW });
  const wrongAccount = { ...RAW, account: { email: OTHER_EMAIL }, rateLimitResetCredits: { availableCount: 6 }, rateLimits: { primary: { usedPercent: 91 } } };
  let calls = 0;
  const fetcher = async () => { calls += 1; return wrongAccount; };
  const rejected = await getUsageSnapshot({ codexHome: root, now: now + MIN_POLL_INTERVAL_MS, identity, fetcher });
  assert.equal(rejected.source, "stale");
  assert.equal(rejected.accountEmail, TEST_EMAIL);
  assert.equal(rejected.availableCount, 2);
  assert.equal(rejected.primary.usedPercent, 70);
  assert.equal(rejected.fetchedAt, now);
  const shared = await getUsageSnapshot({ codexHome: root, now: now + MIN_POLL_INTERVAL_MS + 1, identity: ACCOUNT_IDENTITY, fetcher });
  assert.equal(shared.source, "cache");
  assert.equal(shared.availableCount, 2);
  assert.equal(calls, 1);
});

test("unverifiable accounts cannot authorize a poll or a blank replacement", async (t) => {
  const root = await fixtureRoot(t);
  const now = Date.parse("2026-10-29T12:00:00.000Z");
  const unavailable = await getUsageSnapshot({ codexHome: root, now, identity: null, fetcher: async () => { throw new Error("must not poll"); } });
  assert.equal(unavailable.source, "identity-unavailable");
  assert.equal(unavailable.availableCount, null);
  await getUsageSnapshot({ codexHome: root, now, identity: ACCOUNT_IDENTITY, fetcher: async () => RAW });
  const missingEmail = await getUsageSnapshot({ codexHome: root, now: now + MIN_POLL_INTERVAL_MS, identity: ACCOUNT_IDENTITY, fetcher: async () => ({ ...RAW, account: null }) });
  assert.equal(missingEmail.source, "stale");
  assert.equal(missingEmail.availableCount, 2);
});

test("seat rotation during identity capture yields no guessed account binding", async (t) => {
  const root = await fixtureRoot(t);
  const seatPath = join(root, "seat.txt");
  await writeFile(seatPath, FIRST_SEAT);
  const identity = await captureUsageIdentity(root, {
    env: { CACHE_STATUSBAND_CODEX_SEAT_FILE: seatPath },
    accountReader: async () => {
      await writeFile(seatPath, SECOND_SEAT);
      return { email: OTHER_EMAIL };
    },
  });
  assert.equal(identity, null);
});

test("upgrading a seat-keyed cache preserves its deadline but discards unverified readings", async (t) => {
  const root = await fixtureRoot(t);
  const now = Date.parse("2026-10-29T12:00:00.000Z");
  const oldKey = `seat:${FIRST_SEAT}`;
  const dataDir = join(root, "cache-statusband-codex");
  await mkdir(dataDir, { recursive: true });
  const name = `rate-limits-${createHash("sha256").update(oldKey).digest("hex").slice(0, 16)}.json`;
  await writeFile(join(dataDir, name), JSON.stringify({ version: 3, identityKey: oldKey, accountEmail: OTHER_EMAIL, availableCount: 6, nextAllowedAt: now + MIN_POLL_INTERVAL_MS }));
  const identity = { ...ACCOUNT_IDENTITY, label: `${SEAT_PREFIX} ${FIRST_SEAT}` };
  const snapshot = await getUsageSnapshot({ codexHome: root, now, identity, fetcher: async () => { throw new Error("must not poll before old deadline"); } });
  assert.equal(snapshot.source, "cache");
  assert.equal(snapshot.availableCount, null);
  assert.equal(snapshot.accountEmail, null);
  assert.equal(snapshot.nextAllowedAt, now + MIN_POLL_INTERVAL_MS);
  const alias = { ...ACCOUNT_IDENTITY, label: `${SEAT_PREFIX} ${SECOND_SEAT}` };
  const shared = await getUsageSnapshot({ codexHome: root, now: now + 1, identity: alias, fetcher: async () => { throw new Error("must share migrated deadline"); } });
  assert.equal(shared.source, "cache");
  assert.equal(shared.nextAllowedAt, snapshot.nextAllowedAt);
});

test("captures the account identity once when no seat file is configured", async (t) => {
  const root = await fixtureRoot(t);
  let reads = 0;
  const identity = await captureUsageIdentity(root, {
    env: {},
    accountReader: async () => {
      reads += 1;
      return { email: TEST_EMAIL };
    },
  });
  assert.deepEqual(identity, { key: `account:${TEST_EMAIL}`, label: TEST_EMAIL, unavailable: false });
  assert.equal(reads, 1);
});

test("prints every supplied expiry as an absolute local date in detailed output", () => {
  const now = Date.parse("2026-10-29T12:00:00.000Z");
  const snapshot = {
    availableCount: 2,
    credits: [
      { title: "Later reset", expiresAt: Date.parse("2026-10-31T12:00:00.000Z") / 1000 },
      { title: "First reset", expiresAt: Date.parse("2026-10-29T20:22:00.000Z") / 1000 },
    ],
  };
  const compact = formatUsageLines(snapshot, now);
  const detailed = formatUsageLines(snapshot, now, { includeResetDetails: true, locale: "en-US", timeZone: "UTC" });
  assert.equal(compact.length, 1);
  assert.match(detailed[1], /^  First reset — expires Oct 29, 2026, 8:22 PM UTC \(in 8h22m\)$/);
  assert.match(detailed[2], /^  Later reset — expires Oct 31, 2026, 12:00 PM UTC \(in 2d0h\)$/);
});

test("formats usage windows and ages without reset prose", () => {
  const now = Date.parse("2026-10-29T08:00:00.000Z");
  const lines = formatUsageLines({
    primary: { usedPercent: 43, windowDurationMins: 300, resetsAt: (now + (2 * 60 + 17) * 60_000) / 1000 },
    secondary: { usedPercent: 52, windowDurationMins: 10_080, resetsAt: (now + (5 * 24 + 17) * 60 * 60_000) / 1000 },
  }, now);
  assert.deepEqual(lines.slice(-2), ["5h 43% · 2h17m", "Week 52% · 5d17h"]);
  assert.equal(formatDuration((23 * 60 + 5) * 60_000), "23h05m");
  assert.equal(formatDuration(40 * 60_000), "40m");
  assert.equal(formatAge(now - (7 * 24 + 9) * 60 * 60_000, now), "7d9h");
});

test("states when Codex supplies a banked count without expiry details", () => {
  const lines = formatUsageLines(
    { availableCount: 2, credits: null },
    Date.parse("2026-10-29T12:00:00.000Z"),
    { includeResetDetails: true },
  );
  assert.equal(lines[1], "  Expiration details were not supplied by Codex.");
});

test("capitalizes the first word past symbols while preserving emails and digit labels", () => {
  assert.equal(capFirst("● cache warm"), "● Cache warm");
  assert.equal(capFirst("  expiration unavailable"), "  Expiration unavailable");
  assert.equal(capFirst("5h 70% used"), "5h 70% used");
  assert.equal(capFirst(TEST_EMAIL), TEST_EMAIL);
});

test("uses an explicitly configured seat file before the account email", async (t) => {
  const root = await fixtureRoot(t);
  const seatPath = join(root, "active-seat.txt");
  await writeFile(seatPath, `${FIRST_SEAT}\nunsafe\u0007`, "utf8");
  await mkdir(join(root, "cache-statusband-codex"), { recursive: true });
  await writeFile(
    join(root, "cache-statusband-codex", "settings.json"),
    `${JSON.stringify({ version: 1, seatFile: seatPath })}\n`,
    "utf8",
  );
  assert.equal((await usagePresentation({ accountEmail: TEST_EMAIL }, { codexHome: root, env: {} })).identity, `${SEAT_PREFIX} ${FIRST_SEAT} unsafe`);
  assert.equal((await usagePresentation({ accountEmail: TEST_EMAIL }, { codexHome: join(root, "missing"), env: {} })).identity, TEST_EMAIL);
});

const FAKE_SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-app-server.mjs");

test("resolves a runnable Codex command from CODEX_BIN or the Windows PATH", async (t) => {
  const root = await fixtureRoot(t);
  const bin = join(root, "npm bin");
  const other = join(root, "other");
  await mkdir(bin);
  await mkdir(other);
  await writeFile(join(bin, "codex.cmd"), "");
  await writeFile(join(other, "codex.exe"), "");
  const ComSpec = "C:\\Windows\\System32\\cmd.exe";

  const wrapped = resolveCodexLaunch({ Path: bin, ComSpec }, "win32");
  assert.equal(wrapped.command, ComSpec);
  assert.deepEqual(wrapped.args, ["/d", "/v:off", "/s", "/c", `""${join(bin, "codex.cmd")}" app-server"`]);
  assert.equal(wrapped.windowsVerbatimArguments, true);

  assert.equal(resolveCodexLaunch({ PATH: `${bin}${delimiter}${other}` }, "win32").command, "cmd.exe");
  assert.deepEqual(resolveCodexLaunch({ PATH: `${other}${delimiter}${bin}` }, "win32"), { command: join(other, "codex.exe"), args: ["app-server"] });
  assert.equal(resolveCodexLaunch({ PATH: other, CODEX_BIN: join(bin, "codex.cmd"), ComSpec }, "win32").windowsVerbatimArguments, true);
  assert.deepEqual(resolveCodexLaunch({ CODEX_BIN: "/opt/codex" }, "linux"), { command: "/opt/codex", args: ["app-server"] });
  assert.deepEqual(resolveCodexLaunch({ PATH: bin }, "linux"), { command: "codex", args: ["app-server"] });
  assert.deepEqual(resolveCodexLaunch({ PATH: join(root, "empty") }, "win32"), { command: "codex", args: ["app-server"] });
});

test("a codex.cmd whose path contains % is refused rather than expanded by cmd.exe", async (t) => {
  const root = await fixtureRoot(t);
  const bin = join(root, "100%PATH%");
  await mkdir(bin);
  await writeFile(join(bin, "codex.cmd"), "");
  assert.throws(() => resolveCodexLaunch({ Path: bin }, "win32"), /CODEX_BIN.*codex\.exe/);
  assert.throws(() => resolveCodexLaunch({ CODEX_BIN: join(bin, "codex.cmd") }, "win32"), /%/);
  // Only the cmd.exe wrapper has the problem: an .exe or a non-Windows path is fine.
  assert.equal(resolveCodexLaunch({ CODEX_BIN: join(bin, "codex.exe") }, "win32").command, join(bin, "codex.exe"));
  assert.equal(resolveCodexLaunch({ CODEX_BIN: "/opt/100%/codex" }, "linux").command, "/opt/100%/codex");
  // The readers surface it as an ordinary reader error.
  const env = { ...process.env, CODEX_BIN: join(bin, "codex.cmd") };
  const launch = { codexHome: root, env, platform: "win32", timeoutMs: 1000 };
  await assert.rejects(readAccountViaAppServer(launch), /CODEX_BIN/);
  await assert.rejects(fetchRateLimitsViaAppServer({ ...launch, expectedEmail: FAKE_EMAIL }), /CODEX_BIN/);
});

test("the app-server readers run an npm-style codex.cmd found on PATH", { skip: process.platform !== "win32" }, async (t) => {
  const root = await fixtureRoot(t);
  const bin = join(root, "npm bin dir");
  await mkdir(bin);
  await writeFile(join(bin, "codex.cmd"), `@echo off\r\n"${process.execPath}" "${FAKE_SERVER}" %*\r\n`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  env.Path = `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;
  delete env.CODEX_BIN;
  const account = await readAccountViaAppServer({ codexHome: root, env, timeoutMs: 5_000 });
  assert.equal(account.email, ["test", "example.invalid"].join("@"));
  const limits = await fetchRateLimitsViaAppServer({ codexHome: root, env, timeoutMs: 5_000, expectedEmail: FAKE_EMAIL });
  assert.equal(limits.rateLimitResetCredits.availableCount, 2);
});

const HUNG_SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "hung-app-server.mjs");
const USAGE_MODULE = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "usage.mjs");

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(condition, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

// Launch options for a Codex that never answers: a plain node process everywhere, and on
// Windows the npm shape too (codex.cmd -> cmd.exe -> node), where killing the wrapper
// alone leaves the real server running.
async function hungLaunch(root, { npmShape }) {
  const pidFile = join(root, "hung.pid");
  const env = { ...process.env, HUNG_PID_FILE: pidFile };
  if (!npmShape) return { pidFile, env, options: { command: process.execPath, args: [HUNG_SERVER] } };
  const bin = join(root, "npm bin dir");
  await mkdir(bin);
  await writeFile(join(bin, "codex.cmd"), `@echo off\r\n"${process.execPath}" "${HUNG_SERVER}" %*\r\n`);
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  env.Path = `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;
  delete env.CODEX_BIN;
  return { pidFile, env, options: {} };
}

for (const npmShape of process.platform === "win32" ? [false, true] : [false]) {
  const shape = npmShape ? "an npm-style codex.cmd" : "a plain executable";
  for (const [name, reader] of [["account", readAccountViaAppServer], ["rate-limit", fetchRateLimitsViaAppServer]]) {
    test(`a timed-out ${name} read leaves no server behind (${shape})`, async (t) => {
      const root = await fixtureRoot(t);
      const { pidFile, env, options } = await hungLaunch(root, { npmShape });
      await assert.rejects(reader({ codexHome: root, env, timeoutMs: 1500, expectedEmail: FAKE_EMAIL, ...options }), /timed out/);
      const pid = Number(await readFile(pidFile, "utf8"));
      assert.ok(Number.isInteger(pid) && pid > 0);
      try {
        assert.ok(await waitUntil(() => !alive(pid), 5_000), "the hung server was left running");
      } finally {
        if (alive(pid)) process.kill(pid);
      }
    });
  }

  test(`a process that timed out on a hung Codex exits promptly (${shape})`, async (t) => {
    const root = await fixtureRoot(t);
    const { pidFile, env, options } = await hungLaunch(root, { npmShape });
    const script = join(root, "call-reader.mjs");
    await writeFile(script, [
      `import { fetchRateLimitsViaAppServer } from ${JSON.stringify(pathToFileURL(USAGE_MODULE).href)};`,
      `try { await fetchRateLimitsViaAppServer({ codexHome: ${JSON.stringify(root)}, timeoutMs: 800, expectedEmail: ${JSON.stringify(FAKE_EMAIL)}, ...${JSON.stringify(options)} }); } catch {}`,
    ].join("\n"));
    const started = Date.now();
    const child = spawn(process.execPath, [script], { env, stdio: "ignore", windowsHide: true });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const gaveUp = new Promise((resolve) => setTimeout(() => resolve("hung"), 8_000));
    const outcome = await Promise.race([exited, gaveUp]);
    if (outcome === "hung") child.kill();
    try {
      assert.notEqual(outcome, "hung", "the process was held open by the abandoned server");
      assert.ok(Date.now() - started < 5_000);
    } finally {
      const pid = Number(await readFile(pidFile, "utf8").catch(() => 0));
      if (pid && alive(pid)) process.kill(pid);
    }
  });
}

test("server messages that reuse a response id are not mistaken for responses", async () => {
  const options = { command: process.execPath, args: [FAKE_SERVER], timeoutMs: 3_000, env: { ...process.env, FAKE_SERVER_NOISE: "1" } };
  assert.equal((await readAccountViaAppServer(options)).email, ["test", "example.invalid"].join("@"));
  const limits = await fetchRateLimitsViaAppServer({ ...options, expectedEmail: FAKE_EMAIL });
  assert.equal(limits.account.email, ["test", "example.invalid"].join("@"));
  assert.equal(limits.rateLimitResetCredits.availableCount, 2);
});

test("identity capture can fail loudly and never labels an unreadable seat with the email", async (t) => {
  const root = await fixtureRoot(t);
  const accountReader = async () => ({ email: TEST_EMAIL });
  await assert.rejects(captureUsageIdentity(root, { env: {}, throwOnFailure: true, accountReader: async () => { throw new Error("app-server down"); } }), /app-server down/);
  assert.equal(await captureUsageIdentity(root, { env: {}, accountReader: async () => { throw new Error("app-server down"); } }), null);
  // Signed out is an answer, not a failure.
  assert.equal(await captureUsageIdentity(root, { env: {}, throwOnFailure: true, accountReader: async () => null }), null);

  const emptySeat = join(root, "empty-seat.txt");
  await writeFile(emptySeat, "  \n");
  const env = { CACHE_STATUSBAND_CODEX_SEAT_FILE: emptySeat };
  assert.equal(await captureUsageIdentity(root, { env, accountReader }), null);
  await assert.rejects(captureUsageIdentity(root, { env, accountReader, throwOnFailure: true }), /seat/i);
  assert.equal((await usagePresentation({ accountEmail: TEST_EMAIL }, { codexHome: root, env })).identity, null);

  const seatPath = join(root, "seat.txt");
  await writeFile(seatPath, FIRST_SEAT);
  await assert.rejects(captureUsageIdentity(root, {
    env: { CACHE_STATUSBAND_CODEX_SEAT_FILE: seatPath },
    throwOnFailure: true,
    accountReader: async () => { await writeFile(seatPath, SECOND_SEAT); return { email: TEST_EMAIL }; },
  }), /seat/i);
});

test("a login with no ChatGPT email is flagged as such, never as signed out, with and without a seat", async (t) => {
  const root = await fixtureRoot(t);
  const noEmail = { type: "apiKey" };
  // No seat: throws the no-email flag, quietly null without throwOnFailure.
  const bare = await captureUsageIdentity(root, { env: {}, throwOnFailure: true, accountReader: async () => noEmail }).catch((error) => error);
  assert.equal(bare.noAccountEmail, true);
  assert.equal(bare.signedOut, undefined);
  assert.equal(bare.accountType, "apiKey");
  assert.equal(await captureUsageIdentity(root, { env: {}, accountReader: async () => noEmail }), null);
  // An unusable type reads as unknown; an email that fails validation counts as no email.
  const odd = await captureUsageIdentity(root, { env: {}, throwOnFailure: true, accountReader: async () => ({ type: "a\u001b[2Jb", email: "not an email" }) }).catch((error) => error);
  assert.equal(odd.noAccountEmail, true);
  assert.equal(odd.accountType, "unknown type");
  // Signed out stays signed out.
  assert.equal(await captureUsageIdentity(root, { env: {}, throwOnFailure: true, accountReader: async () => null }), null);

  const seatPath = join(root, "seat.txt");
  await writeFile(seatPath, FIRST_SEAT);
  const env = { CACHE_STATUSBAND_CODEX_SEAT_FILE: seatPath };
  const seated = await captureUsageIdentity(root, { env, throwOnFailure: true, accountReader: async () => ({ type: "amazonBedrock" }) }).catch((error) => error);
  assert.equal(seated.noAccountEmail, true);
  assert.equal(seated.signedOut, undefined);
  assert.equal(seated.accountType, "amazonBedrock");
  const seatedOut = await captureUsageIdentity(root, { env, throwOnFailure: true, accountReader: async () => null }).catch((error) => error);
  assert.equal(seatedOut.signedOut, true);
  assert.equal(seatedOut.noAccountEmail, undefined);
});

test("with a seat configured, a signed-out or changing login is a failure, not a binding", async (t) => {
  const root = await fixtureRoot(t);
  const seatPath = join(root, "seat.txt");
  await writeFile(seatPath, FIRST_SEAT);
  const env = { CACHE_STATUSBAND_CODEX_SEAT_FILE: seatPath };
  // Signed out under a seat label: nothing to bind the label to.
  await assert.rejects(captureUsageIdentity(root, { env, throwOnFailure: true, accountReader: async () => null }), /signed in/i);
  assert.equal(await captureUsageIdentity(root, { env, accountReader: async () => null }), null);
  // The login is read again after the seat was last checked; a change fails the capture.
  const emails = [TEST_EMAIL, OTHER_EMAIL];
  await assert.rejects(captureUsageIdentity(root, { env, throwOnFailure: true, accountReader: async () => ({ email: emails.shift() }) }), /changed/i);
  const again = [TEST_EMAIL, null];
  assert.equal(await captureUsageIdentity(root, { env, accountReader: async () => ({ email: again.shift() }) }), null);
  // A stable login under a seat is bound, after exactly two reads.
  let reads = 0;
  const identity = await captureUsageIdentity(root, { env, throwOnFailure: true, accountReader: async () => { reads += 1; return { email: TEST_EMAIL }; } });
  assert.equal(identity.key, `account:${TEST_EMAIL}`);
  assert.equal(identity.label, `${SEAT_PREFIX} ${FIRST_SEAT}`);
  assert.equal(reads, 2);
  // Without a seat the login is the label: signed out stays an answer, and one read suffices.
  reads = 0;
  assert.equal((await captureUsageIdentity(root, { env: {}, accountReader: async () => { reads += 1; return { email: TEST_EMAIL }; } })).label, TEST_EMAIL);
  assert.equal(reads, 1);
});

test("a per-call timeout reaches the identity reader and the usage fetcher", async (t) => {
  const root = await fixtureRoot(t);
  let readerTimeout;
  const identity = await captureUsageIdentity(root, { env: {}, timeoutMs: 1234, accountReader: async ({ timeoutMs }) => { readerTimeout = timeoutMs; return { email: TEST_EMAIL }; } });
  assert.equal(readerTimeout, 1234);
  let fetchTimeout;
  await getUsageSnapshot({ codexHome: root, now: Date.now(), identity, timeoutMs: 4321, fetcher: async ({ timeoutMs }) => { fetchTimeout = timeoutMs; return RAW; } });
  assert.equal(fetchTimeout, 4321);
});

test("parses retry-after units from error text", () => {
  const ms = (message) => retryAfterMilliseconds({ message }, 0);
  assert.equal(ms("limited; retry_after_ms: 500"), 500);
  assert.equal(ms("retry-after-ms=250"), 250);
  assert.equal(ms("retry after 5 minutes"), 300_000);
  assert.equal(ms("retry after 2m"), 120_000);
  assert.equal(ms("Retry-After: 30"), 30_000);
  assert.equal(ms("retry after 1500ms"), 1_500);
  assert.equal(ms("retry after 2 hours"), 7_200_000);
  assert.equal(ms("no hint here"), null);
  assert.equal(ms("retry after in 90 seconds"), 90_000);
});

test("a retry-after date in an error message is a moment; only what directly follows the words is read", () => {
  const now = Date.parse("2026-10-29T12:00:00.000Z");
  const ms = (message) => retryAfterMilliseconds({ message }, now);
  assert.equal(ms("rate limited. Retry after 2026-10-29T12:20:00Z"), 20 * 60_000);
  assert.equal(ms("Retry-After: 2026-10-29T12:05:30.500Z please"), 5 * 60_000 + 30_500);
  assert.equal(ms("retry after 2026-10-29T14:00:00+02:00"), 0);
  // An ISO date is never read as "2026 seconds".
  assert.notEqual(ms("retry after 2026-10-29T12:20:00Z"), 2026_000);
  // Words after a prose key are not a wait, nothing is searched for one further on, and a prose
  // key with no readable wait is no key at all (the caller's own floor).
  assert.equal(ms("retry after the 5h window (in 40 minutes)"), null);
  assert.equal(ms("retry after the 5h window"), null);
  // A date-time with no zone is UTC, whatever zone this machine is in.
  assert.equal(ms("retry after 2026-10-29T12:20:00"), 20 * 60_000);
  assert.equal(ms("retry after 2026-10-29 12:20:00"), 20 * 60_000);
  assert.equal(ms("retry after 2026-10-29T12:20:00.500"), 20 * 60_000 + 500);
});

test("retry-after wording in an error message: filler words and key suffixes directly after the key", () => {
  const ms = (message) => retryAfterMilliseconds({ message }, 0);
  const rows = [
    ["retry after approximately 30 minutes", 1.8e6],
    ["please retry after about 20 minutes", 1.2e6],
    ["retry after at least 10m", 6e5],
    ["retry after: ~30s", 3e4],
    ["retry after = 30s", 3e4],
    // A bare integer may be closed by the quote the prefix opened.
    ['Retry-After: "30"', 3e4],
    ['{"retry_after":"120"}', 1.2e5],
    ['"retry-after": "30"', 3e4],
    ["Retry-After: '30'", 3e4],
    ["retry after (30s)", 3e4],
    ["retry after - 30s", 3e4],
    ["retry_after_seconds=30", 3e4],
    ["retry_after_seconds: 30", 3e4],
    ["retry-after-secs: 3", 3e3],
    ["retry-after-ms: 250", 250],
    ["retry after the window resets in 3 hours", null],
    ["retry after the 5h window (in 40 minutes)", null],
  ];
  for (const [message, expected] of rows) assert.equal(ms(message), expected, message);
  // A prose key with no wait directly after it is no key.
  assert.equal(ms("retry after the window resets"), null);
  assert.equal(ms("retry after the 5h window"), null);
});

test("the missing-home line carries the path with control characters removed", async (t) => {
  const parent = await fixtureRoot(t);
  const here = dirname(fileURLToPath(import.meta.url));
  const bin = join(here, "..", "bin", "cache-statusband-codex.mjs");
  const home = join(parent, "no-such\u001b[31m-home");
  const { stderr } = await promisify(execFile)(process.execPath, [bin, "usage", "--codex-home", home], {
    env: { ...process.env, CACHE_STATUSBAND_CODEX_SEAT_FILE: "" },
    timeout: 20_000,
  });
  assert.doesNotMatch(stderr, /\u001b/);
  assert.match(stderr, /usage not read: the Codex home .*no-such.*-home does not exist\n$/);
});

test("a seat that becomes configured but unreadable during the account read is flagged seatUnavailable", async (t) => {
  const root = await fixtureRoot(t);
  const seatFile = join(root, "seat.txt");
  const account = { type: "chatgpt", email: TEST_EMAIL };

  // No seat at the start, a seat whose file reads empty by the end: flagged (the CLI stays silent).
  const env = {};
  await writeFile(seatFile, "");
  await assert.rejects(
    captureUsageIdentity(root, { env, throwOnFailure: true, accountReader: async () => { env.CACHE_STATUSBAND_CODEX_SEAT_FILE = seatFile; return account; } }),
    (error) => error.seatUnavailable === true && /seat changed during the account read/.test(error.message),
  );
  // ...and a seat that became available is a plain change, not flagged.
  const env2 = {};
  await writeFile(seatFile, "alpha");
  await assert.rejects(
    captureUsageIdentity(root, { env: env2, throwOnFailure: true, accountReader: async () => { env2.CACHE_STATUSBAND_CODEX_SEAT_FILE = seatFile; return account; } }),
    (error) => error.seatUnavailable === undefined && /seat changed during the account read/.test(error.message),
  );
  // A configured seat whose file empties while the login is read twice: flagged.
  const env3 = { CACHE_STATUSBAND_CODEX_SEAT_FILE: seatFile };
  await writeFile(seatFile, "alpha");
  await assert.rejects(
    captureUsageIdentity(root, { env: env3, throwOnFailure: true, accountReader: async () => { await writeFile(seatFile, ""); return account; } }),
    (error) => error.seatUnavailable === true,
  );
  // A seat that merely changed to another readable label is not flagged.
  await writeFile(seatFile, "alpha");
  await assert.rejects(
    captureUsageIdentity(root, { env: env3, throwOnFailure: true, accountReader: async () => { await writeFile(seatFile, "beta"); return account; } }),
    (error) => error.seatUnavailable === undefined && /seat changed/.test(error.message),
  );
});

test("retry-after: one strict grammar; a prose key with no readable wait is no key, a header key is the cap", () => {
  const now = Date.parse("2026-11-13T12:00:00.000Z");
  const ms = (message) => retryAfterMilliseconds({ message }, now);
  const rows = [
    ["retry after 5 more minutes", 3e5],
    ["retry after 10 more minutes", 6e5],
    ["retry after 2 days", 1.728e8],
    ["retry after 1 week", 6.048e8],
    ["retry after 5 (minutes)", 3e5],
    ["rate limited; retry after 5-hour window ends in 10m", null],
    ["retry after 1h30m", 5.4e6],
    ["retry after 1 hour 30 minutes", 5.4e6],
    ["retry after 1 hour and 30 minutes", 5.4e6],
    ["retry after 2 min 30 s", 1.5e5],
    ["retry after 1,500 ms", 1500],
    ["retry after .5 s", 500],
    ["retry after 1.5 hours", 5.4e6],
    ["retry after the 5h limit resets in 3 hours", null],
    ["retry after the 5 hour quota resets in 20 minutes", null],
    // Durations joined by "or", "to", "and", "&", a dash, a comma, spaces or tabs are a list: the longest.
    ["retry after 30 minutes or 2 hours", 7.2e6],
    ["retry after 5m-3h", 1.08e7],
    ["retry after 5m\u20143h", 1.08e7],
    ["retry after 5m to 3h", 1.08e7],
    ["retry after 5m, 3h", 1.08e7],
    ["retry after 3h, 5m", 1.11e7],
    ["retry after 1m 2h", 7.2e6],
    ["retry after 1 hour 30 minutes or 2 hours", 7.2e6],
    ["retry after 2 hours or 30 minutes", 7.2e6],
    // A list stops at the first item that is not a duration; what follows is not read.
    ["retry after 30s or in 10 minutes", 3e4],
    ["retry after 30s, request 41d4", 3e4],
    // "and" and "&" join a list; the longest item wins.
    ["retry after 30 minutes and 1 hour", 3.6e6],
    ["retry after 20 minutes & 1 hour", 3.6e6],
    ["retry after 2 hours and 30 minutes", 9e6],
    ["Retry-After: 30 minutes and 1 hour", 3.6e6],
    // A joiner never reaches across a line break: the next line is not read.
    ["Retry-After: 30s\n5h limit reached", 3e4],
    ["retry after 5 minutes\n2 hours later", 3e5],
    ["retry after 5 minutes\r\n2 hours later", 3e5],
    ["retry after 1 hour\n30 minutes", 3.6e6],
    // Two numbers sharing one unit are the larger number with that unit.
    ["retry after 5-10 minutes", 6e5],
    ["retry after 5 to 10 minutes", 6e5],
    ["retry after 5\u201310 min", 6e5],
    ["Retry-After: 5-10 minutes", 6e5],
    ["retry after 2-3 hours", 1.08e7],
    ["retry after 5-10 minutes or 1 hour", 3.6e6],
    // A decimal number after a HEADER key is seconds; after a prose key it is not a wait.
    ["Retry-After: 30.5", 30500],
    ["Retry-After: 0.5", 500],
    ["retry_after=1,500.25", 1500250],
    ["retry after 30.5", null],
    // A time with no zone followed by a space and a word or "(" names a zone we do not read:
    // unparsed (a header key then gives the cap, a prose key nothing), never UTC.
    ["Retry-After: 2026-11-13 12:30 EST", MAX_RETRY_AFTER_MS],
    ["Retry-After: 2026-11-13T12:30:00 America/New_York", MAX_RETRY_AFTER_MS],
    ["Retry-After: 2026-11-13 12:30 (UTC+2)", MAX_RETRY_AFTER_MS],
    ["Retry-After: Fri, 13 Nov 2026 12:30:00 EST", MAX_RETRY_AFTER_MS],
    ["retry after 2026-11-13 12:30 EST", null],
    ["retry after 2026-11-13T12:30:00 America/New_York", null],
    ["retry after 2026-11-13 12:30 (UTC+2)", null],
    // A zone that is read (or no zone with nothing after) is still a moment.
    ["retry after 2026-11-13 12:30 UTC", 1.8e6],
    ["retry after 2026-11-13 12:30:00 +02:00 please", 0],
    ["retry after 2026-11-13 12:30", 1.8e6],
    // A bare number is seconds only at the end of the text, a newline, or before . , ; ) ] }
    // (never before ( ' " or a digit), or before the quote the prefix opened ('"30"'), and a
    // number is whole except after a HEADER key.
    ["retry after 90", 9e4],
    ["retry after 90  ", 9e4],
    ["retry after 90.", 9e4],
    ["retry after 90, then wait", 9e4],
    ["retry after 90; then wait", 9e4],
    ["(retry after 90)", 9e4],
    ["[retry after 90]", 9e4],
    ["{retry after 90}", 9e4],
    ["retry after 90\nnext line", 9e4],
    ["retry after 90 \r\nnext line", 9e4],
    ["Retry-After: 17\nContent-Length: 0", 1.7e4],
    ["Retry-After: 17\r\nContent-Length: 0", 1.7e4],
    ["retry after 30 (attempt 3 of 5)", null],
    ["retry after 10 (about 10 minutes)", null],
    ["retry after 10 'minutes'", null],
    ['retry after 10 "minutes"', null],
    ["retry after 10 more", null],
    ["retry after 30s (attempt 300)", 3e4],
    // Clock times, window names, words, a year and a hyphenated noun are not waits: unparsed, and
    // after a prose key an unparsed value is no key.
    ["retry after 12:30", null],
    ["retry after the 5-hour window", null],
    ["retry after the 5 hour window", null],
    ["retry after a 2-hour cooldown", null],
    ["retry after 2-hour cooldown", null],
    ["retry after Nov 14, 2026", null],
    ["retry after soon", null],
    // A unit glued to more letters or digits is not a unit (ids, hashes), and the key still counts.
    ["retry after 7d9f3", null],
    ["retry after 41d4", null],
    ["retry after 8d1e", null],
    ["retry after 5m10h", null],
    ["retry after 3 more messages", null],
    ["retry after 1.5", null],
    // What follows a complete wait is not read: ids, years, other windows and other counts.
    ["retry after 20s (request id 7d9f3a-41d4-8d1e-9b2c)", 2e4],
    ["retry after 20 seconds, request_id req_41d4e8d1e", 2e4],
    ["retry after 20s; trace 8d1e7d9f3 2026 attempt 5", 2e4],
    ["retry after 1 minute (id 41d4-8d1e-7d9f3)", 6e4],
    ["retry after 20 minutes; your 5 hour usage is high", 1.2e6],
    ["retry after 20 minutes 2026", 1.2e6],
    // A moment: ISO with a zone, ISO with none and nothing after it but the end or a non-word (UTC),
    // a zone after a space, an HTTP-date.
    ["retry after 2026-11-13T12:20:00Z", 1.2e6],
    ["retry after 2026-11-13T14:20:00+02:00", 1.2e6],
    ["retry after 2026-11-13 14:20:00 +02:00", 1.2e6],
    ["retry after 2026-11-13 14:20:00 +0200", 1.2e6],
    ["retry after 2026-11-13T12:20:00", 1.2e6],
    ["Retry-After: Fri, 13 Nov 2026 12:30:00 GMT", 1.8e6],
    ["retry after Fri, 13 Nov 2026 12:30:00", 1.8e6],
    // A moment already past is 0, never negative.
    ["retry after 2026-11-13T11:00:00Z", 0],
    ["Retry-After: Fri, 13 Nov 2026 11:00:00 GMT", 0],
    // A moment and a count: the longer.
    ["retry after 2026-11-13T12:05:00Z or in 20 minutes", 3e5],
    ["retry after 2026-11-13T12:40:00Z or in 20 minutes", 2.4e6],
    // Several mentions: the longest.
    ["retry after 30s. Later: retry-after 2 minutes", 1.2e5],
    ["retry at your convenience", null],
    ["retry attempt 5 failed", null],
    // Ordinary prose that happens to contain a key is nothing.
    ["retry after reconnecting", null],
    ["retry after sign-in", null],
    ["retry after the thread is closed", null],
    ["retry at most 3 times", null],
    ["will retry at most 3 times", null],
    ["retry at any time", null],
    ["retry at a later time", null],
    ["no Retry-After header was sent", null],
    ["no retry-after header", null],
    // "null" and "none" are no key, after either form.
    ['{"retry_after":null}', null],
    ["retry_after: null", null],
    ["Retry-After: none", null],
    ["retry after none", null],
    // "retry after:", "retry at:", "retryAt:" and "retry at =" are PROSE keys (a key with a space in it
    // is not a header): ":" and "=" are only prefix tokens, so an unreadable value is no key.
    ["Cannot retry after: the thread is closed", null],
    ["retry at: any time", null],
    ["retry after: the window resets", null],
    ["retryAt: later", null],
    ["retry at = soon", null],
    ["retryAt: 30", 3e4],
    ["retry at = 30", 3e4],
    // After a HEADER key (a spelling with no space in it, then a colon or equals) an unparsed value
    // is the cap: the server named a Retry-After it did not make readable.
    ["Retry-After: soon", MAX_RETRY_AFTER_MS],
    ["retry_after=later", MAX_RETRY_AFTER_MS],
    ["retry-after-ms: later", MAX_RETRY_AFTER_MS],
    ['{"retry_after":"soon"}', MAX_RETRY_AFTER_MS],
    // A date with no time is the end of that day, UTC (the clock here is 12:00Z).
    ["retry after 2026-11-13", 4.32e7],
    ["Retry-After: 2026-11-13", 4.32e7],
    ["retry after 2026-11-12", 0],
  ];
  for (const [message, expected] of rows) assert.equal(ms(message), expected, message);
  assert.equal(ms("retry after 9".concat("9".repeat(400))), Number.MAX_SAFE_INTEGER);
});

test("retry-after in structured error data: keys with unit suffixes in any case, and moments as strings", () => {
  const now = Date.parse("2026-11-13T12:00:00.000Z");
  const data = (rpcData) => retryAfterMilliseconds({ rpcData }, now);
  const rows = [
    [{ retry_after_seconds: 1800 }, 1.8e6],
    [{ retryAfterSeconds: 1800 }, 1.8e6],
    [{ retry_after_secs: 30 }, 3e4],
    [{ "retry-after-ms": 250 }, 250],
    [{ retryAfterMs: 45_000 }, 45_000],
    [{ retry_after_minutes: 5 }, 3e5],
    [{ retryAfterHours: 2 }, 7.2e6],
    [{ retry_after: 900 }, 9e5],
    [{ retry_after: "900" }, 9e5],
    [{ retry_after: "5 minutes" }, 3e5],
    [{ retry_after: "1h30m" }, 5.4e6],
    [{ retry_after: "30 minutes and 1 hour" }, 3.6e6],
    [{ retry_after: "5-10 minutes" }, 6e5],
    [{ retry_after: "30.5" }, 30500],
    [{ retry_after: '"30"' }, 3e4],
    [{ retry_after: "2026-11-13T12:20:00Z" }, 1.2e6],
    [{ retry_after: "2026-11-13T12:20:00" }, 1.2e6],
    [{ retry_after: "2026-11-13 14:20:00 +02:00" }, 1.2e6],
    [{ retryAfter: "Fri, 13 Nov 2026 12:30:00 GMT" }, 1.8e6],
    [{ retry_at: "2026-11-13T12:20:00Z" }, 1.2e6],
    [{ retry_at: Date.parse("2026-11-13T12:10:00Z") / 1000 }, 6e5],
    [{ retry_at: Date.parse("2026-11-13T12:10:00Z") }, 6e5],
    [{ retry_at_ms: Date.parse("2026-11-13T12:10:00Z") }, 6e5],
    [{ retry_after: -5 }, 0],
    [{ error: { details: [{ retryAfterSeconds: 120 }] } }, 1.2e5],
    // Two keys: the longer.
    [{ retry_after: 60, retryAfterSeconds: 600 }, 6e5],
    [{ retry_after: "" }, null],
    [{ retry_after: null }, null],
    [{ unrelated: 5 }, null],
    // An object value: {secs, nanos}, {seconds} or {ms}.
    [{ retry_after: { secs: 30, nanos: 0 } }, 3e4],
    [{ retry_after: { secs: 1, nanos: 500_000_000 } }, 1500],
    [{ retry_after: { seconds: 45 } }, 4.5e4],
    [{ retry_after: { ms: 250 } }, 250],
    // Any other object, an array or a boolean is a retry key whose value is unreadable: the cap.
    [{ retry_after: {} }, MAX_RETRY_AFTER_MS],
    [{ retry_after: { when: "soon" } }, MAX_RETRY_AFTER_MS],
    [{ retry_after: { secs: "30" } }, MAX_RETRY_AFTER_MS],
    [{ retry_after: [30] }, MAX_RETRY_AFTER_MS],
    [{ retry_after: true }, MAX_RETRY_AFTER_MS],
    [{ retry_after: false }, MAX_RETRY_AFTER_MS],
    // null states nothing, and so do "null" and "none".
    [{ retry_after: "null" }, null],
    [{ retry_after: "none" }, null],
    // A date with no time is the end of that day, UTC.
    [{ retry_after: "2026-11-13" }, 4.32e7],
  ];
  for (const [rpcData, expected] of rows) assert.equal(data(rpcData), expected, JSON.stringify(rpcData));
  // Data and message together: the longer.
  assert.equal(retryAfterMilliseconds({ rpcData: { retry_after: 60 }, message: "retry after 10 minutes" }, now), 6e5);
  // Structured data: a parsed number or string always wins over a cap from the message text, and
  // the message cap answers only when nothing parsed at all.
  assert.equal(retryAfterMilliseconds({ rpcData: { retry_after: 30 }, message: "Retry-After: soon" }, now), 3e4);
  assert.equal(retryAfterMilliseconds({ rpcData: { retry_after: 30 }, message: "rate limited. Retry-After: later, retry after the window" }, now), 3e4);
  assert.equal(retryAfterMilliseconds({ rpcData: { retry_after: { secs: 30, nanos: 0 } }, message: "Retry-After: soon" }, now), 3e4);
  assert.equal(retryAfterMilliseconds({ rpcData: { retry_after: [30] }, message: "retry after 10 minutes" }, now), 6e5);
  assert.equal(retryAfterMilliseconds({ rpcData: { retry_after: "soon" }, message: "retry after 10 minutes" }, now), 6e5);
  assert.equal(retryAfterMilliseconds({ rpcData: { retry_after: [30] }, message: "Retry-After: soon" }, now), MAX_RETRY_AFTER_MS);
  assert.equal(retryAfterMilliseconds({ rpcData: { retry_after: null }, message: "Retry-After: soon" }, now), MAX_RETRY_AFTER_MS);
  assert.equal(retryAfterMilliseconds({ rpcData: { retry_after: null }, message: "no Retry-After header was sent" }, now), null);
  // A retry key whose string value is not a wait is the cap, as after a header key in text.
  assert.equal(data({ retry_after: "soon" }), MAX_RETRY_AFTER_MS);
  assert.equal(data({ retryAfter: "a 2-hour cooldown" }), MAX_RETRY_AFTER_MS);
  assert.equal(data({ retry_after: "7d9f3" }), MAX_RETRY_AFTER_MS);
  assert.equal(data({ retry_after: "2026-11-13 12:30 EST" }), MAX_RETRY_AFTER_MS);
  assert.equal(data({ retry_after: "20s (request 41d4)" }), 2e4);
  // Depth is limited, a cycle ends, and a long string is cut.
  let deep = { retry_after: 9999 };
  for (let i = 0; i < 12; i += 1) deep = { nested: deep };
  assert.equal(data(deep), null);
  const loop = { retry_after: 30 };
  loop.self = loop;
  assert.equal(data(loop), 3e4);
  assert.equal(data({ retry_after: `${"x".repeat(300)} 20s` }), MAX_RETRY_AFTER_MS);
});

test("retry-after: hostile messages finish quickly and never throw", () => {
  const started = Date.now();
  // Prose keys with nothing readable after them are no key; header keys are the cap.
  assert.equal(retryAfterMilliseconds({ message: "retry after ".repeat(300_000) }, 0), null);
  assert.equal(retryAfterMilliseconds({ message: "Retry-After: ".repeat(300_000) }, 0), MAX_RETRY_AFTER_MS);
  assert.equal(retryAfterMilliseconds({ message: `retry after ${"Mon".repeat(30_000)}` }, 0), null);
  assert.equal(retryAfterMilliseconds({ message: "retry after ".repeat(30_000) + "Mon ".repeat(30_000) }, 0), null);
  assert.equal(retryAfterMilliseconds({ message: `retry after${" ".repeat(300_000)}5` }, 0), null);
  assert.equal(retryAfterMilliseconds({ message: `Retry-After:${" ".repeat(300_000)}5` }, 0), MAX_RETRY_AFTER_MS);
  assert.equal(retryAfterMilliseconds({ message: `retry after ${"1,".repeat(100_000)}` }, 0), null);
  assert.equal(retryAfterMilliseconds({ message: `retry after ${"5m-".repeat(100_000)}` }, 0), 300_000);
  assert.equal(retryAfterMilliseconds({ message: `retry after ${"1m ".repeat(100_000)}` }, 0), 60_000 * 1);
  assert.equal(retryAfterMilliseconds({ message: `retry after ${"1m and ".repeat(100_000)}` }, 0), 60_000);
  assert.equal(retryAfterMilliseconds({ message: `retry after ${"5-10 min, ".repeat(100_000)}` }, 0), 600_000);
  assert.equal(retryAfterMilliseconds({ message: `Retry-After: ${'"'.repeat(100_000)}5` }, 0), MAX_RETRY_AFTER_MS);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});

test("a message-stated wait of hours is capped at one hour by the caller", async (t) => {
  const root = await fixtureRoot(t);
  const now = Date.parse("2026-10-29T12:00:00.000Z");
  const failed = await getUsageSnapshot({
    codexHome: root,
    now,
    identity: ACCOUNT_IDENTITY,
    fetcher: async () => { throw new Error("limited; retry after 3 hours"); },
  });
  assert.equal(failed.nextAllowedAt, now + MAX_RETRY_AFTER_MS);
});

test("a cache deadline beyond the longest possible backoff does not suppress polling", async (t) => {
  const root = await fixtureRoot(t);
  const now = Date.parse("2026-10-29T12:00:00.000Z");
  const dataDir = join(root, "cache-statusband-codex");
  await mkdir(dataDir, { recursive: true });
  const name = `rate-limits-${createHash("sha256").update(ACCOUNT_IDENTITY.key).digest("hex").slice(0, 16)}.json`;
  await writeFile(join(dataDir, name), JSON.stringify({ version: 3, identityKey: ACCOUNT_IDENTITY.key, availableCount: 9, nextAllowedAt: now + 10 * 60 * 60_000 }));
  let calls = 0;
  const snapshot = await getUsageSnapshot({ codexHome: root, now, identity: ACCOUNT_IDENTITY, fetcher: async () => { calls += 1; return RAW; } });
  assert.equal(calls, 1);
  assert.equal(snapshot.source, "live");
  assert.equal(snapshot.availableCount, 2);
});

test("a different login is detected before any rate-limit request is made", async (t) => {
  const root = await fixtureRoot(t);
  const now = Date.parse("2026-10-29T12:00:00.000Z");
  const log = join(root, "requests.log");
  const fakeFetcher = (email) => (options) => fetchRateLimitsViaAppServer({
    ...options,
    command: process.execPath,
    args: [FAKE_SERVER],
    timeoutMs: 5_000,
    env: { ...process.env, FAKE_SERVER_EMAIL: email, FAKE_SERVER_LOG: log },
  });
  const requests = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);

  // The expected account (A) is signed out in favour of B: only the account is read.
  const mismatched = await getUsageSnapshot({ codexHome: root, now, identity: ACCOUNT_IDENTITY, fetcher: fakeFetcher(OTHER_EMAIL) });
  assert.equal(mismatched.source, "stale");
  assert.equal(mismatched.availableCount, null);
  assert.equal(mismatched.accountEmail, null);
  assert.deepEqual(await requests(), ["initialize", "initialized", "account/read"]);
  // Nothing was stored for B, and A is backed off for the usual interval.
  assert.equal((await readdir(join(root, "cache-statusband-codex"))).filter((name) => name.endsWith(".json")).length, 1);
  assert.equal(mismatched.nextAllowedAt, now + MIN_POLL_INTERVAL_MS);

  // The same login, spelled in a different case, is the same account.
  await rm(log);
  const matched = await getUsageSnapshot({ codexHome: root, now: now + MIN_POLL_INTERVAL_MS, identity: ACCOUNT_IDENTITY, fetcher: fakeFetcher(TEST_EMAIL.toUpperCase()) });
  assert.equal(matched.source, "live");
  assert.equal(matched.availableCount, 2);
  assert.deepEqual((await requests()).filter((name) => name === "account/rateLimits/read"), ["account/rateLimits/read"]);
});

test("banked-reset lines say how old a non-live reading is", () => {
  const now = Date.parse("2026-10-29T12:00:00.000Z");
  const base = { availableCount: 2, credits: null };
  assert.equal(formatUsageLines({ ...base, source: "live", fetchedAt: now }, now)[0], "Banked resets: 2");
  assert.equal(formatUsageLines({ ...base, source: "cache", fetchedAt: now - MIN_POLL_INTERVAL_MS }, now)[0], "Banked resets: 2");
  assert.equal(formatUsageLines({ ...base, source: "cache", fetchedAt: now - 3 * MIN_POLL_INTERVAL_MS }, now)[0], "Banked resets: 2 (checked 15m ago)");
  assert.equal(formatUsageLines({ ...base, source: "stale", fetchedAt: now - 60_000 }, now)[0], "Banked resets: 2 (checked 1m ago)");
  assert.equal(formatUsageLines({ ...base, source: "stale" }, now)[0], "Banked resets: 2 (check time unknown)");
});

test("local dates use a plain space before AM/PM", () => {
  const [, detail] = formatUsageLines(
    { availableCount: 1, credits: [{ title: "Reset", expiresAt: Date.parse("2026-10-29T20:22:00.000Z") / 1000 }] },
    Date.parse("2026-10-29T12:00:00.000Z"),
    { includeResetDetails: true, locale: "en-US", timeZone: "UTC" },
  );
  assert.doesNotMatch(detail, /[\u202f\u00a0]/);
});

async function fixtureRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "cache-statusband-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("a cache-only snapshot reports what is stored and records no attempt", async (t) => {
  const root = await fixtureRoot(t);
  const now = Date.parse("2026-10-29T12:00:00.000Z");
  const dataDir = join(root, "cache-statusband-codex");
  const name = `rate-limits-${createHash("sha256").update(ACCOUNT_IDENTITY.key).digest("hex").slice(0, 16)}.json`;
  const fetcher = async () => { throw new Error("must not read"); };

  // Nothing stored: empty, and nothing written (not even the cache folder).
  const empty = await getUsageSnapshot({ codexHome: root, now, identity: ACCOUNT_IDENTITY, fetcher, cacheOnly: true });
  assert.equal(empty.availableCount, null);
  await assert.rejects(access(dataDir));
  await mkdir(dataDir);

  // An expired reading is shown as stale and the file is untouched.
  const stored = JSON.stringify({ version: 3, identityKey: ACCOUNT_IDENTITY.key, accountEmail: TEST_EMAIL, availableCount: 4, fetchedAt: now - 3_600_000, nextAllowedAt: now - 1000, lastErrorAt: null });
  await writeFile(join(dataDir, name), stored);
  const stale = await getUsageSnapshot({ codexHome: root, now, identity: ACCOUNT_IDENTITY, fetcher, cacheOnly: true });
  assert.equal(stale.availableCount, 4);
  assert.equal(stale.source, "stale");
  assert.equal(await readFile(join(dataDir, name), "utf8"), stored);
  assert.deepEqual((await readdir(dataDir)).sort(), [name]);
});

test("a % codex.cmd earlier on PATH is skipped when a usable codex.exe comes later", async (t) => {
  const root = await fixtureRoot(t);
  const bad = join(root, "100%PATH%");
  const good = join(root, "good");
  await mkdir(bad);
  await mkdir(good);
  await writeFile(join(bad, "codex.cmd"), "");
  await writeFile(join(good, "codex.exe"), "");
  assert.deepEqual(resolveCodexLaunch({ PATH: `${bad}${delimiter}${good}` }, "win32"), { command: join(good, "codex.exe"), args: ["app-server"] });
  // Nothing usable anywhere: the refusal still names the problem.
  assert.throws(() => resolveCodexLaunch({ PATH: bad }, "win32"), /CODEX_BIN.*codex\.exe/);
  // A % in the directory only matters to the cmd.exe wrapper.
  await writeFile(join(bad, "codex.exe"), "");
  assert.equal(resolveCodexLaunch({ PATH: bad }, "win32").command, join(bad, "codex.exe"));
});

test("the CLI says once, on stderr, why an unlaunchable Codex cannot be read", { skip: process.platform !== "win32" }, async (t) => {
  const root = await fixtureRoot(t);
  const bad = join(root, "100%PATH%");
  await mkdir(bad);
  await writeFile(join(bad, "codex.cmd"), "");
  const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "cache-statusband-codex.mjs");
  for (const command of ["usage", "board"]) {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [bin, command, "--codex-home", root], {
      env: { ...process.env, CODEX_BIN: join(bad, "codex.cmd") },
      timeout: 20_000,
    });
    assert.equal(stderr.split("cannot safely run a path containing").length - 1, 1, stderr);
    assert.match(stderr, /CODEX_BIN/);
    // No account can be verified, so no cached or invented usage: just the unavailable header.
    const header = "Banked resets: unavailable\n";
    assert.equal(stdout, command === "usage" ? header : `${header}\nNo Codex rollout transcripts found under ${root}.\n`);
  }
});

test("a server that has already exited is not signalled again, but a live one is stopped", async (t) => {
  const root = await fixtureRoot(t);
  const killed = [];
  const spawnKiller = (...call) => {
    killed.push(call);
    const fake = new EventEmitter();
    setImmediate(() => fake.emit("exit", 0));
    return fake;
  };
  // Exits by itself a moment after start: its pid may be reused, so nothing may target it.
  const brief = { command: process.execPath, args: ["-e", "process.stdin.resume(); setTimeout(() => process.exit(0), 300)"] };
  for (const reader of [readAccountViaAppServer, fetchRateLimitsViaAppServer]) {
    await assert.rejects(reader({ codexHome: root, ...brief, platform: "win32", spawnKiller, timeoutMs: 5_000, expectedEmail: FAKE_EMAIL }), /exited before/);
  }
  assert.deepEqual(killed, []);
  // A server still running when the read ends is taken down with its whole process tree.
  const pidFile = join(root, "live.pid");
  const env = { ...process.env, HUNG_PID_FILE: pidFile };
  await assert.rejects(readAccountViaAppServer({ codexHome: root, command: process.execPath, args: [HUNG_SERVER], env, platform: "win32", spawnKiller, timeoutMs: 400 }), /timed out/);
  try {
    assert.equal(killed.length, 1);
    assert.deepEqual(killed[0][0], "taskkill");
    assert.deepEqual(killed[0][1].slice(2), ["/T", "/F"]);
  } finally {
    // The faked killer never stopped the real server, and it may still be starting up:
    // wait for its pid file, then take it down so it cannot outlive the test.
    await waitUntil(async () => (await readFile(pidFile, "utf8").catch(() => "")) !== "", 3_000);
    const pid = Number(await readFile(pidFile, "utf8").catch(() => 0));
    if (pid && alive(pid)) {
      if (process.platform === "win32") await promisify(execFile)("taskkill", ["/PID", String(pid), "/T", "/F"]).catch(() => {});
      else process.kill(pid);
    }
  }
});

test("a Codex home that does not exist is never created by usage, board or the session-state writers", async (t) => {
  const parent = await fixtureRoot(t);
  const home = join(parent, "no-such-codex-home");
  const stillMissing = async (what) => assert.deepEqual((await readdir(parent)).filter((name) => name === "no-such-codex-home"), [], `${what} created the home`);
  const fetcher = async () => { throw new Error("must not read"); };

  // Both the normal and the cache-only paths take the "cannot update the cache" answer.
  const snapshot = await getUsageSnapshot({ codexHome: home, identity: ACCOUNT_IDENTITY, fetcher });
  assert.equal(snapshot.cacheUnwritable, true);
  assert.equal(snapshot.availableCount, null);
  await stillMissing("getUsageSnapshot");
  await getUsageSnapshot({ codexHome: home, identity: ACCOUNT_IDENTITY, fetcher, cacheOnly: true });
  await stillMissing("getUsageSnapshot (cacheOnly)");
  // No identity: nothing is created before the identity is known either.
  assert.equal((await getUsageSnapshot({ codexHome: home, identity: null, fetcher })).source, "identity-unavailable");
  await stillMissing("getUsageSnapshot (no identity)");

  // The session-state writers: a missing home is not created, a failed identity record falls
  // back to the login just read, and a failed Stop save throws (the hook swallows it).
  const identity = await getSessionIdentity(home, "missing-home-session", async () => ACCOUNT_IDENTITY);
  assert.equal(identity.key, ACCOUNT_IDENTITY.key);
  await stillMissing("getSessionIdentity");
  const summary = { contextUsed: 10, contextWindow: 100, updatedAt: "2026-10-29T12:00:00.000Z" };
  await assert.rejects(saveSessionState(home, "missing-home-session", summary), { code: "ENOENT" });
  await stillMissing("saveSessionState");

  // The CLI, with a fake app-server that signs in an account (the CLI must not even ask it).
  const here = dirname(fileURLToPath(import.meta.url));
  const bin = join(here, "..", "bin", "cache-statusband-codex.mjs");
  const server = join(here, "..", "fixtures", "fake-app-server.mjs");
  const windows = process.platform === "win32";
  const wrapper = join(parent, windows ? "codex.cmd" : "codex");
  await writeFile(wrapper, windows
    ? `@echo off\r\n"${process.execPath}" "${server}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${server}" "$@"\n`, { mode: 0o755 });
  const requestLog = join(parent, "requests.log");
  for (const args of [["usage"], ["usage", "--json"], ["board"], ["board", "--json"]]) {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [bin, ...args, "--codex-home", home], {
      env: { ...process.env, CODEX_BIN: wrapper, CACHE_STATUSBAND_CODEX_SEAT_FILE: "", FAKE_SERVER_LOG: requestLog },
      timeout: 20_000,
    });
    await assert.rejects(access(requestLog), `${args.join(" ")}: the app-server was asked something`);
    // One line says the home is missing (the app-server is never started for it), and nothing
    // says the cache cannot be updated.
    assert.equal(stderr, `cache-statusband-codex: usage not read: the Codex home ${home} does not exist
`, `${args.join(" ")}: ${stderr}`);
    assert.ok(stdout.length > 0);
    await stillMissing(`cache-statusband-codex ${args.join(" ")}`);
  }
});

// Only ENOENT and ENOTDIR mean the home does not exist; any other stat error falls through to the
// normal path (which reports what is really wrong). A seat that is configured but unreadable
// keeps the CLI silent even for a missing home.
test("a missing Codex home: only ENOENT/ENOTDIR say so, and an unavailable seat stays silent", async (t) => {
  const stat = (code) => () => { throw Object.assign(new Error(code), { code }); };
  assert.equal(codexHomeIsMissing("x", stat("ENOENT")), true);
  assert.equal(codexHomeIsMissing("x", stat("ENOTDIR")), true);
  for (const code of ["EACCES", "EPERM", "ENAMETOOLONG", "EBUSY", "UNKNOWN"]) assert.equal(codexHomeIsMissing("x", stat(code)), false, code);
  assert.equal(codexHomeIsMissing("x", () => ({})), false);
  assert.equal(codexHomeIsMissing(dirname(fileURLToPath(import.meta.url))), false);

  const parent = await fixtureRoot(t);
  const here = dirname(fileURLToPath(import.meta.url));
  const bin = join(here, "..", "bin", "cache-statusband-codex.mjs");
  const home = join(parent, "no-such-home");
  const emptySeat = join(parent, "empty-seat.txt");
  await writeFile(emptySeat, "");
  for (const args of [["usage"], ["board"]]) {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [bin, ...args, "--codex-home", home], {
      env: { ...process.env, CACHE_STATUSBAND_CODEX_SEAT_FILE: emptySeat },
      timeout: 20_000,
    });
    assert.equal(stderr, "", `${args.join(" ")} with an unavailable seat said: ${stderr}`);
    assert.ok(stdout.length > 0);
  }
  // Without a seat the same missing home is named.
  const { stderr } = await promisify(execFile)(process.execPath, [bin, "usage", "--codex-home", home], {
    env: { ...process.env, CACHE_STATUSBAND_CODEX_SEAT_FILE: "" },
    timeout: 20_000,
  });
  assert.match(stderr, /the Codex home .* does not exist\n$/);
});

test("an account reader that throws because the seat became unavailable is flagged seatUnavailable", async (t) => {
  const root = await fixtureRoot(t);
  const seatFile = join(root, "seat.txt");
  const boom = () => Object.assign(new Error("read failed"), { code: "EPIPE" });

  // No seat at the start; the seat file is configured but empty by the time the reader fails.
  const env = {};
  await writeFile(seatFile, "");
  await assert.rejects(
    captureUsageIdentity(root, { env, throwOnFailure: true, accountReader: async () => { env.CACHE_STATUSBAND_CODEX_SEAT_FILE = seatFile; throw boom(); } }),
    (error) => error.seatUnavailable === true && error.code === "EPIPE",
  );
  // A reader that fails with the seat still absent is a plain failure.
  await assert.rejects(
    captureUsageIdentity(root, { env: {}, throwOnFailure: true, accountReader: async () => { throw boom(); } }),
    (error) => error.seatUnavailable === undefined && error.code === "EPIPE",
  );
  // A seat configured and readable at the start whose file empties before the reader fails.
  const env2 = { CACHE_STATUSBAND_CODEX_SEAT_FILE: seatFile };
  await writeFile(seatFile, "alpha");
  await assert.rejects(
    captureUsageIdentity(root, { env: env2, throwOnFailure: true, accountReader: async () => { await writeFile(seatFile, ""); throw boom(); } }),
    (error) => error.seatUnavailable === true && error.code === "EPIPE",
  );
  // ...and one whose seat stays readable is a plain failure.
  await writeFile(seatFile, "alpha");
  await assert.rejects(
    captureUsageIdentity(root, { env: env2, throwOnFailure: true, accountReader: async () => { throw boom(); } }),
    (error) => error.seatUnavailable === undefined && error.code === "EPIPE",
  );
});
