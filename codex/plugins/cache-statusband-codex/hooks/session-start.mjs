#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { formatUsageLines } from "../src/format.mjs";
import { defaultCodexHome, parseRollout } from "../src/rollouts.mjs";
import { resumeMessage } from "../src/resume.mjs";
import { getSessionIdentity, loadSessionState, mergeSavedContext } from "../src/session-state.mjs";
import { usagePresentation } from "../src/settings.mjs";
import { captureUsageIdentity, getUsageSnapshot } from "../src/usage.mjs";

// hooks.json gives SessionStart 15s; stay inside it so what is already built is emitted.
const DEFAULT_DEADLINE_MS = 12_000;
// A usage read needs a few seconds; with less than this left, use the cache only.
const MIN_FETCH_BUDGET_MS = 3_000;

export async function handleSessionStart(input, {
  usageGetter = getUsageSnapshot,
  identityGetter = captureUsageIdentity,
  rolloutParser = parseRollout,
  stateLoader = loadSessionState,
  codexHome = null,
  now = Date.now(),
  deadlineMs = DEFAULT_DEADLINE_MS,
} = {}) {
  const source = input?.source;
  if (!["startup", "resume", "fork"].includes(source)) return {};
  const started = Date.now();
  const remaining = () => Math.max(1000, deadlineMs - (Date.now() - started));
  const messages = [];
  let home = codexHome;
  try {
    home ??= defaultCodexHome();
  } catch {}
  if (input.transcript_path) {
    try {
      let summary = null;
      try {
        summary = await rolloutParser(input.transcript_path);
      } catch {}
      if (home && input.session_id) summary = mergeSavedContext(summary, await stateLoader(home, input.session_id));
      const message = resumeMessage(summary, now);
      if (message) messages.push(message);
    } catch {}
  }

  const usageMessages = [];
  const usagePart = (async () => {
    try {
      if (!home) throw new Error("CODEX_HOME is unavailable");
      // Earlier versions did not retain the original login. Today's login cannot
      // establish a resumed session's historical identity when its record is absent.
      // A new session records its login only when the read actually succeeded.
      const capture = source === "resume"
        ? async () => null
        : (target) => identityGetter(target, { throwOnFailure: true, timeoutMs: remaining() });
      const identity = await getSessionIdentity(home, input.session_id, capture);
      // Too little of the deadline left for a read to finish: show what is cached.
      const cacheOnly = deadlineMs - (Date.now() - started) < MIN_FETCH_BUDGET_MS;
      const usage = await usageGetter({ codexHome: home, now, identity, timeoutMs: remaining(), ...(cacheOnly ? { cacheOnly: true } : {}) });
      const presented = await usagePresentation(usage, { codexHome: home, identity });
      const built = [];
      if (Number.isFinite(presented.snapshot.availableCount)) built.push(formatUsageLines(presented.snapshot, now)[0]);
      if (presented.identity) built.push(presented.identity.startsWith("Seat ") ? `${presented.identity}.` : `Account: ${presented.identity}.`);
      usageMessages.push(...built);
    } catch {}
  })();
  let timer;
  // The deadline counts from the start of the hook; the transcript read above already used some.
  const expired = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, deadlineMs - (Date.now() - started))); });
  try {
    await Promise.race([usagePart, expired]);
  } finally {
    clearTimeout(timer);
  }
  messages.push(...usageMessages.splice(0));
  return messages.length ? { systemMessage: messages.join(" ") } : {};
}

async function main() {
  let output = "{}\n";
  try {
    const raw = await readStdin(1024 * 1024);
    const input = JSON.parse(raw || "{}");
    output = `${JSON.stringify(await handleSessionStart(input))}\n`;
  } catch {}
  // A read that outlived the deadline may still hold handles open; the hook is done once
  // its answer is flushed, so end the process rather than wait for them.
  process.stdout.write(output, () => process.exit(0));
}

async function readStdin(limit) {
  let result = "";
  for await (const chunk of process.stdin) {
    result += chunk;
    if (Buffer.byteLength(result) > limit) throw new Error("Hook input is too large");
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
