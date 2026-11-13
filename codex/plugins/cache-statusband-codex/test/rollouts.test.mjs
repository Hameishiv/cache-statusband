import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdtemp, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

test("a later turn_context sets model and effort from that record alone, never keeping an earlier turn's effort", async (t) => {
  const root = await fixtureRoot(t);
  const path = join(root, "two-contexts.jsonl");
  const line = (item) => `${JSON.stringify(item)}
`;
  const first = { timestamp: "2026-10-29T12:01:00.000Z", type: "turn_context", payload: { cwd: "/workspace/example", model: "model-A", effort: "high" } };
  const second = { timestamp: "2026-10-29T13:01:00.000Z", type: "turn_context", payload: { cwd: "/workspace/example", model: "model-B" } };
  await writeFile(path, line(FIXTURE[0]) + line(first) + line(second), "utf8");
  const summary = await parseRollout(path);
  assert.equal(summary.model, "model-B");
  assert.equal(summary.effort, null);
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
  // A resume describes the account the session STARTED under, not a current login.
  assert.match(output.systemMessage, /Banked resets \(starting account\): 2/);
  assert.match(output.systemMessage, new RegExp(`Started as ${testEmail.replace(".", "\\.")}\\.`));
  assert.doesNotMatch(output.systemMessage, /Account:/);
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
  assert.match(startup.systemMessage, /Banked resets: 2/);
  assert.match(resumed.systemMessage, /Banked resets \(starting account\): 2/);
  assert.ok(resumed.systemMessage.includes(`Started as ${original.label}.`));
  assert.ok(!startup.systemMessage.includes("Started as"));
  assert.equal(captures, 1);
  const files = await readdir(join(root, "cache-statusband-codex", "sessions"));
  const record = JSON.parse(await readFile(join(root, "cache-statusband-codex", "sessions", files.find((file) => file.endsWith(".identity.json"))), "utf8"));
  assert.deepEqual(record, { version: 1, identity: original });
});

test("a resume never shows a recorded email once a seat is configured, available or not", async (t) => {
  const root = await fixtureRoot(t);
  const email = ["recorded", "example.invalid"].join("@");
  const recorded = { key: `account:${email}`, label: email, unavailable: false };
  const settings = join(root, "cache-statusband-codex", "settings.json");
  const options = {
    codexHome: root,
    rolloutParser: async () => null,
    identityGetter: async () => recorded,
    usageGetter: async () => ({ identityKey: recorded.key, accountEmail: email, availableCount: 2 }),
  };
  const resume = () => handleSessionStart({ source: "resume", session_id: "privacy-session", transcript_path: "missing.jsonl" }, options);

  // Started with no seat configured: the record holds the email as its label.
  const startup = await handleSessionStart({ source: "startup", session_id: "privacy-session" }, options);
  assert.match(startup.systemMessage, new RegExp(`Account: ${email}`));
  assert.match((await resume()).systemMessage, new RegExp(`Started as ${email}`), "no seat configured: the recorded login is shown, as the starting account");

  // Resumed after settings.json became unreadable: a seat may be configured, so no email.
  await writeFile(settings, "{not json");
  const malformed = await resume();
  assert.doesNotMatch(malformed.systemMessage, /example\.invalid|Account:|Started as/);
  assert.match(malformed.systemMessage, /Banked resets \(starting account\): 2/);

  // Resumed once a valid seat file is configured: the seat label is not the recorded identity.
  const seat = join(root, "seat.txt");
  await writeFile(seat, "alpha");
  await writeFile(settings, JSON.stringify({ version: 1, seatFile: seat }));
  const seated = await resume();
  assert.doesNotMatch(seated.systemMessage, /example\.invalid|Account:|Started as/);
  assert.match(seated.systemMessage, /Banked resets \(starting account\): 2/);

  // The seat is unavailable (its file is missing): still no email.
  await writeFile(seat, "");
  assert.doesNotMatch((await resume()).systemMessage, /example\.invalid/);
});

test("a resume still shows a recorded seat label, whatever seat is configured now", async (t) => {
  const root = await fixtureRoot(t);
  const email = ["recorded", "example.invalid"].join("@");
  const recorded = { key: `account:${email}`, label: "Seat first", unavailable: false };
  const seat = join(root, "seat.txt");
  await writeFile(seat, "second");
  await mkdir(join(root, "cache-statusband-codex"), { recursive: true });
  await writeFile(join(root, "cache-statusband-codex", "settings.json"), JSON.stringify({ version: 1, seatFile: seat }));
  const output = await handleSessionStart({ source: "startup", session_id: "seat-session" }, {
    codexHome: root,
    identityGetter: async () => recorded,
    usageGetter: async () => ({ identityKey: recorded.key, accountEmail: email, availableCount: 2 }),
  });
  assert.match(output.systemMessage, /Seat first\./);
  assert.doesNotMatch(output.systemMessage, /example\.invalid/);
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

test("a record that cannot be linked is tried again, then yields to a concurrent winner, then is left unrecorded", async (t) => {
  const email = (name) => [name, "example.invalid"].join("@");
  const identityOf = (name) => ({ key: `account:${email(name)}`, label: email(name), unavailable: false });
  const refused = (code) => Object.assign(new Error(code), { code });

  // A momentary refusal: the second try publishes the record.
  const first = await fixtureRoot(t);
  let tries = 0;
  const linkOnce = async (from, to) => { tries += 1; if (tries === 1) throw refused("EBUSY"); return (await import("node:fs/promises")).link(from, to); };
  assert.deepEqual(await getSessionIdentity(first, "s", async () => identityOf("mine"), { linkImpl: linkOnce }), identityOf("mine"));
  assert.equal(tries, 2);
  assert.deepEqual(await getSessionIdentity(first, "s", async () => identityOf("later")), identityOf("mine"), "the record was saved");

  // A refusal that persists while another start has published a record: that record wins.
  const second = await fixtureRoot(t);
  const sessionsDir = join(second, "cache-statusband-codex", "sessions");
  const winnerThenRefuse = async () => {
    const [name] = (await readdir(sessionsDir)).filter((file) => file.endsWith(".tmp"));
    await writeFile(join(sessionsDir, name.replace(/\.[0-9a-f-]+\.tmp$/, "")), `${JSON.stringify({ version: 1, identity: identityOf("winner") })}\n`);
    throw refused("EPERM");
  };
  assert.deepEqual(await getSessionIdentity(second, "s", async () => identityOf("loser"), { linkImpl: winnerThenRefuse }), identityOf("winner"));

  // A refusal that persists while a record that cannot be parsed sits there: unknown, never today's login.
  const corrupt = await fixtureRoot(t);
  const corruptDir = join(corrupt, "cache-statusband-codex", "sessions");
  const corruptThenRefuse = async () => {
    const [name] = (await readdir(corruptDir)).filter((file) => file.endsWith(".tmp"));
    await writeFile(join(corruptDir, name.replace(/\.[0-9a-f-]+\.tmp$/, "")), "{not json");
    throw refused("ENOSPC");
  };
  assert.equal(await getSessionIdentity(corrupt, "s", async () => identityOf("today"), { linkImpl: corruptThenRefuse }), null);

  // A refusal that persists with nothing there: the login is used now, unrecorded.
  const third = await fixtureRoot(t);
  let attempts = 0;
  const alwaysRefuse = async () => { attempts += 1; throw refused("EPERM"); };
  assert.deepEqual(await getSessionIdentity(third, "s", async () => identityOf("mine"), { linkImpl: alwaysRefuse }), identityOf("mine"));
  assert.equal(attempts, 3, "tried once and retried twice");
  assert.deepEqual((await readdir(join(third, "cache-statusband-codex", "sessions"))).filter((file) => file.endsWith(".identity.json") || file.endsWith(".tmp")), []);
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

test("a transcript read that never finishes cannot push the hook past its deadline, and the usage still shows", async (t) => {
  const root = await fixtureRoot(t);
  const email = ["person", "example.invalid"].join("@");
  const identity = { key: `account:${email}`, label: "Seat slow", unavailable: false };
  const started = Date.now();
  const output = await handleSessionStart(
    { source: "startup", session_id: "slow-transcript", transcript_path: join(root, "rollout.jsonl") },
    {
      codexHome: root,
      deadlineMs: 1_500,
      rolloutParser: () => new Promise(() => {}),
      identityGetter: async () => identity,
      usageGetter: async () => ({ identityKey: identity.key, accountEmail: email, availableCount: 3 }),
    },
  );
  assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started}ms`);
  assert.match(output.systemMessage, /Banked resets: 3/);
  assert.doesNotMatch(output.systemMessage, /restored/);
});

test("the SessionStart deadline can be measured from an earlier start than the call", async (t) => {
  const root = await fixtureRoot(t);
  const started = Date.now();
  // The hook process started 1,200ms ago (Node start-up, waiting for stdin): of a 1,500ms
  // deadline only about 300ms remain, so a read that never finishes is cut off by then.
  const output = await handleSessionStart(
    { source: "startup", session_id: "early-start", transcript_path: join(root, "rollout.jsonl") },
    {
      codexHome: root,
      deadlineMs: 1_500,
      startedAt: Date.now() - 1_200,
      rolloutParser: () => new Promise(() => {}),
      identityGetter: () => new Promise(() => {}),
      usageGetter: () => new Promise(() => {}),
    },
  );
  assert.ok(Date.now() - started < 1_400, `took ${Date.now() - started}ms`);
  assert.deepEqual(output, {});
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

// 400ms ends before the 500ms floor a read is given, so the hook (not the reader) has to stop the
// server: it must have started (its pid file appears) and be gone BEFORE the hook process ends.
// A child started by a hook dies with the hook process on its own, so "gone after the hook has
// exited" would hold even with the disposal removed; the test therefore holds the hook alive. A
// preload (test-preload.cjs, written below) wraps process.exit in the hook process only: it writes
// a marker file, then waits 4 s, then really exits. The marker appears after the hook's answer is
// flushed and disposeAllAppServers() has run, so the server must already be dead while the hook
// is still alive and waiting. (Mutation-checked: with disposeChild a no-op the server is still
// running at the marker and this test fails.) At 2500ms the first read, the account capture (told
// to give up half a second before the deadline, counted from the start of the hook process),
// times out first, and the reader's own cleanup stops the server; that variant leaves it well
// over a second to start a server behind a slow cmd shim. (With under 3.5 s left, the usage read
// that follows only reads the cache.)
// On Windows the 400ms variant launches the hung server WITHOUT cmd.exe (a copy of node.exe named
// codex.exe, held by a preload that writes the pid and then blocks the main thread for good, so the
// hung server really hangs and node never tries to load the app-server arguments as a script):
// the hook kills at a moment when cmd.exe may be starting its child, and taskkill /T's snapshot of
// the tree can miss a grandchild born in that instant. The real Codex app-server exits when its
// stdin closes (observed with codex-cli 0.169, about 1.5 s after the hook lets go of its pipes), so
// in the product a grandchild missed that way exits about 1.5 s after the hook; this fixture
// ignores stdin EOF, so a test that raced it would report an orphan the product does not leave.
// The copy of node.exe is run once first so the first-run virus scan of a new executable does not
// use up the 400ms. The 2500ms variant keeps the codex.cmd shim, where the start is long over by
// the kill.
for (const [deadline, direct, allowance, title] of [
  ["400", true, 5_000, "the hook, at its deadline, stops a Codex app-server whose read is still running (400ms)"],
  ["2500", false, 3_000, "a read that times out before the hook deadline stops its own Codex app-server (2500ms)"],
]) test(title, async (t) => {
  const root = await fixtureRoot(t);
  const here = dirname(fileURLToPath(import.meta.url));
  const hook = join(here, "..", "hooks", "session-start.mjs");
  const hung = join(here, "..", "fixtures", "hung-app-server.mjs");
  const pidFile = join(root, "hung.pid");
  const exitMarker = join(root, "hook-exiting.marker");
  // The npm shape on Windows (codex.cmd -> cmd.exe -> node), a script elsewhere.
  const noShell = direct && process.platform === "win32";
  const launcher = join(root, noShell ? "codex.exe" : process.platform === "win32" ? "codex.cmd" : "codex");
  // One preload for every node process of this test (NODE_OPTIONS reaches the hook and the server):
  //  * the hook (argv[1] is session-start.mjs) has process.exit wrapped: marker first, 4 s wait, exit;
  //  * the copy named codex.exe writes its pid and then blocks the main thread for good.
  const preload = join(root, "test-preload.cjs");
  await writeFile(preload, [
    'const fs = require("node:fs");',
    'if (/codex\\.exe$/i.test(process.execPath)) {',
    '  fs.writeFileSync(process.env.HUNG_PID_FILE, String(process.pid));',
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);',
    '}',
    'if (/session-start\\.mjs$/i.test(process.argv[1] || "")) {',
    '  const realExit = process.exit;',
    '  let held = false;',
    '  process.exit = (code) => {',
    '    if (!held) {',
    '      held = true;',
    '      fs.writeFileSync(process.env.HOOK_EXIT_MARKER, String(Date.now()));',
    '      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);',
    '    }',
    '    return realExit.call(process, code);',
    '  };',
    '}',
    '',
  ].join("\n"), "utf8");
  if (noShell) {
    await copyFile(process.execPath, launcher);
    // Warm the copy (the first run of a new executable is scanned): --version exits before any
    // preload runs, so it neither hangs nor writes the pid file.
    await promisify(execFile)(launcher, ["--version"], { timeout: 20_000 });
  } else {
    await writeFile(launcher, process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${hung}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${hung}" "$@"\n`, { mode: 0o755 });
  }
  const env = {
    ...process.env,
    NODE_OPTIONS: `--require "${preload.replaceAll("\\", "/")}"`,
    CODEX_HOME: root, CODEX_BIN: launcher, HUNG_PID_FILE: pidFile, HOOK_EXIT_MARKER: exitMarker,
    CACHE_STATUSBAND_HOOK_DEADLINE_MS: deadline,
  };
  const child = execFile(process.execPath, [hook], { env, timeout: 15_000 });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const began = Date.now();
  child.stdin.end(JSON.stringify({ source: "startup", session_id: "orphan-session" }));
  const until = async (condition, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !(await condition())) await new Promise((resolve) => setTimeout(resolve, 50));
    return condition();
  };
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const exists = async (path) => (await readFile(path, "utf8").catch(() => "")) !== "";
  let pid = null;
  try {
    // The marker appears once the hook has flushed its answer and disposed of the servers; the hook
    // then waits 4 s before it really exits.
    assert.ok(await until(() => exists(exitMarker), 14_000), "the hook never reached its exit");
    const elapsed = Date.now() - began;
    // The hook answers by its deadline (plus process start-up and cleanup) whatever the server did.
    assert.ok(elapsed < Number(deadline) + allowance, `the hook took ${elapsed}ms against a ${deadline}ms deadline`);
    // The server records its pid once it is up. It must have started (the hook's own read launches it
    // before the deadline); a pid file that never appears means the launch itself failed, which must
    // not pass as "nothing left running".
    assert.ok(await exists(pidFile), "the Codex app-server never started (no pid file), so the cleanup was not exercised");
    pid = Number(await readFile(pidFile, "utf8"));
    // The hook process is still alive here (it is in its 4 s wait), so a server that is gone was
    // stopped by the hook's disposal, not by the hook process ending. A signal may take a moment to
    // land (well inside the 4 s), so allow 1.5 s.
    assert.equal(child.exitCode, null, "the hook already exited, so this proves nothing about its disposal");
    assert.ok(await until(() => !alive(pid), 1_500), "the hook left the Codex app-server running while it was still alive");
    assert.equal(child.exitCode, null, "the server was only seen gone after the hook exited, so this proves nothing about its disposal");
    assert.equal(await exited, 0);
    assert.doesNotThrow(() => JSON.parse(stdout), `the hook printed invalid JSON: ${stdout}`);
  } finally {
    if (pid !== null && alive(pid)) process.kill(pid);
    if (child.exitCode === null) child.kill();
  }
});

// The deadline counts from the start of the hook process, not from when main() gets its
// input. Codex may take a while to write the input, so that wait must come out of the budget:
// with a 2500ms deadline and the input written after 2000ms, the hook has about 500ms left
// and must answer inside it. Were the deadline counted from the input, the hung read below
// would be given its full 2500ms (the account capture alone would wait about 2000ms).
test("the SessionStart hook process counts its deadline from when it started, not from its input", async (t) => {
  const root = await fixtureRoot(t);
  const here = dirname(fileURLToPath(import.meta.url));
  const hook = join(here, "..", "hooks", "session-start.mjs");
  const hung = join(here, "..", "fixtures", "hung-app-server.mjs");
  const pidFile = join(root, "hung.pid");
  const launcher = join(root, process.platform === "win32" ? "codex.cmd" : "codex");
  await writeFile(launcher, process.platform === "win32"
    ? `@echo off
"${process.execPath}" "${hung}" %*
`
    : `#!/bin/sh
exec "${process.execPath}" "${hung}" "$@"
`, { mode: 0o755 });
  const env = { ...process.env, CODEX_HOME: root, CODEX_BIN: launcher, HUNG_PID_FILE: pidFile, CACHE_STATUSBAND_HOOK_DEADLINE_MS: "2500" };
  const child = execFile(process.execPath, [hook], { env, timeout: 20_000 });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const wrote = Date.now();
  child.stdin.end(JSON.stringify({ source: "startup", session_id: "late-input-session" }));
  const code = await exited;
  const afterInput = Date.now() - wrote;
  try {
    assert.equal(code, 0);
    assert.doesNotThrow(() => JSON.parse(stdout), `the hook printed invalid JSON: ${stdout}`);
    // About 500ms of the budget was left, plus cleanup; counting from the input it would be
    // 2500ms or more.
    assert.ok(afterInput < 2_300, `the hook took ${afterInput}ms after its input arrived, against a 2500ms deadline that began 2000ms earlier`);
  } finally {
    const pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
    if (Number.isFinite(pid) && pid > 0) { try { process.kill(pid); } catch {} }
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

test("a startup in a cache folder that refuses new files still shows the stored reading and the login", async (t) => {
  const root = await fixtureRoot(t);
  const email = ["test", "example.invalid"].join("@");
  const dataDir = join(root, "cache-statusband-codex");
  const sessionsDir = join(dataDir, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const name = `rate-limits-${createHash("sha256").update(`account:${email}`).digest("hex").slice(0, 16)}.json`;
  await writeFile(join(dataDir, name), `${JSON.stringify({
    version: 3, attemptedAt: 1, fetchedAt: 1, nextAllowedAt: 2, lastErrorAt: null, identityKey: `account:${email}`,
    accountEmail: email, availableCount: 7, credits: [], primary: null, secondary: null,
  })}\n`);
  // Both folders refuse new files (a real deny ACL on Windows, mode 555 elsewhere): the
  // session's identity record cannot be written, and neither can the usage cache's lock.
  const folders = [sessionsDir, dataDir];
  const undo = [];
  if (process.platform !== "win32" && process.getuid?.() === 0) return t.skip("root cannot be denied file creation");
  let output;
  try {
    // The setup is inside the try so that a failure part-way still lifts every deny applied so far.
    for (const dir of folders) {
      if (process.platform === "win32") {
        undo.push(() => promisify(execFile)("icacls", [dir, "/remove:d", "*S-1-1-0"]));
        await promisify(execFile)("icacls", [dir, "/deny", "*S-1-1-0:(WD,AD)"]);
      } else {
        undo.push(() => chmod(dir, 0o755));
        await chmod(dir, 0o555);
      }
    }
    output = await handleSessionStart({ source: "startup", session_id: "unwritable-cache" }, {
      codexHome: root,
      identityGetter: async () => ({ key: `account:${email}`, label: email, unavailable: false }),
    });
  } finally {
    // Every lift is tried, even if an earlier one fails (or the deny it undoes never applied).
    for (const lift of undo) await lift().catch(() => {});
  }
  assert.match(output.systemMessage, /Banked resets: 7/);
  assert.ok(output.systemMessage.includes(`Account: ${email}.`), output.systemMessage);
  // Nothing was recorded, so a later start may still bind the login.
  assert.deepEqual((await readdir(sessionsDir)).filter((file) => file.endsWith(".identity.json") || file.endsWith(".tmp")), []);
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

test("a Stop report with no model or effort keeps the ones saved before", async (t) => {
  const root = await fixtureRoot(t);
  const first = { contextUsed: 10, contextWindow: 100, tokenReportAt: "2026-10-29T12:00:00.000Z", model: "model-X", effort: "high" };
  assert.equal(await saveSessionState(root, "keep-session", first), true);
  const later = { contextUsed: 20, contextWindow: 100, tokenReportAt: "2026-10-29T13:00:00.000Z", model: null, effort: null };
  assert.equal(await saveSessionState(root, "keep-session", later), true);
  const saved = await loadSessionState(root, "keep-session");
  assert.equal(saved.contextUsed, 20);
  assert.equal(saved.model, "model-X");
  assert.equal(saved.effort, "high");
  // A newer, named model still replaces it.
  assert.equal(await saveSessionState(root, "keep-session", { ...later, tokenReportAt: "2026-10-29T14:00:00.000Z", model: "model-Y", effort: "low" }), true);
  assert.equal((await loadSessionState(root, "keep-session")).model, "model-Y");
});

test("a report naming a new model and no effort saves that model and no effort, never the old effort", async (t) => {
  const root = await fixtureRoot(t);
  const first = { contextUsed: 10, contextWindow: 100, tokenReportAt: "2026-10-29T12:00:00.000Z", model: "model-X", effort: "high" };
  assert.equal(await saveSessionState(root, "mix-session", first), true);
  const later = { contextUsed: 20, contextWindow: 100, tokenReportAt: "2026-10-29T13:00:00.000Z", model: "model-Y", effort: null };
  assert.equal(await saveSessionState(root, "mix-session", later), true);
  const saved = await loadSessionState(root, "mix-session");
  assert.equal(saved.model, "model-Y");
  assert.equal(saved.effort, null);
});

test("a resume shows the model Stop kept when the transcript's own latest turn is out of reach", async (t) => {
  const root = await fixtureRoot(t);
  const line = (value) => `${JSON.stringify(value)}
`;
  const filler = (count) => line({ type: "response_item", payload: { type: "message", content: "x".repeat(2048) } }).repeat(count);
  const contextA = { timestamp: "2026-10-29T12:01:00.000Z", type: "turn_context", payload: { cwd: "/workspace/first-turn", model: "model-A", effort: "low" } };
  const path = join(root, "big.jsonl");
  // The first turn is in the head, the latest report is in the tail, and no turn record is in
  // reach of either: the parser says unknown model.
  await writeFile(path, line(FIXTURE[0]) + line(contextA) + filler(2600) + line(FIXTURE.at(-1)), "utf8");
  assert.equal((await parseRollout(path)).model, null);
  // An earlier Stop, from a smaller transcript, had recorded the model in use.
  const earlier = { contextUsed: 10, contextWindow: 200000, tokenReportAt: "2026-10-29T12:02:00.000Z", model: "model-X", effort: "high" };
  assert.equal(await saveSessionState(root, "big-session", earlier), true);
  await handleStop({ session_id: "big-session", transcript_path: path }, { codexHome: root, now: Date.parse("2026-10-29T12:03:30.000Z") });
  const saved = await loadSessionState(root, "big-session");
  assert.equal(saved.contextUsed, 25000);
  assert.equal(saved.model, "model-X");
  assert.equal(saved.effort, "high");
  const output = await handleSessionStart(
    { source: "resume", session_id: "big-session", transcript_path: path },
    { codexHome: root, now: Date.parse("2026-10-29T12:04:00.000Z"), identityGetter: async () => null, usageGetter: async () => ({ availableCount: null, source: "cache" }) },
  );
  assert.match(output.systemMessage, /model-X\/high/);
  assert.doesNotMatch(output.systemMessage, /unknown model/);
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

test("a truncated rollout shows the latest turn_context it can find, or none, never the first turn's", async (t) => {
  const root = await fixtureRoot(t);
  const line = (value) => `${JSON.stringify(value)}\n`;
  const filler = (count) => line({ type: "response_item", payload: { type: "message", content: "x".repeat(2048) } }).repeat(count);
  const contextA = { timestamp: "2026-10-29T12:01:00.000Z", type: "turn_context", payload: { cwd: "/workspace/first-turn", model: "model-A", effort: "low" } };
  const contextB = { timestamp: "2026-10-29T13:01:00.000Z", type: "turn_context", payload: { cwd: "/workspace/later", model: "model-B", effort: "high" } };
  const tokens = FIXTURE.at(-1);

  // B sits just before the tail window and inside the bounded look-back: B is shown.
  const near = join(root, "near.jsonl");
  await writeFile(near, line(FIXTURE[0]) + line(contextA) + filler(150) + line(contextB) + filler(1400) + line(tokens), "utf8");
  const nearSummary = await parseRollout(near);
  assert.equal(nearSummary.model, "model-B");
  assert.equal(nearSummary.effort, "high");
  assert.equal(nearSummary.cwd, "/workspace/later");
  assert.equal(nearSummary.contextUsed, 25000);

  // B is further back than the look-back reaches: the model is unknown, not A.
  const far = join(root, "far.jsonl");
  await writeFile(far, line(FIXTURE[0]) + line(contextA) + filler(150) + line(contextB) + filler(2600) + line(tokens), "utf8");
  const farSummary = await parseRollout(far);
  assert.equal(farSummary.model, null);
  assert.equal(farSummary.effort, null);
  // The first turn's directory is not paired with the unknown model: the session's own
  // starting directory (session_meta) is kept.
  assert.equal(farSummary.cwd, "/workspace/example");
  assert.equal(farSummary.id, "session-1");
  assert.equal(farSummary.contextUsed, 25000);

  // B crosses the head window's cut-off (byte 262144): it is whole in neither the head nor the
  // look-back above the head, but it is still the latest turn and is shown.
  const straddle = join(root, "straddle.jsonl");
  const HEAD = 256 * 1024;
  const prefix = line(FIXTURE[0]) + line(contextA);
  const blank = Buffer.byteLength(line({ type: "response_item", payload: { type: "message", content: "" } }));
  const pad = line({ type: "response_item", payload: { type: "message", content: "p".repeat(HEAD - 60 - Buffer.byteLength(prefix) - blank) } });
  const before = Buffer.byteLength(prefix + pad);
  assert.ok(before < HEAD && before + Buffer.byteLength(line(contextB)) > HEAD, "contextB must cross the head cut-off");
  await writeFile(straddle, prefix + pad + line(contextB) + filler(1100) + line(tokens), "utf8");
  assert.ok((await stat(straddle)).size > 256 * 1024 + 2 * 1024 * 1024);
  const straddleSummary = await parseRollout(straddle);
  assert.equal(straddleSummary.model, "model-B");
  assert.equal(straddleSummary.effort, "high");
  assert.equal(straddleSummary.cwd, "/workspace/later");
  assert.equal(straddleSummary.contextUsed, 25000);
});

test("a transcript whose look-back chunks join the head window shows the head's turn when nothing later exists", async (t) => {
  // Sizes between 3,342,337 and 3,407,872 bytes: the last look-back chunk would start above the
  // floor 64 KiB under the head window's end (192 KiB) yet inside the head window (at most 256 KiB),
  // so it is read down to the floor and joins the head window: the head's turn_context is the
  // latest there is. It used to be shown as an unknown model.
  const root = await fixtureRoot(t);
  const line = (value) => `${JSON.stringify(value)}
`;
  const contextA = { timestamp: "2026-10-29T12:01:00.000Z", type: "turn_context", payload: { cwd: "/workspace/first-turn", model: "model-A", effort: "low" } };
  const prefix = line(FIXTURE[0]) + line(contextA);
  const fillerLine = line({ type: "response_item", payload: { type: "message", content: "x".repeat(2048) } });
  const count = Math.ceil((3_380_000 - Buffer.byteLength(prefix)) / Buffer.byteLength(fillerLine));
  const path = join(root, "band.jsonl");
  await writeFile(path, prefix + fillerLine.repeat(count), "utf8");
  const size = (await stat(path)).size;
  assert.ok(size > 3_342_336 && size <= 3_407_872, `size ${size} must sit inside the band`);
  const summary = await parseRollout(path);
  assert.equal(summary.model, "model-A");
  assert.equal(summary.effort, "low");
  assert.equal(summary.cwd, "/workspace/first-turn");
});

test("the look-back reaches the head up to 3,407,872 bytes and not at 3,407,873", async (t) => {
  // The four 256 KiB chunks below the 2 MiB tail reach down to size - 3 MiB. The last one joins
  // the head window once its start (size - 3 MiB) is at or below the window's end (256 KiB), so
  // 3 MiB + 256 KiB = 3,407,872 bytes is the largest file whose first turn is still the latest known.
  const root = await fixtureRoot(t);
  const line = (value) => `${JSON.stringify(value)}
`;
  const contextA = { timestamp: "2026-10-29T12:01:00.000Z", type: "turn_context", payload: { cwd: "/workspace/first-turn", model: "model-A", effort: "low" } };
  const prefix = line(FIXTURE[0]) + line(contextA);
  const fillerLine = line({ type: "response_item", payload: { type: "message", content: "x".repeat(2048) } });
  for (const [size, reachesHead] of [[3_407_872, true], [3_407_873, false]]) {
    const whole = Math.floor((size - Buffer.byteLength(prefix) - 2) / Buffer.byteLength(fillerLine));
    const padding = size - Buffer.byteLength(prefix) - whole * Buffer.byteLength(fillerLine);
    const path = join(root, `exact-${size}.jsonl`);
    await writeFile(path, prefix + fillerLine.repeat(whole) + "p".repeat(padding - 1) + "\n", "utf8");
    assert.equal((await stat(path)).size, size);
    const summary = await parseRollout(path);
    assert.equal(summary.model, reachesHead ? "model-A" : null, `size ${size}`);
    assert.equal(summary.effort, reachesHead ? "low" : null, `size ${size}`);
  }
});

test("a turn_context that names an effort but no valid model names neither, and the earlier pair stands", async (t) => {
  const root = await fixtureRoot(t);
  const line = (value) => `${JSON.stringify(value)}
`;
  const context = (payload, hour = 12) => ({ timestamp: `2026-10-29T${hour}:01:00.000Z`, type: "turn_context", payload });
  const first = context({ cwd: "/workspace/example", model: "model-A", effort: "low" });

  // Small file: an effort with no model, with a model of the wrong type, and with an empty record.
  for (const [name, odd] of [["absent", { effort: "high" }], ["wrong type", { model: { n: 1 }, effort: "high" }], ["neither", {}]]) {
    const path = join(root, `small-${name.replace(" ", "-")}.jsonl`);
    await writeFile(path, line(FIXTURE[0]) + line(first) + line(context(odd, 13)), "utf8");
    const summary = await parseRollout(path);
    assert.equal(summary.model, "model-A", name);
    assert.equal(summary.effort, "low", name);
  }
  // With no earlier pair at all, the effort alone is not shown either.
  const only = join(root, "only.jsonl");
  await writeFile(only, line(FIXTURE[0]) + line(context({ effort: "high" })), "utf8");
  const onlySummary = await parseRollout(only);
  assert.equal(onlySummary.model, null);
  assert.equal(onlySummary.effort, null);

  // A large file: the effort-only record sits in the look-back, so it is passed over and the
  // head's earlier pair is the latest one that names a model.
  const filler = (count) => line({ type: "response_item", payload: { type: "message", content: "x".repeat(2048) } }).repeat(count);
  const large = join(root, "large.jsonl");
  await writeFile(large, line(FIXTURE[0]) + line(first) + filler(150) + line(context({ effort: "high" }, 13)) + filler(1400) + line(FIXTURE.at(-1)), "utf8");
  assert.ok((await stat(large)).size > 256 * 1024 + 2 * 1024 * 1024);
  const largeSummary = await parseRollout(large);
  assert.equal(largeSummary.model, "model-A");
  assert.equal(largeSummary.effort, "low");
});

test("a turn_context that names no model leaves the folder alone too, wherever it sits in the file", async (t) => {
  const root = await fixtureRoot(t);
  const line = (value) => `${JSON.stringify(value)}
`;
  const filler = (count) => line({ type: "response_item", payload: { type: "message", content: "x".repeat(2048) } }).repeat(count);
  const context = (payload, hour = 12) => ({ timestamp: `2026-10-29T${hour}:01:00.000Z`, type: "turn_context", payload });
  const first = context({ cwd: "/workspace/A", model: "model-A", effort: "low" });
  const odd = context({ cwd: "/workspace/B", effort: "high" }, 13);
  const tokens = FIXTURE.at(-1);

  // Small file: {model A, cwd A} then {effort only, cwd B}: the folder stays A.
  const small = join(root, "small.jsonl");
  await writeFile(small, line(FIXTURE[0]) + line(first) + line(odd), "utf8");
  const smallSummary = await parseRollout(small);
  assert.equal(smallSummary.cwd, "/workspace/A");
  assert.equal(smallSummary.model, "model-A");
  assert.equal(smallSummary.effort, "low");

  // Large file, the model-less record in the tail, nothing naming a model within reach: the model
  // is unknown and the folder is the session's own (session_meta), never the odd record's.
  const tail = join(root, "tail.jsonl");
  await writeFile(tail, line(FIXTURE[0]) + line(first) + filler(2600) + line(odd) + filler(100) + line(tokens), "utf8");
  assert.ok((await stat(tail)).size > 3_407_872);
  const tailSummary = await parseRollout(tail);
  assert.equal(tailSummary.model, null);
  assert.equal(tailSummary.effort, null);
  assert.equal(tailSummary.cwd, "/workspace/example");

  // Large file, the model-less record in the tail, the look-back reaching the head: the head's turn.
  const reach = join(root, "reach.jsonl");
  await writeFile(reach, line(FIXTURE[0]) + line(first) + filler(600) + line(odd) + filler(600) + line(tokens), "utf8");
  const reachSize = (await stat(reach)).size;
  assert.ok(reachSize > 256 * 1024 + 2 * 1024 * 1024 && reachSize <= 3_407_872);
  const reachSummary = await parseRollout(reach);
  assert.equal(reachSummary.cwd, "/workspace/A");
  assert.equal(reachSummary.model, "model-A");
  assert.equal(reachSummary.effort, "low");

  // The model-less record in the head window, after the first turn: it changes nothing.
  const head = join(root, "head.jsonl");
  await writeFile(head, line(FIXTURE[0]) + line(first) + line(odd) + filler(1200) + line(tokens), "utf8");
  assert.ok((await stat(head)).size > 256 * 1024 + 2 * 1024 * 1024);
  const headSummary = await parseRollout(head);
  assert.equal(headSummary.cwd, "/workspace/A");
  assert.equal(headSummary.model, "model-A");
  assert.equal(headSummary.effort, "low");

  // A model-bearing record in an earlier look-back chunk, a model-less one after it (also in the
  // look-back): the look-back passes over the model-less one and returns the earlier turn.
  const back = join(root, "back.jsonl");
  const later = context({ cwd: "/workspace/B2", model: "model-B", effort: "high" }, 14);
  await writeFile(back, line(FIXTURE[0]) + line(first) + filler(300) + line(later) + filler(300) + line(odd) + filler(50) + filler(1000) + line(tokens), "utf8");
  assert.ok((await stat(back)).size > 256 * 1024 + 2 * 1024 * 1024);
  const backSummary = await parseRollout(back);
  assert.equal(backSummary.cwd, "/workspace/B2");
  assert.equal(backSummary.model, "model-B");
  assert.equal(backSummary.effort, "high");
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

test("the CLI says once, on stderr, that no usage was read when the cache cannot be written", async (t) => {
  const root = await fixtureRoot(t);
  const email = ["test", "example.invalid"].join("@");
  const name = `rate-limits-${createHash("sha256").update(`account:${email}`).digest("hex").slice(0, 16)}.json`;
  // A directory where the cache file belongs: the attempt marker cannot replace it.
  await mkdir(join(root, "cache-statusband-codex", name), { recursive: true });
  const line = `Usage not read: cannot update the cache in ${join(root, "cache-statusband-codex")}`;
  const cli = cliRunner(root);
  for (const args of [["usage"], ["usage", "--json"], ["board"], ["board", "--json"]]) {
    const { stdout, stderr } = await cli.runWithStderr(args, { CACHE_STATUSBAND_CODEX_SEAT_FILE: "" });
    assert.equal(stderr.split(line).length - 1, 1, `${args.join(" ")}: ${stderr}`);
    if (args.includes("--json")) {
      const parsed = JSON.parse(stdout);
      assert.equal((parsed.usage ?? parsed).cacheUnwritable, true, args.join(" "));
    } else {
      assert.ok(stdout.includes(line), `${args.join(" ")}: ${stdout}`);
    }
  }
});

test("a lock file that cannot be created leaves usage and board working, with the stale reading", async (t) => {
  const root = await fixtureRoot(t);
  const email = ["test", "example.invalid"].join("@");
  const dataDir = join(root, "cache-statusband-codex");
  await mkdir(dataDir, { recursive: true });
  await mkdir(join(root, "sessions"));
  const meta = { timestamp: "2026-10-29T12:00:00.000Z", type: "session_meta", payload: { id: "lock-denied-session", cwd: "/workspace/example", source: "cli" } };
  await writeFile(join(root, "sessions", "lock-denied.jsonl"), `${JSON.stringify(meta)}
`, "utf8");
  const name = `rate-limits-${createHash("sha256").update(`account:${email}`).digest("hex").slice(0, 16)}.json`;
  await writeFile(join(dataDir, name), `${JSON.stringify({
    version: 3, attemptedAt: 1, fetchedAt: 1, nextAllowedAt: 2, lastErrorAt: null, identityKey: `account:${email}`,
    accountEmail: email, availableCount: 7, credits: [], primary: null, secondary: null,
  })}
`);
  // A folder that refuses new files: the lock file cannot be created (a real deny ACL on
  // Windows, mode 555 elsewhere).
  let undo;
  if (process.platform === "win32") {
    await promisify(execFile)("icacls", [dataDir, "/deny", "*S-1-1-0:(WD,AD)"]);
    undo = () => promisify(execFile)("icacls", [dataDir, "/remove:d", "*S-1-1-0"]);
  } else if (process.getuid?.() === 0) {
    return t.skip("root cannot be denied file creation");
  } else {
    await chmod(dataDir, 0o555);
    undo = () => chmod(dataDir, 0o755);
  }
  const line = `Usage not read: cannot update the cache in ${dataDir}`;
  const cli = cliRunner(root);
  let results;
  try {
    results = [];
    for (const args of [["usage"], ["board"]]) {
      results.push([args, await cli.runWithStderr(args, { CACHE_STATUSBAND_CODEX_SEAT_FILE: "" })]);
    }
  } finally {
    await undo();
  }
  for (const [args, { stdout, stderr }] of results) {
    assert.ok(stdout.includes(line), `${args.join(" ")}: ${stdout}`);
    assert.equal(stderr.split(line).length - 1, 1, `${args.join(" ")}: ${stderr}`);
    assert.match(stdout, /Banked resets: 7/, args.join(" "));
  }
  assert.match(results[1][1].stdout, /lock-denied…/);
});

// Runs the CLI against a scratch Codex home, with a fake app-server standing in for codex.
function cliRunner(root) {
  const here = dirname(fileURLToPath(import.meta.url));
  const bin = join(here, "..", "bin", "cache-statusband-codex.mjs");
  const server = join(here, "..", "fixtures", "fake-app-server.mjs");
  const windows = process.platform === "win32";
  const wrapper = join(root, windows ? "codex.cmd" : "codex");
  const runWithStderr = async (args, env = {}) => {
    await writeFile(wrapper, windows
      ? `@echo off\r\n"${process.execPath}" "${server}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${server}" "$@"\n`, { mode: 0o755 });
    return promisify(execFile)(process.execPath, [bin, ...args, "--codex-home", root], { env: { ...process.env, CODEX_BIN: wrapper, ...env }, timeout: 20_000 });
  };
  return { runWithStderr, run: async (args, env) => (await runWithStderr(args, env)).stdout };
}

async function fixtureRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "cache-statusband-codex-"));
  // A just-killed copy of node.exe can hold its file for a moment (EPERM on Windows): retry.
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}

async function writeFixture(path) {
  await writeFile(path, FIXTURE.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("\n") + "\n", "utf8");
}

test("board still lists sessions when the usage read throws, and says so on stderr; --json has usage: null", async (t) => {
  const root = await fixtureRoot(t);
  await mkdir(join(root, "sessions"));
  const meta = { timestamp: "2026-10-29T12:00:00.000Z", type: "session_meta", payload: { id: "usage-throws-session", cwd: "/workspace/example", source: "cli" } };
  await writeFile(join(root, "sessions", "usage-throws.jsonl"), `${JSON.stringify(meta)}\n`, "utf8");
  const preload = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fail-usage-cache-key.mjs")).href;
  const cli = cliRunner(root);
  const env = { CACHE_STATUSBAND_CODEX_SEAT_FILE: "", NODE_OPTIONS: `--import=${preload}` };

  const text = await cli.runWithStderr(["board"], env);
  assert.match(text.stderr, /^cache-statusband-codex: usage not read: simulated failure while building the cache name$/m);
  assert.match(text.stdout, /usage-throw…/);
  assert.match(text.stdout, /Banked resets: unavailable/);

  const json = await cli.runWithStderr(["board", "--json"], env);
  assert.match(json.stderr, /usage not read: simulated failure/);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.usage, null);
  assert.equal(parsed.sessions.length, 1);
  assert.equal(parsed.sessions[0].id, "usage-throws-session");
});

test("usage and board say once, on stderr, why no usage was read when Codex is missing or no one is signed in", async (t) => {
  const root = await fixtureRoot(t);
  const cli = cliRunner(root);
  const noSeat = { CACHE_STATUSBAND_CODEX_SEAT_FILE: "" };
  const missing = join(root, "no-such-dir", "codex.exe");
  const cases = [
    [{ ...noSeat, CODEX_BIN: missing }, /^cache-statusband-codex: usage not read: Codex was not found/m],
    [{ ...noSeat, FAKE_SERVER_SIGNED_OUT: "1" }, /^cache-statusband-codex: usage not read: no Codex account is signed in$/m],
  ];
  for (const [env, expected] of cases) {
    for (const args of [["usage"], ["board"]]) {
      // The exit code stays 0 (the promise resolves) and stdout is the usual unavailable header.
      const { stdout, stderr } = await cli.runWithStderr(args, env);
      assert.match(stderr, expected, `${args.join(" ")}: ${stderr}`);
      assert.equal(stderr.split("usage not read").length - 1, 1, `${args.join(" ")}: ${stderr}`);
      assert.equal(stderr.trim().split(/\r?\n/).length, 1, `${args.join(" ")}: ${stderr}`);
      assert.match(stdout, /Banked resets: unavailable/);
    }
  }
});

test("a login with no ChatGPT account email is not reported as signed out, with or without a seat", async (t) => {
  const root = await fixtureRoot(t);
  const cli = cliRunner(root);
  const seatPath = join(root, "seat.txt");
  await writeFile(seatPath, "alpha");
  const cases = [
    [{ CACHE_STATUSBAND_CODEX_SEAT_FILE: "", FAKE_SERVER_ACCOUNT_TYPE: "apiKey" }, "apiKey"],
    [{ CACHE_STATUSBAND_CODEX_SEAT_FILE: seatPath, FAKE_SERVER_ACCOUNT_TYPE: "amazonBedrock" }, "amazonBedrock"],
    [{ CACHE_STATUSBAND_CODEX_SEAT_FILE: "", FAKE_SERVER_ACCOUNT_TYPE: "evil\u001b[2Jtype" }, "unknown type"],
  ];
  for (const [env, type] of cases) {
    for (const args of [["usage"], ["board"]]) {
      const { stderr } = await cli.runWithStderr(args, env);
      assert.match(stderr, new RegExp(`^cache-statusband-codex: usage not read: the signed-in Codex login \\(${type}\\) has no ChatGPT account email, so usage cannot be read$`, "m"), `${args.join(" ")}: ${stderr}`);
      assert.doesNotMatch(stderr, /no Codex account is signed in/);
      assert.equal(stderr.trim().split(/\r?\n/).length, 1, `${args.join(" ")}: ${stderr}`);
    }
  }
});

test("a broken pipe while reading the account says Codex exited; only spawn-time codes say it could not be started", async (t) => {
  const root = await fixtureRoot(t);
  const cli = cliRunner(root);
  const preload = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fail-account-read-error.mjs")).href;
  const base = { CACHE_STATUSBAND_CODEX_SEAT_FILE: "", NODE_OPTIONS: `--import=${preload}`, CODEX_BIN: process.execPath };
  const cases = [
    [{ FAKE_ACCOUNT_ERROR_CODE: "EPIPE", FAKE_ACCOUNT_ERROR_ON: "stdin" }, /^cache-statusband-codex: usage not read: Codex exited before answering$/m],
    [{ FAKE_ACCOUNT_ERROR_CODE: "ECONNRESET", FAKE_ACCOUNT_ERROR_ON: "stdin" }, /^cache-statusband-codex: usage not read: Codex exited before answering$/m],
    [{ FAKE_ACCOUNT_ERROR_CODE: "ERR_STREAM_DESTROYED", FAKE_ACCOUNT_ERROR_ON: "stdin" }, /^cache-statusband-codex: usage not read: Codex exited before answering$/m],
    // A failed write to the child is Codex having gone away whatever the code (EOF, here).
    [{ FAKE_ACCOUNT_ERROR_CODE: "EOF", FAKE_ACCOUNT_ERROR_SYSCALL: "write", FAKE_ACCOUNT_ERROR_ON: "stdin" }, /^cache-statusband-codex: usage not read: Codex exited before answering$/m],
    [{ FAKE_ACCOUNT_ERROR_CODE: "EACCES", FAKE_ACCOUNT_ERROR_ON: "child" }, /^cache-statusband-codex: usage not read: Codex could not be started \(EACCES\)$/m],
    [{ FAKE_ACCOUNT_ERROR_CODE: "EINVAL", FAKE_ACCOUNT_ERROR_ON: "child" }, /^cache-statusband-codex: usage not read: Codex could not be started \(EINVAL\)$/m],
  ];
  for (const [env, expected] of cases) {
    const { stderr } = await cli.runWithStderr(["usage"], { ...base, ...env });
    assert.match(stderr, expected, stderr);
  }
});

test("a configured seat that cannot be read keeps usage and board silent on stderr", async (t) => {
  const root = await fixtureRoot(t);
  const cli = cliRunner(root);
  const env = { CACHE_STATUSBAND_CODEX_SEAT_FILE: join(root, "no-such-seat.txt") };
  for (const args of [["usage"], ["board"]]) {
    const { stderr } = await cli.runWithStderr(args, env);
    assert.equal(stderr, "", `${args.join(" ")}: ${stderr}`);
  }
});
