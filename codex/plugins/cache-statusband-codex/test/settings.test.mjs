import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { configuredSeatFile, configuredSeatIdentity, usagePresentation } from "../src/settings.mjs";

const EMAIL = ["test", "example.invalid"].join("@");

async function homeWith(t, settings) {
  const root = await mkdtemp(join(tmpdir(), "cache-statusband-codex-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "cache-statusband-codex"), { recursive: true });
  if (settings !== undefined) await writeFile(join(root, "cache-statusband-codex", "settings.json"), settings);
  return root;
}

test("a settings.json that starts with a byte-order mark still configures the seat", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cache-statusband-codex-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "cache-statusband-codex"), { recursive: true });
  const seatPath = join(root, "seat.txt");
  await writeFile(seatPath, "alpha");
  await writeFile(join(root, "cache-statusband-codex", "settings.json"), `\uFEFF${JSON.stringify({ version: 1, seatFile: seatPath })}\n`);
  assert.deepEqual(await configuredSeatIdentity(root, {}), { key: "seat:alpha", label: "Seat alpha", unavailable: false });
});

test("no settings.json, or one without a seatFile, means no seat", async (t) => {
  assert.equal(await configuredSeatIdentity(await homeWith(t, undefined), {}), null);
  assert.equal(await configuredSeatIdentity(await homeWith(t, '{"version":1}'), {}), null);
});

test("an unreadable or malformed settings.json fails closed instead of meaning no seat", async (t) => {
  const unavailable = { key: "seat:unavailable", label: null, unavailable: true };
  for (const settings of ["{not json", "", "null", "[]", '{"seatFile": 5}', '{"seatFile": null}', '{"seatFile": ""}', '{"seatFile": "   "}']) {
    assert.deepEqual(await configuredSeatIdentity(await homeWith(t, settings), {}), unavailable, JSON.stringify(settings));
  }
  // A settings.json path that is a directory fails with something other than ENOENT.
  const root = await homeWith(t, undefined);
  await mkdir(join(root, "cache-statusband-codex", "settings.json"));
  assert.deepEqual(await configuredSeatIdentity(root, {}), unavailable);
  // Presentation then drops the account details rather than showing them.
  const shown = await usagePresentation({ accountEmail: EMAIL, availableCount: 2, credits: [], creditsOmitted: 3, creditsNotAvailable: 4, identityKey: `account:${EMAIL}` }, { codexHome: root, env: {} });
  assert.equal(shown.identity, null);
  assert.equal(shown.snapshot.accountEmail, null);
  assert.equal(shown.snapshot.availableCount, null);
  assert.equal(shown.snapshot.creditsOmitted, null);
  assert.equal(shown.snapshot.creditsNotAvailable, null);
});

test("a malformed settings.json never lets the CLI show or emit the account email", async (t) => {
  const root = await homeWith(t, "{not json");
  const here = dirname(fileURLToPath(import.meta.url));
  const bin = join(here, "..", "bin", "cache-statusband-codex.mjs");
  const server = join(here, "..", "fixtures", "fake-app-server.mjs");
  const windows = process.platform === "win32";
  const wrapper = join(root, windows ? "codex.cmd" : "codex");
  await writeFile(wrapper, windows
    ? `@echo off\r\n"${process.execPath}" "${server}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${server}" "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, CODEX_BIN: wrapper, CACHE_STATUSBAND_CODEX_SEAT_FILE: "" };
  for (const args of [["usage"], ["usage", "--json"], ["board"], ["board", "--json"]]) {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [bin, ...args, "--codex-home", root], { env, timeout: 20_000 });
    assert.doesNotMatch(stdout + stderr, /test@example|accountEmail|identityKey|account:/, args.join(" "));
  }
});

test("a settings.json read that fails once, is caught half-written or is briefly missing is retried, then fails closed", async () => {
  const good = JSON.stringify({ version: 1, seatFile: "seat.txt" });
  const sequence = (...steps) => {
    const calls = [];
    const reader = async () => {
      calls.push(1);
      const step = steps[Math.min(calls.length - 1, steps.length - 1)];
      if (step instanceof Error) throw step;
      return step;
    };
    return { reader, calls };
  };
  const busy = Object.assign(new Error("EBUSY: simulated"), { code: "EBUSY" });
  const fast = { retryMs: 1 };
  // The installer's temporary file beside settings.json: a replacement may be under way.
  const swapping = { lister: async () => ["settings.json.bak", ".settings.json.cache-statusband-0123abcd.tmp"] };

  const failedOnce = sequence(busy, good);
  assert.equal(await configuredSeatFile("home", { ...fast, reader: failedOnce.reader }), "seat.txt");
  assert.equal(failedOnce.calls.length, 2);

  const halfWritten = sequence("{\"version\":1,\"seat", good);
  assert.equal(await configuredSeatFile("home", { ...fast, reader: halfWritten.reader }), "seat.txt");
  assert.equal(halfWritten.calls.length, 2);

  // Three retries after the first read, then it fails closed.
  const broken = sequence("{not json");
  await assert.rejects(configuredSeatFile("home", { ...fast, reader: broken.reader }), SyntaxError);
  assert.equal(broken.calls.length, 4);
  const stuck = sequence(busy);
  await assert.rejects(configuredSeatFile("home", { ...fast, reader: stuck.reader }), /EBUSY/);
  assert.equal(stuck.calls.length, 4);

  // A missing file is retried twice when a replacement may be under way (see `swapping`), then means no seat.
  const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const missing = sequence(enoent());
  assert.equal(await configuredSeatFile("home", { ...fast, ...swapping, reader: missing.reader }), null);
  assert.equal(missing.calls.length, 3);
  const appears = sequence(enoent(), good);
  assert.equal(await configuredSeatFile("home", { ...fast, ...swapping, reader: appears.reader }), "seat.txt");
  assert.equal(appears.calls.length, 2);
  // The two retries are separate from the failed-read retries.
  const mixed = sequence(enoent(), busy, busy, busy, good);
  assert.equal(await configuredSeatFile("home", { ...fast, ...swapping, reader: mixed.reader }), "seat.txt");
  assert.equal(mixed.calls.length, 5);
  // With no temporary file beside it, a missing settings.json is "no seat" at once: no retry.
  const plain = sequence(enoent());
  const started = performance.now();
  assert.equal(await configuredSeatFile("home", { retryMs: 200, lister: async () => ["rate-limits.json"], reader: plain.reader }), null);
  assert.ok(performance.now() - started < 30, "a plain missing file must not wait");
  assert.equal(plain.calls.length, 1);
  // The same when the folder cannot be listed (it does not exist).
  const noFolder = sequence(enoent());
  assert.equal(await configuredSeatFile("home", { retryMs: 200, lister: async () => { throw enoent(); }, reader: noFolder.reader }), null);
  assert.equal(noFolder.calls.length, 1);
  // A real missing folder, no injection.
  assert.equal(await configuredSeatFile(join(tmpdir(), "csb-no-such-home-r9")), null);
  // A well-formed file with a bad value is an answer, not a glitch.
  const badValue = sequence(JSON.stringify({ seatFile: 5 }));
  await assert.rejects(configuredSeatFile("home", { ...fast, reader: badValue.reader }), /non-empty string/);
  assert.equal(badValue.calls.length, 1);
});
