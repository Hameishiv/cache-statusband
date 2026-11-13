import { rename as fsRename } from "node:fs/promises";

const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_BACKOFF_MS = [20, 40, 80, 160, 320];

// Windows refuses to rename onto a file another process has open for a moment (a virus
// scanner, a concurrent reader), so a transient EPERM/EACCES/EBUSY is retried a few times
// with a growing pause. Any other error, or the last failure, is thrown to the caller.
export async function renameWithRetry(from, to, { rename = fsRename, delaysMs = RENAME_BACKOFF_MS } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await rename(from, to);
    } catch (error) {
      if (attempt >= delaysMs.length || !RETRYABLE.has(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
  }
}
