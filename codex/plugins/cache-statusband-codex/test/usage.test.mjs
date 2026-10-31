import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { capFirst, formatAge, formatDuration, formatUsageLines, plainSpaces } from "../src/format.mjs";
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
  const first = await getUsageSnapshot({ codexHome: root, now, fetcher });
  const second = await getUsageSnapshot({ codexHome: root, now: now + MIN_POLL_INTERVAL_MS - 1, fetcher });
  assert.equal(first.source, "live");
  assert.equal(second.source, "cache");
  assert.equal(second.availableCount, 2);
  assert.equal(calls, 1);
  const stored = await readFile(join(root, "cache-statusband-codex", "rate-limits.json"), "utf8");
  assert.match(stored, new RegExp(TEST_EMAIL.replace(".", "\\.")));
  assert.doesNotMatch(stored, /RateLimitResetCredit|account-id|fixture-private-value/);
  await assert.rejects(access(join(root, "cache-statusband-codex", "rate-limits.json.tmp")));
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
  const first = await getUsageSnapshot({ codexHome: root, now, fetcher });
  const second = await getUsageSnapshot({ codexHome: root, now: now + 10 * 60_000, fetcher });
  assert.equal(first.nextAllowedAt, now + 15 * 60_000);
  assert.equal(second.source, "cache");
  assert.equal(calls, 1);
  assert.equal(retryAfterMilliseconds({ rpcData: { retryAfterMs: 45_000 } }, now), 45_000);
  assert.equal(retryAfterMilliseconds({ rpcMessage: "limited; retry after 75 seconds" }, now), 75_000);
});

test("reads the unit of a textual retry-after: minutes and hours as well as seconds and milliseconds", () => {
  const ms = (rpcMessage) => retryAfterMilliseconds({ rpcMessage }, 0);
  assert.equal(ms("rate limited, retry after 30 minutes"), 30 * 60_000);
  assert.equal(ms("rate limited, retry after 2 hours"), 2 * 3_600_000);
  assert.equal(ms("retry-after: 500ms"), 500);
  assert.equal(ms("retry after 45s"), 45_000);
  assert.equal(ms("retry after 10 min"), 10 * 60_000);
  assert.equal(ms("retry after 1.5 h"), 1.5 * 3_600_000);
  assert.equal(ms("retry after 250 milliseconds"), 250);
  assert.equal(ms("retry after 90"), 90_000);
  assert.equal(ms("retry after 5 more seconds"), 5_000);
  assert.equal(ms("retry_after_ms=1500"), 1500);
  assert.equal(ms("Retry-After-Ms: 1500"), 1500);
  assert.equal(ms("retry after ms 1500"), 1500);
  assert.equal(ms("retry after 10 msec"), 10);
  assert.equal(ms("retry after 10 msecs"), 10);
  assert.equal(ms("retry after 90 more"), 90_000);
});

test("caps Retry-After at one hour and keeps the last good reading", async (t) => {
  const root = await fixtureRoot(t);
  const now = Date.parse("2026-10-29T12:00:00.000Z");
  const identity = { key: `seat:${FIRST_SEAT}`, label: `${SEAT_PREFIX} ${FIRST_SEAT}`, unavailable: false };
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
  const fetcher = async () => { calls += 1; return RAW; };

  const firstIdentity = await captureUsageIdentity(root, { env: {} });
  const first = await getUsageSnapshot({ codexHome: root, now, fetcher, env: {}, identity: firstIdentity });
  assert.equal(first.identityKey, `seat:${FIRST_SEAT}`);
  assert.equal(first.availableCount, 2);
  await writeFile(seatPath, `${SECOND_SEAT}\n`, "utf8");

  const firstPresented = await usagePresentation(first, { codexHome: root, env: {}, identity: firstIdentity });
  assert.equal(firstPresented.identity, `${SEAT_PREFIX} ${FIRST_SEAT}`);
  assert.equal(firstPresented.snapshot.primary.usedPercent, 70);
  assert.equal(calls, 1);

  const secondIdentity = await captureUsageIdentity(root, { env: {} });
  const second = await getUsageSnapshot({ codexHome: root, now: now + 1_000, fetcher, env: {}, identity: secondIdentity });
  assert.equal(second.source, "live");
  assert.equal(second.identityKey, `seat:${SECOND_SEAT}`);
  assert.equal(second.availableCount, 2);
  assert.equal(calls, 2);

  await writeFile(seatPath, `${FIRST_SEAT}\n`, "utf8");
  const backToFirst = await getUsageSnapshot({
    codexHome: root,
    now: now + 2_000,
    fetcher,
    env: {},
    identity: await captureUsageIdentity(root, { env: {} }),
  });
  assert.equal(backToFirst.source, "cache");
  assert.equal(backToFirst.identityKey, `seat:${FIRST_SEAT}`);
  assert.equal(calls, 2);
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

test("narrow and no-break spaces in a formatted time become plain spaces", () => {
  assert.equal(plainSpaces("8:22\u202fPM\u00a0UTC"), "8:22 PM UTC");
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

test("falls back to the account email when the configured seat file is missing or empty", async (t) => {
  const root = await fixtureRoot(t);
  const seatPath = join(root, "active-seat.txt");
  await mkdir(join(root, "cache-statusband-codex"), { recursive: true });
  await writeFile(
    join(root, "cache-statusband-codex", "settings.json"),
    `${JSON.stringify({ version: 1, seatFile: seatPath })}\n`,
    "utf8",
  );
  const accountReader = async () => ({ email: TEST_EMAIL });
  for (const content of [null, "  \n"]) {
    if (content !== null) await writeFile(seatPath, content, "utf8");
    const identity = await captureUsageIdentity(root, { env: {}, accountReader });
    assert.deepEqual(identity, { key: `account:${TEST_EMAIL}`, label: TEST_EMAIL, unavailable: false });
    const snapshot = await getUsageSnapshot({ codexHome: root, now: Date.now(), fetcher: async () => RAW, env: {}, identity });
    const presented = await usagePresentation(snapshot, { codexHome: root, env: {}, identity });
    assert.equal(presented.identity, TEST_EMAIL);
    assert.equal(presented.snapshot.availableCount, 2);
    assert.equal(await displayIdentity(snapshot, { codexHome: root, env: {} }), TEST_EMAIL);
  }
});

async function fixtureRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "cache-statusband-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
