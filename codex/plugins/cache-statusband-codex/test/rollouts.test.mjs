import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { handleSessionStart } from "../hooks/session-start.mjs";
import { handleStop } from "../hooks/stop.mjs";
import { parseRollout, scanSessions } from "../src/rollouts.mjs";
import { getSessionIdentity, loadSessionState, saveSessionState } from "../src/session-state.mjs";

const FIXTURE = [
  { timestamp: "2026-10-29T12:00:00.000Z", type: "session_meta", payload: { id: "session-1", timestamp: "2026-10-29T12:00:00.000Z", cwd: "/workspace/example", source: "cli", context_window: 200000 } },
  { timestamp: "2026-10-29T12:01:00.000Z", type: "turn_context", payload: { cwd: "/workspace/example", model: "gpt-test-sol", effort: "high" } },
  "{malformed",
  { timestamp: "2026-10-29T12:02:00.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 12000 }, total_token_usage: { input_tokens: 14000, cached_input_tokens: 7000, output_tokens: 1000, total_tokens: 15000 }, model_context_window: 200000 } } },
  { timestamp: "2026-10-29T12:03:00.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 25000 }, total_token_usage: { input_tokens: 28000, cached_input_tokens: 9000, output_tokens: 2000, total_tokens: 30000 }, model_context_window: 200000 } } },
];

test("parses the latest token count and ignores malformed or prompt records", async (t) => {
  const root = await fixtureRoot(t);
  const path = join(root, "rollout.jsonl");
  await writeFixture(path);
  const summary = await parseRollout(path);
  assert.equal(summary.id, "session-1");
  assert.equal(summary.model, "gpt-test-sol");
  assert.equal(summary.effort, "high");
  assert.equal(summary.contextUsed, 25000);
  assert.equal(summary.contextWindow, 200000);
  assert.equal(summary.totalUsage.cachedInputTokens, 9000);
  assert.equal(summary.totalUsage.totalTokens, 30000);
});

test("reads metadata from the head and token state from the tail of a large rollout", async (t) => {
  const root = await fixtureRoot(t);
  const path = join(root, "large.jsonl");
  const filler = `${JSON.stringify({ type: "response_item", payload: { type: "message", content: "x".repeat(2048) } })}\n`.repeat(1300);
  const head = `${JSON.stringify(FIXTURE[0])}\n${JSON.stringify(FIXTURE[1])}\n`;
  const tail = `${JSON.stringify(FIXTURE.at(-1))}\n`;
  await writeFile(path, head + filler + tail, "utf8");
  const summary = await parseRollout(path);
  assert.equal(summary.id, "session-1");
  assert.equal(summary.contextUsed, 25000);
});

test("scans active sessions and includes archived sessions only when requested", async (t) => {
  const root = await fixtureRoot(t);
  await mkdir(join(root, "sessions", "2026", "10"), { recursive: true });
  await mkdir(join(root, "archived_sessions"), { recursive: true });
  await writeFixture(join(root, "sessions", "2026", "10", "active.jsonl"));
  await writeFixture(join(root, "archived_sessions", "old.jsonl"));
  assert.equal((await scanSessions(root)).length, 1);
  const all = await scanSessions(root, { includeArchived: true });
  assert.equal(all.length, 2);
  assert.deepEqual(new Set(all.map((item) => item.archived)), new Set([true, false]));
});

test("board limits transcript reads to recent candidates and skips files lost during scanning", async (t) => {
  const root = await fixtureRoot(t);
  const sessions = join(root, "sessions");
  await mkdir(sessions);
  const paths = ["old.jsonl", "recent.jsonl", "newest.jsonl"].map((name) => join(sessions, name));
  for (const [index, path] of paths.entries()) {
    await writeFixture(path);
    const time = new Date(Date.parse("2026-10-29T12:00:00.000Z") + index * 60_000);
    await utimes(path, time, time);
  }
  const reads = [];
  const found = await scanSessions(root, {
    limit: 1,
    rolloutParser: async (path) => {
      reads.push(path);
      if (path === paths[2]) throw new Error("session moved after stat");
      return { id: path, updatedAt: "2026-10-29T12:00:00.000Z" };
    },
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].id, paths[1]);
  assert.deepEqual(reads, [paths[2], paths[1]]);
});

test("SessionStart hook returns a visible, truthful resume summary", async (t) => {
  const root = await fixtureRoot(t);
  const path = join(root, "rollout.jsonl");
  await writeFixture(path);
  const testEmail = ["person", "example.invalid"].join("@");
  await getSessionIdentity(root, "session-1", async () => ({ key: `account:${testEmail}`, label: testEmail, unavailable: false }));
  const output = await handleSessionStart(
    { source: "resume", session_id: "session-1", transcript_path: path },
    {
      codexHome: root,
      now: Date.parse("2026-10-29T12:04:00.000Z"),
      identityGetter: async () => ({ key: `account:${testEmail}`, label: testEmail, unavailable: false }),
      usageGetter: async () => ({ identityKey: `account:${testEmail}`, accountEmail: testEmail, availableCount: 2, credits: [], fetchedAt: Date.parse("2026-10-29T12:04:00.000Z"), source: "live" }),
    },
  );
  assert.match(output.systemMessage, /saved context 25k\/200k \(13%\)/);
  assert.match(output.systemMessage, /Prompt-cache warm\/cold state is not exposed/);
  assert.match(output.systemMessage, /Banked resets: 2/);
  assert.match(output.systemMessage, new RegExp(`Account: ${testEmail.replace(".", "\\.")}`));
  assert.deepEqual(await handleSessionStart({ source: "compact", transcript_path: path }), {});
});

test("Stop saves a small context snapshot and SessionStart falls back to it", async (t) => {
  const root = await fixtureRoot(t);
  const contextAt = "2026-10-29T12:03:00.000Z";
  const summary = {
    model: "gpt-test-sol",
    effort: "high",
    tokenReportAt: contextAt,
    contextUsed: 25000,
    contextWindow: 200000,
  };
  await handleStop(
    { session_id: "session-1", transcript_path: join(root, "too-large.jsonl") },
    { codexHome: root, now: Date.parse(contextAt), rolloutParser: async () => summary },
  );
  const saved = await loadSessionState(root, "session-1");
  assert.equal(saved.contextUsed, 25000);
  assert.equal(saved.contextWindow, 200000);
  assert.equal(saved.contextAt, contextAt);
  assert.deepEqual(Object.keys(saved).sort(), ["contextAt", "contextUsed", "contextWindow", "effort", "model", "savedAt", "version"]);

  const output = await handleSessionStart(
    { source: "resume", session_id: "session-1", transcript_path: join(root, "too-large.jsonl") },
    {
      codexHome: root,
      now: Date.parse("2026-10-29T12:04:00.000Z"),
      rolloutParser: async () => { throw new Error("transcript unavailable"); },
      identityGetter: async () => null,
      usageGetter: async () => ({ availableCount: null, source: "cache" }),
    },
  );
  assert.match(output.systemMessage, /saved context 25k\/200k \(13%\)/);
  assert.match(output.systemMessage, /last token report 1m ago/);
});

test("an older Stop result cannot replace a newer saved context snapshot", async (t) => {
  const root = await fixtureRoot(t);
  const newer = { contextUsed: 50000, contextWindow: 200000, tokenReportAt: "2026-10-29T13:00:00.000Z" };
  const older = { contextUsed: 25000, contextWindow: 200000, tokenReportAt: "2026-10-29T12:00:00.000Z" };
  assert.equal(await saveSessionState(root, "session-1", newer), true);
  assert.equal(await saveSessionState(root, "session-1", older), false);
  assert.equal((await loadSessionState(root, "session-1")).contextUsed, 50000);
});

test("resuming a session retains its starting identity after account rotation", async (t) => {
  const root = await fixtureRoot(t);
  const path = join(root, "rollout.jsonl");
  await writeFixture(path);
  const email = ["initial", "example.invalid"].join("@");
  const original = { key: `account:${email}`, label: ["Seat", "fixture-start"].join(" "), unavailable: false };
  let captures = 0;
  const options = {
    codexHome: root,
    identityGetter: async () => { captures += 1; return original; },
    usageGetter: async ({ identity }) => {
      assert.deepEqual(identity, original);
      return { identityKey: original.key, accountEmail: email, availableCount: 2 };
    },
  };
  const startup = await handleSessionStart({ source: "startup", session_id: "stable-session", transcript_path: path }, options);
  const resumed = await handleSessionStart({ source: "resume", session_id: "stable-session", transcript_path: path }, {
    ...options,
    identityGetter: async () => { throw new Error("must not recapture a resumed account"); },
  });
  assert.ok(startup.systemMessage.includes(original.label));
  assert.ok(resumed.systemMessage.includes(original.label));
  assert.match(resumed.systemMessage, /Banked resets: 2/);
  assert.equal(captures, 1);
  const files = await readdir(join(root, "cache-statusband-codex", "sessions"));
  const record = JSON.parse(await readFile(join(root, "cache-statusband-codex", "sessions", files.find((file) => file.endsWith(".identity.json"))), "utf8"));
  assert.deepEqual(record, { version: 1, identity: original });
});

test("concurrent session starts publish only one complete starting identity", async (t) => {
  const root = await fixtureRoot(t);
  const identity = (name) => {
    const email = [name, "example.invalid"].join("@");
    return { key: `account:${email}`, label: email, unavailable: false };
  };
  const first = identity("first");
  const second = identity("second");
  // B passes the "no record yet" check and then stalls inside its capture while A
  // captures and publishes. B must then lose: a later publisher cannot replace the winner.
  let reachedB;
  const bReached = new Promise((resolve) => { reachedB = resolve; });
  let releaseB;
  const gate = new Promise((resolve) => { releaseB = resolve; });
  const pendingB = getSessionIdentity(root, "shared-session", async () => {
    reachedB();
    await gate;
    return second;
  });
  await bReached;
  const winner = await getSessionIdentity(root, "shared-session", async () => first);
  releaseB();
  const loser = await pendingB;
  assert.deepEqual(winner, first);
  assert.deepEqual(loser, first);
  assert.deepEqual(await getSessionIdentity(root, "shared-session", async () => { throw new Error("must not recapture"); }), first);
});

test("an unknown starting identity remains unknown rather than adopting a later login", async (t) => {
  const root = await fixtureRoot(t);
  assert.equal(await getSessionIdentity(root, "unknown-session", async () => null), null);
  assert.equal(await getSessionIdentity(root, "unknown-session", async () => { throw new Error("must not adopt a new login"); }), null);
});

test("a legacy resumed session without identity state does not adopt today's login", async (t) => {
  const root = await fixtureRoot(t);
  const output = await handleSessionStart({ source: "resume", session_id: "legacy-session", transcript_path: "missing.jsonl" }, {
    codexHome: root,
    identityGetter: async () => { throw new Error("cannot infer a historical login"); },
    rolloutParser: async () => null,
    usageGetter: async ({ identity }) => {
      assert.equal(identity, null);
      return { availableCount: null };
    },
  });
  assert.deepEqual(output, {});
  assert.equal(await getSessionIdentity(root, "legacy-session", async () => { throw new Error("must remain unknown"); }), null);
});

test("a hung identity or usage read cannot hold back the resume summary past the deadline", async (t) => {
  const root = await fixtureRoot(t);
  const path = join(root, "rollout.jsonl");
  await writeFixture(path);
  const started = Date.now();
  const output = await handleSessionStart(
    { source: "startup", session_id: "slow-session", transcript_path: path },
    {
      codexHome: root,
      now: Date.parse("2026-10-29T12:04:00.000Z"),
      deadlineMs: 150,
      identityGetter: () => new Promise(() => {}),
      usageGetter: () => new Promise(() => {}),
    },
  );
  assert.ok(Date.now() - started < 3_000);
  assert.match(output.systemMessage, /saved context 25k\/200k/);
});

test("each read in SessionStart gets at least a second and no more than what remains of the deadline", async (t) => {
  const root = await fixtureRoot(t);
  const seen = [];
  const email = ["person", "example.invalid"].join("@");
  await handleSessionStart({ source: "startup", session_id: "budget-session" }, {
    codexHome: root,
    deadlineMs: 5_000,
    identityGetter: async (_home, options) => {
      seen.push(options);
      return { key: `account:${email}`, label: email, unavailable: false };
    },
    usageGetter: async ({ timeoutMs }) => {
      seen.push({ usageTimeout: timeoutMs });
      return { availableCount: null };
    },
  });
  assert.equal(seen[0].throwOnFailure, true);
  assert.ok(seen[0].timeoutMs >= 1_000 && seen[0].timeoutMs <= 5_000);
  assert.ok(seen[1].usageTimeout >= 1_000 && seen[1].usageTimeout <= 5_000);
});

test("the SessionStart deadline counts from the hook's start, not from after the transcript read", async (t) => {
  const root = await fixtureRoot(t);
  const started = Date.now();
  await handleSessionStart(
    { source: "startup", session_id: "clock-session", transcript_path: join(root, "rollout.jsonl") },
    {
      codexHome: root,
      deadlineMs: 800,
      rolloutParser: async () => { await new Promise((resolve) => setTimeout(resolve, 500)); return null; },
      identityGetter: async () => null,
      usageGetter: () => new Promise(() => {}),
    },
  );
  // 500ms reading plus the 300ms that remain; restarting the clock would take ~1300ms.
  assert.ok(Date.now() - started < 1_100, `took ${Date.now() - started}ms`);
});

test("the SessionStart hook process prints its answer and exits", async () => {
  const hook = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "session-start.mjs");
  const child = execFile(process.execPath, [hook], { timeout: 10_000 });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stdin.end(JSON.stringify({ source: "clear" }));
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 0);
  assert.equal(stdout, "{}\n");
});

test("with under three seconds left SessionStart asks for the cache only", async (t) => {
  const root = await fixtureRoot(t);
  const email = ["person", "example.invalid"].join("@");
  const run = async (deadlineMs) => {
    let received;
    await handleSessionStart({ source: "startup", session_id: `cache-only-${deadlineMs}` }, {
      codexHome: root,
      deadlineMs,
      identityGetter: async () => ({ key: `account:${email}`, label: email, unavailable: false }),
      usageGetter: async (options) => { received = options; return { availableCount: null }; },
    });
    return received;
  };
  assert.equal((await run(2_500)).cacheOnly, true);
  assert.equal((await run(5_000)).cacheOnly, undefined);
});

test("usage still shows when the hook input has no transcript path", async (t) => {
  const root = await fixtureRoot(t);
  const email = ["person", "example.invalid"].join("@");
  const output = await handleSessionStart({ source: "startup", session_id: "no-transcript" }, {
    codexHome: root,
    identityGetter: async () => ({ key: `account:${email}`, label: email, unavailable: false }),
    usageGetter: async () => ({ identityKey: `account:${email}`, accountEmail: email, availableCount: 3, source: "live", fetchedAt: Date.now() }),
  });
  assert.match(output.systemMessage, /Banked resets: 3/);
  assert.doesNotMatch(output.systemMessage, /restored/);
});

test("a failed identity capture records nothing, so a later start can still bind the login", async (t) => {
  const root = await fixtureRoot(t);
  const email = ["person", "example.invalid"].join("@");
  const identity = { key: `account:${email}`, label: email, unavailable: false };
  assert.equal(await getSessionIdentity(root, "flaky-session", async () => { throw new Error("app-server down"); }), null);
  assert.deepEqual(await readdir(join(root, "cache-statusband-codex", "sessions")).catch(() => []), []);
  assert.deepEqual(await getSessionIdentity(root, "flaky-session", async () => identity), identity);
});

test("a startup whose account read fails reports nothing and persists no identity", async (t) => {
  const root = await fixtureRoot(t);
  const output = await handleSessionStart({ source: "startup", session_id: "failing-start" }, {
    codexHome: root,
    identityGetter: async () => { throw new Error("app-server down"); },
    usageGetter: async ({ identity }) => {
      assert.equal(identity, null);
      return { availableCount: null };
    },
  });
  assert.deepEqual(output, {});
  const files = await readdir(join(root, "cache-statusband-codex", "sessions")).catch(() => []);
  assert.deepEqual(files.filter((name) => name.endsWith(".identity.json")), []);
});

test("Stop waits briefly for another save's lock, then skips; a stale lock is reclaimed", async (t) => {
  const root = await fixtureRoot(t);
  const summary = { contextUsed: 10, contextWindow: 100, tokenReportAt: "2026-10-29T12:00:00.000Z" };
  await mkdir(join(root, "cache-statusband-codex", "sessions"), { recursive: true });
  // Learn the lock name by saving once, then plant a held lock beside the state file.
  assert.equal(await saveSessionState(root, "locked-session", summary), true);
  const dir = join(root, "cache-statusband-codex", "sessions");
  const stateName = (await readdir(dir)).find((name) => name.endsWith(".json") && !name.endsWith(".identity.json"));
  const lockPath = join(dir, `${stateName}.lock`);
  await writeFile(lockPath, "another-hook");
  const newer = { ...summary, contextUsed: 20, tokenReportAt: "2026-10-29T13:00:00.000Z" };
  const waitStarted = Date.now();
  assert.equal(await saveSessionState(root, "locked-session", newer), false);
  // Five retries at 50ms: it waited for the holder before giving up.
  assert.ok(Date.now() - waitStarted >= 200, "gave up without retrying");
  assert.equal((await loadSessionState(root, "locked-session")).contextUsed, 10);
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);
  assert.equal(await saveSessionState(root, "locked-session", newer), true);
  assert.equal((await loadSessionState(root, "locked-session")).contextUsed, 20);
});

test("Stop saves once a briefly held lock is released", async (t) => {
  const root = await fixtureRoot(t);
  const summary = { contextUsed: 10, contextWindow: 100, tokenReportAt: "2026-10-29T12:00:00.000Z" };
  assert.equal(await saveSessionState(root, "busy-session", summary), true);
  const dir = join(root, "cache-statusband-codex", "sessions");
  const stateName = (await readdir(dir)).find((name) => name.endsWith(".json") && !name.endsWith(".identity.json"));
  const lockPath = join(dir, `${stateName}.lock`);
  await writeFile(lockPath, "another-hook");
  setTimeout(() => rm(lockPath, { force: true }), 80);
  const newer = { ...summary, contextUsed: 20, tokenReportAt: "2026-10-29T13:00:00.000Z" };
  assert.equal(await saveSessionState(root, "busy-session", newer), true);
  assert.equal((await loadSessionState(root, "busy-session")).contextUsed, 20);
});

test("a truncated rollout takes only identity from its head and everything else from its tail", async (t) => {
  const root = await fixtureRoot(t);
  const path = join(root, "huge.jsonl");
  const line = (value) => `${JSON.stringify(value)}\n`;
  const headOnlyTokens = { timestamp: "2026-10-29T09:00:00.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 111 }, model_context_window: 999 } } };
  const head = line(FIXTURE[0]) + line(FIXTURE[1]) + line(headOnlyTokens);
  const filler = line({ type: "response_item", payload: { type: "message", content: "x".repeat(2048) } }).repeat(1300);
  const tail = line({ timestamp: "2026-10-29T15:00:00.000Z", type: "response_item", payload: { type: "message", content: "y" } });
  await writeFile(path, head + filler + tail, "utf8");
  const summary = await parseRollout(path);
  assert.equal(summary.cwd, "/workspace/example");
  assert.equal(summary.model, "gpt-test-sol");
  assert.equal(summary.createdAt, "2026-10-29T12:00:00.000Z");
  assert.equal(summary.contextUsed, null, "a token report that only the head holds is not current");
  assert.equal(summary.tokenReportAt, null);
  assert.equal(summary.updatedAt, "2026-10-29T15:00:00.000Z");

  // With no timestamped tail record, the file's mtime is the best "updated" evidence.
  const mtime = new Date("2026-10-30T08:00:00.000Z");
  await writeFile(path, head + filler, "utf8");
  await utimes(path, mtime, mtime);
  assert.equal((await parseRollout(path)).updatedAt, mtime.toISOString());
});

test("rate limits are reduced to numeric primary/secondary window fields", async (t) => {
  const root = await fixtureRoot(t);
  const path = join(root, "limits.jsonl");
  const report = { timestamp: "2026-10-29T12:02:00.000Z", type: "event_msg", payload: { type: "token_count", info: {
    last_token_usage: { total_tokens: 5 },
    rate_limits: {
      primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1793285913, label: "\u001b[31mevil", nested: { a: 1 } },
      secondary: { used_percent: 3 },
      credits: { balance: "unlimited" },
      prompt: "do not keep",
    },
  } } };
  await writeFile(path, `${JSON.stringify(report)}\n`, "utf8");
  assert.deepEqual((await parseRollout(path)).rateLimits, {
    primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1793285913 },
    secondary: { used_percent: 3 },
  });
});

test("a rate-limit window with no numeric fields is omitted, and no windows means null", async (t) => {
  const root = await fixtureRoot(t);
  const reportWith = (rate_limits) => `${JSON.stringify({ timestamp: "2026-10-29T12:02:00.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 5 }, rate_limits } } })}\n`;
  const some = join(root, "some.jsonl");
  await writeFile(some, reportWith({ primary: { label: "text only", nested: { a: 1 } }, secondary: { used_percent: 3 } }), "utf8");
  assert.deepEqual((await parseRollout(some)).rateLimits, { secondary: { used_percent: 3 } });
  const none = join(root, "none.jsonl");
  await writeFile(none, reportWith({ primary: { label: "text only" }, secondary: {} }), "utf8");
  assert.equal((await parseRollout(none)).rateLimits, null);
});

test("the CLI strips terminal control characters from transcript-derived fields", async (t) => {
  const root = await fixtureRoot(t);
  const path = join(root, "evil.jsonl");
  const meta = { timestamp: "2026-10-29T12:00:00.000Z", type: "session_meta", payload: { id: "id\u009b31m", cwd: "/w/\u001b]0;pwn\u0007dir\u009b", source: "cli" } };
  const context = { timestamp: "2026-10-29T12:01:00.000Z", type: "turn_context", payload: { model: "m\u001b[2Jodel", effort: "hi\u0085gh" } };
  await writeFile(path, `${JSON.stringify(meta)}\n${JSON.stringify(context)}\n`, "utf8");
  const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "cache-statusband-codex.mjs");
  const { stdout } = await promisify(execFile)(process.execPath, [bin, "session", path]);
  assert.doesNotMatch(stdout, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  assert.match(stdout, /model/i);
});

test("usage --json and board --json omit the email and account key when a seat is configured", async (t) => {
  const root = await fixtureRoot(t);
  const here = dirname(fileURLToPath(import.meta.url));
  const bin = join(here, "..", "bin", "cache-statusband-codex.mjs");
  const server = join(here, "..", "fixtures", "fake-app-server.mjs");
  const windows = process.platform === "win32";
  const wrapper = join(root, windows ? "codex.cmd" : "codex");
  await writeFile(wrapper, windows
    ? `@echo off\r\n"${process.execPath}" "${server}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${server}" "$@"\n`, { mode: 0o755 });
  const seat = join(root, "seat.txt");
  await writeFile(seat, "alpha");
  const run = async (args, env) => {
    const { stdout } = await promisify(execFile)(process.execPath, [bin, ...args, "--json", "--codex-home", root], { env: { ...process.env, CODEX_BIN: wrapper, ...env } });
    return stdout;
  };
  const email = ["test", "example.invalid"].join("@");

  const withSeat = { CACHE_STATUSBAND_CODEX_SEAT_FILE: seat };
  const usage = await run(["usage"], withSeat);
  assert.equal(JSON.parse(usage).availableCount, 2);
  assert.doesNotMatch(usage, /accountEmail|identityKey|test@example|account:/);
  const board = await run(["board"], withSeat);
  assert.equal(JSON.parse(board).usage.availableCount, 2);
  assert.doesNotMatch(board, /accountEmail|identityKey|test@example|account:/);

  // Without a seat the email is the displayed identity and stays in the JSON.
  const plain = JSON.parse(await run(["usage"], { CACHE_STATUSBAND_CODEX_SEAT_FILE: "" }));
  assert.equal(plain.accountEmail, email);
});

async function fixtureRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "cache-statusband-codex-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeFixture(path) {
  await writeFile(path, FIXTURE.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("\n") + "\n", "utf8");
}
