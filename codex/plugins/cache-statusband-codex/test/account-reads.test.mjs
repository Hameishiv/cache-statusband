import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { EventEmitter } from "node:events";
import { captureUsageIdentity, disposeAllAppServers, fetchRateLimitsViaAppServer, readAccountViaAppServer, readAccountsViaAppServer } from "../src/usage.mjs";

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

test("disposeAllAppServers waits for the cleanup a finished reader already started", async (t) => {
  const root = await fixtureRoot(t);
  let killerFinished = false;
  const spawnKiller = () => {
    const fake = new EventEmitter();
    setTimeout(() => { killerFinished = true; fake.emit("exit", 0); }, 300);
    return fake;
  };
  // A server that never answers and ends by itself after a few seconds (the killer is faked).
  const idle = { command: process.execPath, args: ["-e", "process.stdin.resume(); setTimeout(() => process.exit(0), 4000)"] };
  await assert.rejects(readAccountViaAppServer({ codexHome: root, ...idle, platform: "win32", spawnKiller, timeoutMs: 200 }), /timed out/);
  // The reader gave up and moved on, but its taskkill is still running. A hook that exits
  // now would leave the server behind, so the exit path must wait for it.
  assert.equal(killerFinished, false);
  await disposeAllAppServers({ waitMs: 2_000, platform: "win32", spawnKiller });
  assert.equal(killerFinished, true);
});
