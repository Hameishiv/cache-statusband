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
import { usagePresentation } from "../src/settings.mjs";
import {
  fetchRateLimitsViaAppServer,
  captureUsageIdentity,
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

test("a retry-after date in an error message is a moment, and a number must directly follow the words", () => {
  const now = Date.parse("2026-10-29T12:00:00.000Z");
  const ms = (message) => retryAfterMilliseconds({ message }, now);
  assert.equal(ms("rate limited. Retry after 2026-10-29T12:20:00Z"), 20 * 60_000);
  assert.equal(ms("Retry-After: 2026-10-29T12:05:30.500Z please"), 5 * 60_000 + 30_500);
  assert.equal(ms("retry after 2026-10-29T14:00:00+02:00"), 0);
  // An ISO date is never read as "2026 seconds".
  assert.notEqual(ms("retry after 2026-10-29T12:20:00Z"), 2026_000);
  // The 5h is a window name, not the wait: nothing follows "retry after" directly.
  assert.equal(ms("retry after the 5h window (in 40 minutes)"), null);
  assert.equal(ms("retry after the 5h window"), null);
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

  // Nothing stored: empty, and nothing written.
  const empty = await getUsageSnapshot({ codexHome: root, now, identity: ACCOUNT_IDENTITY, fetcher, cacheOnly: true });
  assert.equal(empty.availableCount, null);
  await assert.rejects(access(join(dataDir, name)));

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
