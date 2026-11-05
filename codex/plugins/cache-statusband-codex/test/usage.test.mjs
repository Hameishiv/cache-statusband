import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { capFirst, formatAge, formatDuration, formatUsageLines } from "../src/format.mjs";
import { displayIdentity, usagePresentation } from "../src/settings.mjs";
import {
  fetchRateLimitsViaAppServer,
  captureUsageIdentity,
  getUsageSnapshot,
  MAX_RETRY_AFTER_MS,
  MIN_POLL_INTERVAL_MS,
  retryAfterMilliseconds,
  sanitizeRateLimits,
} from "../src/usage.mjs";

const TEST_EMAIL = ["person", "example.invalid"].join("@");
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

test("speaks the documented app-server protocol", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const selectedHome = join(tmpdir(), "selected-codex-home");
  const result = await fetchRateLimitsViaAppServer({
    codexHome: selectedHome,
    command: process.execPath,
    args: [join(here, "..", "fixtures", "fake-app-server.mjs")],
    timeoutMs: 2_000,
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
  assert.equal(await displayIdentity({ accountEmail: TEST_EMAIL }, { codexHome: root, env: {} }), `${SEAT_PREFIX} ${FIRST_SEAT} unsafe`);
  assert.equal(await displayIdentity({ accountEmail: TEST_EMAIL }, { codexHome: join(root, "missing"), env: {} }), TEST_EMAIL);
});

async function fixtureRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "cache-statusband-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
