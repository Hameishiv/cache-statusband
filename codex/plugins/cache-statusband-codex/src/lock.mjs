import { randomUUID } from "node:crypto";
import { link, open, readFile, rename, stat, unlink } from "node:fs/promises";

// An advisory lock file holding a random token. Returns { token, release() } or
// null when another live holder owns it. A lock older than staleMs is reclaimed by
// renaming it aside, so ordinarily only one of several racing reclaimers succeeds.
// Reclaiming is best effort, not a guarantee. Two reclaimers can both see the same stale
// lock: the first renames it away and creates a fresh one, then the second renames that
// fresh lock away in turn. It notices (the file is new) and links the lock back, but if a
// third process has created the path in the meantime the link fails, and the first and
// third both believe they hold it. The cost is a duplicate poll or a skipped save.
//
// Creating the lock file can fail for a moment on Windows (a scanner or another process has
// the folder or an old lock file open, which shows up as EPERM, EACCES or EBUSY), so that is
// tried again a few times and, if it keeps failing, counts as "someone else holds it" (null)
// as long as the folder itself can be written to: a small probe file is created there to
// tell. A folder that cannot be written at all (the probe fails too, or the folder is missing
// or read-only) throws the original error, so the caller can report an unwritable cache.
export async function acquireLock(path, { now = Date.now(), staleMs = 30_000, openImpl = open, retryDelaysMs = CREATE_RETRY_DELAYS_MS } = {}) {
  const token = randomUUID();
  const make = () => create(path, token, openImpl, retryDelaysMs);
  if (await make()) return holder(path, token);
  let info;
  try {
    info = await stat(path);
  } catch {
    return null;
  }
  if (now - info.mtimeMs <= staleMs) return null;
  const aside = `${path}.stale.${randomUUID()}`;
  try {
    await rename(path, aside);
  } catch {
    // ENOENT means another reclaimer won the race; anything else is also a no.
    return null;
  }
  try {
    const moved = await stat(aside);
    if (now - moved.mtimeMs <= staleMs) {
      // We displaced a lock that was refreshed after our stat. Give it back untouched.
      await link(aside, path).catch(() => {});
      return null;
    }
  } catch {
    return null;
  } finally {
    await unlink(aside).catch(() => {});
  }
  return (await make()) ? holder(path, token) : null;
}

const CREATE_RETRY_DELAYS_MS = [30, 30, 30];
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);

async function create(path, token, openImpl, retryDelaysMs) {
  let handle;
  for (let attempt = 0; ; attempt += 1) {
    try {
      handle = await openImpl(path, "wx", 0o600);
      break;
    } catch (error) {
      if (error?.code === "EEXIST") return false;
      if (!TRANSIENT.has(error?.code)) throw error;
      if (attempt < retryDelaysMs.length) {
        await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
        continue;
      }
      // Still refused. Busy (not unwritable) unless a probe file cannot be created beside it either.
      if (error.code === "EBUSY" || await folderAcceptsNewFiles(path, openImpl)) return false;
      throw error;
    }
  }
  try {
    await handle.writeFile(token, "utf8");
  } finally {
    await handle.close();
  }
  return true;
}

async function folderAcceptsNewFiles(path, openImpl) {
  const probe = `${path}.probe.${randomUUID()}`;
  try {
    const handle = await openImpl(probe, "wx", 0o600);
    await handle.close();
  } catch {
    return false;
  }
  await unlink(probe).catch(() => {});
  return true;
}

function holder(path, token) {
  return {
    token,
    async release() {
      // Only remove a lock that still carries our token; a reclaimer may own it now.
      try {
        if ((await readFile(path, "utf8")) === token) await unlink(path);
      } catch {}
    },
  };
}
