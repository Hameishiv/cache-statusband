import assert from "node:assert/strict";
import { mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renameWithRetry } from "../src/atomic.mjs";
import { loadSessionState, saveSessionState } from "../src/session-state.mjs";
import { getUsageSnapshot } from "../src/usage.mjs";

const TEST_EMAIL = ["person", "example.invalid"].join("@");
const IDENTITY = { key: `account:${TEST_EMAIL}`, label: TEST_EMAIL, unavailable: false };
const RAW = {
  account: { email: TEST_EMAIL },
  rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_793_285_913 } },
  rateLimitResetCredits: { availableCount: 1, credits: [] },
};

async function fixtureRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "cache-statusband-atomic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// A rename that fails with the given code the first `failures` times, then really renames.
function flakyRename(code, failures) {
  const state = { calls: 0 };
  const impl = async (from, to) => {
    state.calls += 1;
    if (state.calls <= failures) throw Object.assign(new Error(`${code}: simulated`), { code });
    return rename(from, to);
  };
  return { impl, state };
}

test("a transient Windows rename failure is retried, other errors are not", async () => {
  const seen = [];
  const flaky = async () => {
    seen.push("try");
    if (seen.length < 3) throw Object.assign(new Error("busy"), { code: seen.length === 1 ? "EBUSY" : "EACCES" });
  };
  await renameWithRetry("a", "b", { rename: flaky, delaysMs: [1, 1, 1] });
  assert.equal(seen.length, 3);

  let calls = 0;
  await assert.rejects(
    renameWithRetry("a", "b", { rename: async () => { calls += 1; throw Object.assign(new Error("gone"), { code: "ENOENT" }); }, delaysMs: [1, 1] }),
    /gone/,
  );
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(
    renameWithRetry("a", "b", { rename: async () => { calls += 1; throw Object.assign(new Error("perm"), { code: "EPERM" }); }, delaysMs: [1, 1, 1] }),
    /perm/,
  );
  assert.equal(calls, 4);
});

test("a cache write that fails twice with EPERM still lands, and the live reading is returned", async (t) => {
  const root = await fixtureRoot(t);
  const { impl, state } = flakyRename("EPERM", 2);
  const snapshot = await getUsageSnapshot({
    codexHome: root, now: Date.parse("2026-10-29T12:00:00.000Z"), identity: IDENTITY,
    fetcher: async () => RAW, renameImpl: impl,
  });
  assert.equal(snapshot.source, "live");
  assert.equal(snapshot.primary.usedPercent, 40);
  assert.ok(state.calls >= 3);
  const files = await readdir(join(root, "cache-statusband-codex"));
  assert.ok(files.some((name) => /^rate-limits-.*\.json$/.test(name)));
  assert.ok(!files.some((name) => name.endsWith(".tmp")));
});

test("a cache that can never be written sends no rate-limit request and leaves no temp file", async (t) => {
  const root = await fixtureRoot(t);
  const failing = async () => { throw Object.assign(new Error("EPERM: simulated"), { code: "EPERM" }); };
  let requests = 0;
  const snapshot = await getUsageSnapshot({
    codexHome: root, now: Date.parse("2026-10-29T12:00:00.000Z"), identity: IDENTITY,
    fetcher: async () => { requests += 1; return RAW; }, renameImpl: failing,
  });
  // The attempt marker is what throttles other callers; without it no live read is made.
  assert.equal(requests, 0);
  assert.equal(snapshot.source, "stale");
  assert.equal(snapshot.availableCount, null);
  const files = await readdir(join(root, "cache-statusband-codex"));
  assert.ok(!files.some((name) => name.endsWith(".tmp")), files.join(","));
  assert.ok(!files.some((name) => /^rate-limits-.*\.json$/.test(name)));
});

test("a cache that stops being writable after the attempt marker still returns the live reading", async (t) => {
  const root = await fixtureRoot(t);
  let renames = 0;
  const failAfterMarker = async (from, to) => {
    renames += 1;
    if (renames > 1) throw Object.assign(new Error("EPERM: simulated"), { code: "EPERM" });
    return rename(from, to);
  };
  const snapshot = await getUsageSnapshot({
    codexHome: root, now: Date.parse("2026-10-29T12:00:00.000Z"), identity: IDENTITY,
    fetcher: async () => RAW, renameImpl: failAfterMarker,
  });
  assert.equal(snapshot.source, "live");
  assert.equal(snapshot.availableCount, 1);
  const files = await readdir(join(root, "cache-statusband-codex"));
  assert.ok(!files.some((name) => name.endsWith(".tmp")), files.join(","));
});

test("a session-state save retries a transient rename failure and cleans up when it keeps failing", async (t) => {
  const root = await fixtureRoot(t);
  const summary = { contextUsed: 10, contextWindow: 100, tokenReportAt: "2026-10-29T12:00:00.000Z", model: "m", effort: "high" };
  const { impl } = flakyRename("EBUSY", 2);
  assert.equal(await saveSessionState(root, "retry-session", summary, Date.now(), { renameImpl: impl }), true);
  assert.equal((await loadSessionState(root, "retry-session")).contextUsed, 10);

  const failing = async () => { throw Object.assign(new Error("EBUSY: simulated"), { code: "EBUSY" }); };
  await assert.rejects(saveSessionState(root, "never-session", summary, Date.now(), { renameImpl: failing }), /EBUSY/);
  const dir = join(root, "cache-statusband-codex", "sessions");
  const files = await readdir(dir);
  assert.ok(!files.some((name) => name.endsWith(".tmp")), files.join(","));
});
