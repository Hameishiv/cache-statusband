import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resumeMessage } from "../src/resume.mjs";
import { hasControl, stripControls } from "../src/sanitize.mjs";
import { loadSessionState, saveSessionState } from "../src/session-state.mjs";
import { readSeatLabel } from "../src/settings.mjs";
import { sanitizeRateLimits } from "../src/usage.mjs";

// One sample of each class: C0 escape, DEL, and the C1 CSI/NEL introducers.
const SAMPLES = ["\u001b", "\u007f", "\u0080", "\u0085", "\u009b", "\u009f"];

test("the shared sanitizer treats C0, DEL and C1 alike", () => {
  for (const sample of SAMPLES) {
    assert.equal(hasControl(`a${sample}b`), true);
    assert.equal(stripControls(`a${sample}b`), "a b");
  }
  assert.equal(hasControl("plain text \u00a0 é"), false);
  assert.equal(stripControls(null), "");
});

test("every displayed or stored text field goes through it, C1 included", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cache-statusband-sanitize-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const sample of SAMPLES) {
    // Seat label (settings).
    const seat = join(root, "seat.txt");
    await writeFile(seat, `seat${sample}one`);
    assert.equal(await readSeatLabel(seat), "seat one");
    // Resume message (model/effort).
    const message = resumeMessage({ model: `mo${sample}del`, effort: "high", contextUsed: 1, contextWindow: 10, updatedAt: new Date().toISOString() });
    assert.equal(hasControl(message), false);
    assert.match(message, /mo del\/high/);
    // Saved session state (model).
    await saveSessionState(root, `session${sample}`, { model: `mo${sample}del`, contextUsed: 1, contextWindow: 10, tokenReportAt: "2026-10-29T12:00:00.000Z" });
    assert.equal((await loadSessionState(root, `session${sample}`)).model, "mo del");
    // Reset credit titles and the account email (usage).
    const safe = sanitizeRateLimits({
      account: { email: `a${sample}b@example.invalid` },
      rateLimitResetCredits: { availableCount: 1, credits: [{ title: `Full${sample}reset`, expiresAt: 1 }] },
    });
    assert.equal(safe.accountEmail, null);
    assert.equal(safe.credits[0].title, "Full reset");
  }
});

test("bidi overrides, isolates and line separators are stripped; Hebrew text and emoji survive", () => {
  for (const sample of ["\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069", "\u2028", "\u2029"]) {
    assert.equal(hasControl(`a${sample}b`), true);
    assert.equal(stripControls(`a${sample}b`), "a b");
  }
  for (const text of ["שלום עולם", "משיב — Codex", "family 👨‍👩‍👧 ok", "مرحبا", "plain\u200eRLM-ok"]) {
    assert.equal(hasControl(text), false);
    assert.equal(stripControls(text), text);
  }
});
