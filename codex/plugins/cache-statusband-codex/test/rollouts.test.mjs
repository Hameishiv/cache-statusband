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
import { parseRollout, projectName, scanSessions } from "../src/rollouts.mjs";
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

test("each read in SessionStart ends half a second before the deadline, and gets at least half a second", async (t) => {
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
  // 5000ms deadline: each read may use what remains less the 500ms margin.
  assert.ok(seen[0].timeoutMs >= 500 && seen[0].timeoutMs <= 4_500);
  assert.ok(seen[1].usageTimeout >= 500 && seen[1].usageTimeout <= 4_500);
  // A nearly spent deadline still leaves a read its 500ms floor.
  let late;
  await handleSessionStart({ source: "startup", session_id: "late-session" }, {
    codexHome: root,
    deadlineMs: 300,
    identityGetter: async (_home, options) => { late = options.timeoutMs; return null; },
    usageGetter: async () => ({ availableCount: null }),
  });
  assert.equal(late, 500);
});

test("the SessionStart deadline counts from the hook's start, not from after the transcript read", async (t) => {
  const root = await fixtureRoot(t);
  const started = Date.now();
  await handleSessionStart(
    { source: "startup", session_id: "clock-session", transcript_path: join(root, "rollout.jsonl") },
    {
      codexHome: root,
      deadlineMs: 1_500,
      rolloutParser: async () => { await new Promise((resolve) => setTimeout(resolve, 1_000)); return null; },
      identityGetter: async () => null,
      usageGetter: () => new Promise(() => {}),
    },
  );
  // 1000ms reading plus the 500ms that remain; restarting the clock would take ~2500ms.
  assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started}ms`);
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

// 400ms ends before the 500ms floor a read is given, so the hook (not the reader) has to
// stop the server; but a slow machine may not have started it by then, so that variant only
// checks that nothing is left running IF the server got as far as recording its pid. The
// 1500ms variant always starts the server and so must find its pid.
for (const [deadline, mustStart] of [["400", false], ["1500", true]]) test(`the hook process stops a Codex app-server whose read is still running at the deadline (${deadline}ms)`, async (t) => {
  const root = await fixtureRoot(t);
  const here = dirname(fileURLToPath(import.meta.url));
  const hook = join(here, "..", "hooks", "session-start.mjs");
  const hung = join(here, "..", "fixtures", "hung-app-server.mjs");
  const pidFile = join(root, "hung.pid");
  // The npm shape on Windows (codex.cmd -> cmd.exe -> node), a script elsewhere.
  const launcher = join(root, process.platform === "win32" ? "codex.cmd" : "codex");
  await writeFile(launcher, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${hung}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${hung}" "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, CODEX_HOME: root, CODEX_BIN: launcher, HUNG_PID_FILE: pidFile, CACHE_STATUSBAND_HOOK_DEADLINE_MS: deadline };
  const child = execFile(process.execPath, [hook], { env, timeout: 15_000 });
  child.stdin.end(JSON.stringify({ source: "startup", session_id: "orphan-session" }));
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 0);
  const until = async (condition, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !(await condition())) await new Promise((resolve) => setTimeout(resolve, 50));
    return condition();
  };
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  // The server records its pid once it is up. It must have started (the hook's own read
  // launches it before the deadline); a pid file that never appears means the launch itself
  // failed, which must not pass as "nothing left running".
  const started = await until(async () => (await readFile(pidFile, "utf8").catch(() => "")) !== "", 5_000);
  if (!mustStart && !started) return;
  assert.ok(started, "the Codex app-server never started (no pid file), so the cleanup was not exercised");
  const pid = Number(await readFile(pidFile, "utf8"));
  try {
    assert.ok(await until(() => !alive(pid), 5_000), "the hook left the Codex app-server running");
  } finally {
    if (alive(pid)) process.kill(pid);
  }
});

test("with too little time left for a full three-second read SessionStart asks for the cache only", async (t) => {
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
  // The read itself must get at least MIN_FETCH_BUDGET_MS (3s) after the 500ms margin.
  assert.equal((await run(2_500)).cacheOnly, true);
  assert.equal((await run(3_400)).cacheOnly, true);
  const full = await run(5_000);
  assert.equal(full.cacheOnly, undefined);
  assert.ok(full.timeoutMs >= 3_000);
  // Well clear of the 3.5s threshold, so scheduler delay between the hook's start and its
  // read cannot move it across.
  const edge = await run(4_500);
  assert.equal(edge.cacheOnly, undefined);
  assert.ok(edge.timeoutMs >= 3_000, `a read was given only ${edge.timeoutMs}ms`);
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

test("transcript fields of the wrong type are ignored, so one odd session cannot break the board", async (t) => {
  const root = await fixtureRoot(t);
  const sessions = join(root, "sessions");
  await mkdir(sessions);
  const line = (item) => `${JSON.stringify(item)}\n`;
  const odd = { timestamp: "2026-10-29T12:00:00.000Z", type: "session_meta", payload: { id: 7, cwd: { not: "a path" }, source: "cli" } };
  const oddContext = { timestamp: "2026-10-29T12:01:00.000Z", type: "turn_context", payload: { cwd: ["x"], model: { n: 1 }, effort: 5 } };
  await writeFile(join(sessions, "odd-session.jsonl"), line(odd) + line(oddContext), "utf8");
  await writeFile(join(sessions, "good-session.jsonl"), FIXTURE.filter((item) => typeof item !== "string").map(line).join(""), "utf8");
  const summary = await parseRollout(join(sessions, "odd-session.jsonl"));
  assert.equal(summary.id, "odd-session");
  assert.equal(summary.cwd, null);
  assert.equal(summary.model, null);
  assert.equal(summary.effort, null);
  assert.equal(projectName({ not: "a path" }), "?");

  const { run } = cliRunner(root);
  const plain = await run(["board"]);
  assert.match(plain, /good-session|session-1/);
  assert.match(plain, /example/);
  const json = JSON.parse(await run(["board", "--json"]));
  assert.ok(json.sessions.some((item) => item.id === "session-1" && item.cwd === "/workspace/example"));
});

test("--json output escapes DEL, C1, line/paragraph separator and bidi controls", async (t) => {
  const root = await fixtureRoot(t);
  const sessions = join(root, "sessions");
  await mkdir(sessions);
  const nasty = "a\u007f\u0085b\u009bc\u2028d\u2029e\u202ef\u2066g";
  const meta = { timestamp: "2026-10-29T12:00:00.000Z", type: "session_meta", payload: { id: "evil", cwd: `/w/${nasty}`, source: "cli" } };
  const context = { timestamp: "2026-10-29T12:01:00.000Z", type: "turn_context", payload: { model: nasty, effort: "high" } };
  const path = join(sessions, "evil.jsonl");
  await writeFile(path, `${JSON.stringify(meta)}\n${JSON.stringify(context)}\n`, "utf8");
  const { run } = cliRunner(root);
  for (const [args, pick] of [[["session", path, "--json"], (value) => value], [["board", "--json"], (value) => value.sessions[0]]]) {
    const stdout = await run(args);
    assert.doesNotMatch(stdout, /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/, args[0]);
    assert.match(stdout, /\\u007f/);
    assert.match(stdout, /\\u0085/);
    assert.match(stdout, /\\u202e/);
    // The escapes are still the same string once parsed.
    const parsed = pick(JSON.parse(stdout));
    assert.equal(parsed.cwd, `/w/${nasty}`);
    assert.equal(parsed.model, nasty);
  }
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

// Runs the CLI against a scratch Codex home, with a fake app-server standing in for codex.
function cliRunner(root) {
  const here = dirname(fileURLToPath(import.meta.url));
  const bin = join(here, "..", "bin", "cache-statusband-codex.mjs");
  const server = join(here, "..", "fixtures", "fake-app-server.mjs");
  const windows = process.platform === "win32";
  const wrapper = join(root, windows ? "codex.cmd" : "codex");
  return {
    async run(args, env = {}) {
      await writeFile(wrapper, windows
        ? `@echo off\r\n"${process.execPath}" "${server}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${server}" "$@"\n`, { mode: 0o755 });
      const { stdout } = await promisify(execFile)(process.execPath, [bin, ...args, "--codex-home", root], { env: { ...process.env, CODEX_BIN: wrapper, ...env }, timeout: 20_000 });
      return stdout;
    },
  };
}

async function fixtureRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "cache-statusband-codex-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeFixture(path) {
  await writeFile(path, FIXTURE.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("\n") + "\n", "utf8");
}
