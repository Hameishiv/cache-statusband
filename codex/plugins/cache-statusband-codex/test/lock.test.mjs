import assert from "node:assert/strict";
import { mkdtemp, open, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
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

test("racing reclaimers of a stale lock leave a holder and no stray files (usually exactly one holder)", async (t) => {
  const root = await fixtureRoot(t);
  const path = join(root, "stale.lock");
  await writeFile(path, "dead-holder");
  const old = new Date(Date.now() - 120_000);
  await utimes(path, old, old);
  const results = await Promise.all(Array.from({ length: 8 }, () => acquireLock(path, { staleMs: 30_000 })));
  // Exactly one in practice, but reclaiming is best effort (see acquireLock), so a rare
  // double hold is allowed; having no holder at all, or a lock nobody owns, is not.
  const holders = results.filter(Boolean);
  assert.ok(holders.length >= 1);
  const current = await readFile(path, "utf8");
  assert.ok(holders.some((holder) => holder.token === current));
  assert.deepEqual((await readdir(root)).filter((name) => name.includes(".stale.")), []);
});

test("a lock refreshed within the stale window is not reclaimed", async (t) => {
  const path = join(await fixtureRoot(t), "fresh.lock");
  await writeFile(path, "live-holder");
  assert.equal(await acquireLock(path, { staleMs: 30_000 }), null);
  assert.equal(await readFile(path, "utf8"), "live-holder");
});

function failing(code, { except } = {}) {
  const calls = [];
  const impl = async (path, ...rest) => {
    calls.push(path);
    if (except && except(path)) return open(path, ...rest);
    throw Object.assign(new Error(`${code}: simulated`), { code });
  };
  return { impl, calls };
}

test("a lock file refused once or twice with EPERM is created on a retry", async (t) => {
  const path = join(await fixtureRoot(t), "retry.lock");
  let calls = 0;
  const flaky = async (...args) => {
    calls += 1;
    if (calls <= 2) throw Object.assign(new Error("EPERM: simulated"), { code: "EPERM" });
    return open(...args);
  };
  const lock = await acquireLock(path, { openImpl: flaky, retryDelaysMs: [1, 1, 1] });
  assert.ok(lock);
  assert.equal(calls, 3);
  assert.equal(await readFile(path, "utf8"), lock.token);
  await lock.release();
});

test("a lock file refused with EPERM or EACCES in a folder that accepts files is busy, not an error", async (t) => {
  const root = await fixtureRoot(t);
  const path = join(root, "busy.lock");
  // Only the lock file itself is refused; a probe file beside it can be created.
  for (const code of ["EPERM", "EACCES"]) {
    const { impl, calls } = failing(code, { except: (p) => p.includes(".probe.") });
    assert.equal(await acquireLock(path, { openImpl: impl, retryDelaysMs: [1, 1, 1] }), null, code);
    assert.equal(calls.filter((p) => p === path).length, 4, `${code}: tried again before giving up`);
    assert.equal(calls.filter((p) => p.includes(".probe.")).length, 1, `${code}: the folder was probed once`);
  }
  assert.deepEqual(await readdir(root), [], "the probe file is removed again");
});

test("a lock file refused with EBUSY is busy after the retries, with every open refused and no probe made", async (t) => {
  const root = await fixtureRoot(t);
  const path = join(root, "ebusy.lock");
  // No exception for a probe: if one were attempted it would be refused too, and the call
  // would then throw (an unwritable cache) instead of returning null.
  const { impl, calls } = failing("EBUSY");
  assert.equal(await acquireLock(path, { openImpl: impl, retryDelaysMs: [1, 1, 1] }), null);
  assert.equal(calls.length, 4, "the lock file was tried again, and nothing else was opened");
  assert.ok(calls.every((p) => p === path), "no probe call was made");
  assert.deepEqual(await readdir(root), []);
});

test("a lock file refused in a folder that accepts no new files throws, so the cache is reported unwritable", async (t) => {
  const path = join(await fixtureRoot(t), "denied.lock");
  for (const code of ["EPERM", "EACCES"]) {
    const { impl } = failing(code);
    await assert.rejects(acquireLock(path, { openImpl: impl, retryDelaysMs: [1, 1, 1] }), { code });
  }
});

test("a lock file that fails with a missing or read-only folder is not retried or treated as busy", async (t) => {
  const path = join(await fixtureRoot(t), "gone.lock");
  for (const code of ["ENOENT", "EROFS", "ENOTDIR"]) {
    const { impl, calls } = failing(code);
    await assert.rejects(acquireLock(path, { openImpl: impl, retryDelaysMs: [1, 1, 1] }), { code });
    assert.equal(calls.length, 1, code);
  }
});

test("the probe file is removed even when closing it throws", async (t) => {
  const root = await fixtureRoot(t);
  const path = join(root, "close.lock");
  const impl = async (target, ...rest) => {
    if (!target.includes(".probe.")) throw Object.assign(new Error("EPERM: simulated"), { code: "EPERM" });
    const handle = await open(target, ...rest);
    const close = handle.close.bind(handle);
    handle.close = async () => { await close(); throw new Error("close failed: simulated"); };
    return handle;
  };
  // The probe cannot be confirmed, so the folder counts as unwritable; what matters here is
  // that nothing is left behind.
  await assert.rejects(acquireLock(path, { openImpl: impl, retryDelaysMs: [1] }), { code: "EPERM" });
  assert.deepEqual(await readdir(root), []);
});
