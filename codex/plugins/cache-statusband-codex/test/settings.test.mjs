import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { configuredSeatIdentity, usagePresentation } from "../src/settings.mjs";

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
  const shown = await usagePresentation({ accountEmail: EMAIL, availableCount: 2, credits: [], creditsOmitted: 3, identityKey: `account:${EMAIL}` }, { codexHome: root, env: {} });
  assert.equal(shown.identity, null);
  assert.equal(shown.snapshot.accountEmail, null);
  assert.equal(shown.snapshot.availableCount, null);
  assert.equal(shown.snapshot.creditsOmitted, null);
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
