import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPOSITORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const BINARY = /\.(png|jpe?g|gif|ico|webp|zip|gz|woff2?)$/i;

// A text edit that mangled an escape sequence once turned `\b` into a backspace character
// in README.md. No tracked text file under codex/ has a reason to hold a C0 control other
// than tab, carriage return or line feed.
test("no tracked text file under codex/ contains a C0 control character other than tab, CR or LF", (t) => {
  let tracked;
  try {
    tracked = execFileSync("git", ["ls-files", "--", "codex"], { cwd: REPOSITORY, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    t.skip("not inside a git checkout");
    return;
  }
  assert.ok(tracked.length > 10, `only ${tracked.length} tracked files found under codex/`);
  const offences = [];
  for (const file of tracked) {
    if (BINARY.test(file)) continue;
    let text;
    try {
      text = readFileSync(join(REPOSITORY, file), "utf8");
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
