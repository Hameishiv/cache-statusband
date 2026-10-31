import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleSessionStart } from "../hooks/session-start.mjs";
import { handleStop } from "../hooks/stop.mjs";
import { parseRollout, scanSessions } from "../src/rollouts.mjs";
import { loadSessionState, saveSessionState } from "../src/session-state.mjs";

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

test("reads the rate limits codex-cli writes beside info, and from an event with no info", async (t) => {
  const root = await fixtureRoot(t);
  const path = join(root, "limits.jsonl");
  const limits = (used) => ({ primary: { used_percent: used, window_minutes: 300, resets_at: 1790000000 }, secondary: { used_percent: 4.0, window_minutes: 10080, resets_at: 1790500000 }, credits: null, plan_type: "plus" });
  const info = { total_token_usage: { total_tokens: 30000 }, last_token_usage: { total_tokens: 25000 }, model_context_window: 200000 };
  const lines = [
    FIXTURE[0],
    // payload keys in the order codex-cli 0.166 writes them: info, rate_limits, type
    { timestamp: "2026-10-29T12:02:00.000Z", type: "event_msg", payload: { info, rate_limits: limits(12), type: "token_count" } },
  ];
  await writeFile(path, lines.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
  let summary = await parseRollout(path);
  assert.equal(summary.rateLimits.primary.used_percent, 12);
  assert.equal(summary.contextUsed, 25000);
  // a later event carrying only the limits updates them and leaves the token state
  lines.push({ timestamp: "2026-10-29T12:03:00.000Z", type: "event_msg", payload: { info: null, rate_limits: limits(31), type: "token_count" } });
  await writeFile(path, lines.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
  summary = await parseRollout(path);
  assert.equal(summary.rateLimits.primary.used_percent, 31);
  assert.equal(summary.contextUsed, 25000);
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

test("SessionStart hook returns a visible, truthful resume summary", async (t) => {
  const root = await fixtureRoot(t);
  const path = join(root, "rollout.jsonl");
  await writeFixture(path);
  const testEmail = ["person", "example.invalid"].join("@");
  const output = await handleSessionStart(
    { source: "resume", transcript_path: path },
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

async function fixtureRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "cache-statusband-codex-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeFixture(path) {
  await writeFile(path, FIXTURE.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("\n") + "\n", "utf8");
}
