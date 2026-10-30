#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultCodexHome, parseRollout } from "../src/rollouts.mjs";
import { saveSessionState } from "../src/session-state.mjs";

export async function handleStop(input, {
  codexHome = null,
  rolloutParser = parseRollout,
  stateSaver = saveSessionState,
  now = Date.now(),
} = {}) {
  if (!input?.session_id || !input?.transcript_path) return {};
  try {
    const home = codexHome ?? defaultCodexHome();
    const summary = await rolloutParser(input.transcript_path);
    await stateSaver(home, input.session_id, summary, now);
  } catch {
    // State is an optimization. A hook/file race must never hold up the session.
  }
  return {};
}

async function main() {
  try {
    const raw = await readStdin(1024 * 1024);
    const input = JSON.parse(raw || "{}");
    process.stdout.write(`${JSON.stringify(await handleStop(input))}\n`);
  } catch {
    process.stdout.write("{}\n");
  }
}

async function readStdin(limit) {
  let result = "";
  for await (const chunk of process.stdin) {
    result += chunk;
    if (Buffer.byteLength(result) > limit) throw new Error("Hook input is too large");
  }
  return result;
}

// Compare real paths so a symlinked entry still counts as a direct run.
function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isDirectRun()) await main();
