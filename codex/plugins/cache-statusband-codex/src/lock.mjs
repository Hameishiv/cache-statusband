import { randomUUID } from "node:crypto";
import { link, open, readFile, rename, stat, unlink } from "node:fs/promises";

// An advisory lock file holding a random token. Returns { token, release() } or
// null when another live holder owns it. A lock older than staleMs is reclaimed by
// renaming it aside, so of several racing reclaimers exactly one rename succeeds.
export async function acquireLock(path, { now = Date.now(), staleMs = 30_000 } = {}) {
  const token = randomUUID();
  if (await create(path, token)) return holder(path, token);
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
  return (await create(path, token)) ? holder(path, token) : null;
}

async function create(path, token) {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(token, "utf8");
  } finally {
    await handle.close();
  }
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
