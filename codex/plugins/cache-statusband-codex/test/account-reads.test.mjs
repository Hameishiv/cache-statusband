import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { captureUsageIdentity, fetchRateLimitsViaAppServer, readAccountsViaAppServer } from "../src/usage.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const FAKE_SERVER = join(FIXTURES, "fake-app-server.mjs");
const FAKE_EMAIL = ["test", "example.invalid"].join("@");

async function fixtureRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "cache-statusband-reads-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const lines = async (path) => (await readFile(path, "utf8").catch(() => "")).split("\n").filter(Boolean);

test("a seat-configured capture reads the login twice on ONE app-server connection", async (t) => {
  const root = await fixtureRoot(t);
  const log = join(root, "requests.log");
  const starts = join(root, "starts.log");
  const seatPath = join(root, "seat.txt");
  await writeFile(seatPath, "alpha");
  const env = { ...process.env, FAKE_SERVER_LOG: log, FAKE_SERVER_STARTS: starts, CACHE_STATUSBAND_CODEX_SEAT_FILE: seatPath };
  const identity = await captureUsageIdentity(root, {
    env,
    throwOnFailure: true,
    timeoutMs: 5_000,
    accountsReader: (options) => readAccountsViaAppServer({ ...options, command: process.execPath, args: [FAKE_SERVER], env }),
  });
  assert.equal(identity.key, `account:${FAKE_EMAIL}`);
  assert.equal(identity.label, "Seat alpha");
  assert.equal((await lines(starts)).length, 1, "one app-server start for the whole capture");
  assert.deepEqual((await lines(log)).filter((name) => name === "account/read"), ["account/read", "account/read"]);
});

test("a seat change between the two reads ends the session before the second read", async (t) => {
  const root = await fixtureRoot(t);
  const log = join(root, "requests.log");
  const seatPath = join(root, "seat.txt");
  await writeFile(seatPath, "alpha");
  const env = { ...process.env, FAKE_SERVER_LOG: log, CACHE_STATUSBAND_CODEX_SEAT_FILE: seatPath };
  await assert.rejects(readAccountsViaAppServer({
    command: process.execPath,
    args: [FAKE_SERVER],
    codexHome: root,
    env,
    timeoutMs: 5_000,
    between: async () => { throw new Error("seat moved"); },
  }), /seat moved/);
  assert.deepEqual((await lines(log)).filter((name) => name === "account/read"), ["account/read"]);
});

test("the rate-limit reader fails closed without an expected account", async () => {
  // No server is started: the nonexistent command would otherwise fail with a different error.
  const options = { command: join(tmpdir(), "no-such-codex"), timeoutMs: 500 };
  for (const expectedEmail of [undefined, null, "", "not an email"]) {
    await assert.rejects(fetchRateLimitsViaAppServer({ ...options, expectedEmail }), /expected account/);
  }
});
