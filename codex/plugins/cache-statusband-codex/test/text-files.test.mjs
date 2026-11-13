import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPOSITORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SNIFF_BYTES = 8192;

// A file is binary when a NUL byte turns up in its first 8 KiB (git's own heuristic), so no
// list of extensions has to be kept up to date.
function isBinary(path) {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    return buffer.subarray(0, readSync(descriptor, buffer, 0, SNIFF_BYTES, 0)).includes(0);
  } finally {
    closeSync(descriptor);
  }
}

// A text edit that mangled an escape sequence once turned `\b` into a backspace character
// in README.md. No tracked text file under codex/ has a reason to hold a C0 control other
// than tab, carriage return or line feed.
test("no tracked text file under codex/ contains a C0 control character other than tab, CR or LF", (t) => {
  let tracked;
  try {
    // -z: NUL-separated, so a path with spaces or non-ASCII characters is listed verbatim.
    tracked = execFileSync("git", ["ls-files", "-z", "--", "codex"], { cwd: REPOSITORY, encoding: "utf8" }).split("\0").filter(Boolean);
  } catch (error) {
    t.skip(`could not list tracked files with git (${error.code ?? error.message})`);
    return;
  }
  if (!tracked.length) {
    t.skip("git lists no tracked files under codex/ (not a checkout of the repository)");
    return;
  }
  const offences = [];
  for (const file of tracked) {
    const path = join(REPOSITORY, file);
    let text;
    try {
      if (isBinary(path)) continue;
      text = readFileSync(path, "utf8");
    } catch {
      continue; // listed in the index but absent from the working tree
    }
    for (const match of text.matchAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g)) {
      const line = text.slice(0, match.index).split("\n").length;
      offences.push(`${file}:${line} U+${match[0].charCodeAt(0).toString(16).padStart(4, "0")}`);
    }
  }
  assert.deepEqual(offences, []);
});
