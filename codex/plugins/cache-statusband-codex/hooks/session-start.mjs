#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatUsageLines } from "../src/format.mjs";
import { defaultCodexHome, parseRollout } from "../src/rollouts.mjs";
import { resumeMessage } from "../src/resume.mjs";
import { loadSessionState, mergeSavedContext } from "../src/session-state.mjs";
import { usagePresentation } from "../src/settings.mjs";
import { captureUsageIdentity, getUsageSnapshot } from "../src/usage.mjs";

// The hook times out at 15 seconds and writes once at the end, so the usage reads share a deadline.
const USAGE_BUDGET_MS = 12_000;
const MIN_READ_MS = 500;

export async function handleSessionStart(input, {
  usageGetter = getUsageSnapshot,
  identityGetter = captureUsageIdentity,
  rolloutParser = parseRollout,
  stateLoader = loadSessionState,
  codexHome = null,
  now = Date.now(),
  usageBudgetMs = USAGE_BUDGET_MS,
} = {}) {
  const startedAt = Date.now();
  const source = input?.source;
  if (!input?.transcript_path || !["startup", "resume", "fork"].includes(source)) return {};
  const messages = [];
  let home = codexHome;
  try {
    home ??= defaultCodexHome();
  } catch {}
  try {
    let summary = null;
    try {
      summary = await rolloutParser(input.transcript_path);
    } catch {}
    if (home && input.session_id) summary = mergeSavedContext(summary, await stateLoader(home, input.session_id));
    const message = resumeMessage(summary, now);
    if (message) messages.push(message);
  } catch {}
  try {
    if (!home) throw new Error("CODEX_HOME is unavailable");
    const remaining = () => usageBudgetMs - (Date.now() - startedAt);
    if (remaining() < MIN_READ_MS) throw new Error("No time left for the usage read");
    const identity = await identityGetter(home, { timeoutMs: remaining() });
    if (remaining() < MIN_READ_MS) throw new Error("No time left for the usage read");
    const usage = await usageGetter({ codexHome: home, now, identity, timeoutMs: remaining() });
    const presented = await usagePresentation(usage, { codexHome: home, identity });
    if (Number.isFinite(presented.snapshot.availableCount)) messages.push(formatUsageLines(presented.snapshot, now)[0]);
    if (presented.identity) messages.push(presented.identity.startsWith("Seat ") ? `${presented.identity}.` : `Account: ${presented.identity}.`);
  } catch {}
  return messages.length ? { systemMessage: messages.join(" ") } : {};
}

async function main() {
  try {
    const raw = await readStdin(1024 * 1024);
    const input = JSON.parse(raw || "{}");
    process.stdout.write(`${JSON.stringify(await handleSessionStart(input))}\n`, exit);
  } catch {
    process.stdout.write("{}\n", exit);
  }
}

// A handle left open by a child that outlived its kill must not hold the hook past its output.
function exit() {
  process.exit(0);
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
