import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireLock } from "../src/lock.mjs";

async function fixtureRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "cache-statusband-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("a lock holds a token and only its owner's release removes it", async (t) => {
  const path = join(await fixtureRoot(t), "x.lock");
  const mine = await acquireLock(path);
  assert.equal(await readFile(path, "utf8"), mine.token);
  assert.equal(await acquireLock(path), null);
  // Someone reclaimed the lock after we stalled: releasing must not delete theirs.
  await writeFile(path, "someone-elses-token");
  await mine.release();
  assert.equal(await readFile(path, "utf8"), "someone-elses-token");
  await rm(path);
  const next = await acquireLock(path);
  await next.release();
  await assert.rejects(readFile(path));
});

test("racing reclaimers of a stale lock ordinarily yield one holder (best effort, not a guarantee)", async (t) => {
  const root = await fixtureRoot(t);
  const path = join(root, "stale.lock");
  await writeFile(path, "dead-holder");
  const old = new Date(Date.now() - 120_000);
  await utimes(path, old, old);
  const results = await Promise.all(Array.from({ length: 8 }, () => acquireLock(path, { staleMs: 30_000 })));
  assert.equal(results.filter(Boolean).length, 1);
  const winner = results.find(Boolean);
  assert.equal(await readFile(path, "utf8"), winner.token);
  assert.deepEqual((await readdir(root)).filter((name) => name.includes(".stale.")), []);
});

test("a lock refreshed within the stale window is not reclaimed", async (t) => {
  const path = join(await fixtureRoot(t), "fresh.lock");
  await writeFile(path, "live-holder");
  assert.equal(await acquireLock(path, { staleMs: 30_000 }), null);
  assert.equal(await readFile(path, "utf8"), "live-holder");
});
