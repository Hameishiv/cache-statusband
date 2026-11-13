import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseRollout } from "../src/rollouts.mjs";
import { loadSessionState, mergeSavedContext } from "../src/session-state.mjs";

async function fixtureRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "cache-statusband-types-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("transcript timestamps and source types of the wrong type are ignored", async (t) => {
  const root = await fixtureRoot(t);
  const line = (item) => `${JSON.stringify(item)}\n`;
  const meta = { timestamp: ["2026-10-29T12:00:00.000Z"], type: "session_meta", payload: { id: "s1", timestamp: { at: 1 }, source: { type: ["cli"] } } };
  const token = { timestamp: ["2026-10-29T12:02:00.000Z"], type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 5 }, model_context_window: 10 } } };
  const path = join(root, "odd.jsonl");
  await writeFile(path, line(meta) + line(token), "utf8");
  const summary = await parseRollout(path);
  assert.ok(summary.createdAt === null || typeof summary.createdAt === "string", JSON.stringify(summary.createdAt));
  assert.ok(summary.tokenReportAt === null || typeof summary.tokenReportAt === "string", JSON.stringify(summary.tokenReportAt));
  assert.ok(summary.source === null || typeof summary.source === "string", JSON.stringify(summary.source));
  assert.equal(summary.contextUsed, 5);
});

test("a saved session state whose contextAt is not text or a number is loaded without it", async (t) => {
  const root = await fixtureRoot(t);
  const dir = join(root, "cache-statusband-codex", "sessions");
  await mkdir(dir, { recursive: true });
  const name = createHash("sha256").update("odd-state").digest("hex");
  const state = { version: 1, savedAt: 1, contextAt: ["2026-10-29T12:00:00.000Z"], contextUsed: 10, contextWindow: 100 };
  await writeFile(join(dir, `${name}.json`), JSON.stringify(state), "utf8");
  const loaded = await loadSessionState(root, "odd-state");
  assert.equal(loaded.contextUsed, 10);
  assert.equal("contextAt" in loaded, false);
  // A good value is kept as is, whether text or a number.
  for (const contextAt of ["2026-10-29T12:00:00.000Z", 1_793_000_000_000]) {
    await writeFile(join(dir, `${name}.json`), JSON.stringify({ ...state, contextAt }), "utf8");
    assert.equal((await loadSessionState(root, "odd-state")).contextAt, contextAt);
  }
  // The dropped field never becomes the report time shown for a resumed session.
  const merged = mergeSavedContext({}, loaded);
  assert.ok(merged.tokenReportAt === undefined || typeof merged.tokenReportAt === "string");
});
