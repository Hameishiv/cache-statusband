#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { formatUsageLines } from "../src/format.mjs";
import { defaultCodexHome, parseRollout } from "../src/rollouts.mjs";
import { resumeMessage } from "../src/resume.mjs";
import { getSessionIdentity, loadSessionState, mergeSavedContext } from "../src/session-state.mjs";
import { usagePresentation } from "../src/settings.mjs";
import { captureUsageIdentity, disposeAllAppServers, getUsageSnapshot } from "../src/usage.mjs";

// hooks.json gives SessionStart 15s; stay inside it so what is already built is emitted.
const DEFAULT_DEADLINE_MS = 12_000;
// A usage read needs a few seconds of its own.
const MIN_FETCH_BUDGET_MS = 3_000;
// A read is told to give up this long before the hook deadline, so that its own cleanup
// (which stops the Codex app-server it started) normally runs before the hook exits.
const READ_MARGIN_MS = 500;
// When this process started, so Node's own start-up and the wait for stdin count against the
// deadline too. (performance.timeOrigin is the start of the process.)
const PROCESS_STARTED_AT = performance.timeOrigin;

export async function handleSessionStart(input, {
  usageGetter = getUsageSnapshot,
  identityGetter = captureUsageIdentity,
  rolloutParser = parseRollout,
  stateLoader = loadSessionState,
  codexHome = null,
  now = Date.now(),
  deadlineMs = DEFAULT_DEADLINE_MS,
  startedAt = Date.now(),
} = {}) {
  const source = input?.source;
  if (!["startup", "resume", "fork"].includes(source)) return {};
  const started = startedAt;
  const readBudget = () => Math.max(READ_MARGIN_MS, deadlineMs - (Date.now() - started) - READ_MARGIN_MS);
  const messages = [];
  let home = codexHome;
  try {
    home ??= defaultCodexHome();
  } catch {}
  // The transcript read and the usage read run side by side, and the one deadline below
  // covers both: a slow transcript cannot push the hook past it, and whatever has been
  // collected by then is what is emitted.
  const resumeMessages = [];
  const transcriptPart = (async () => {
    if (!input.transcript_path) return;
    try {
      let summary = null;
      try {
        summary = await rolloutParser(input.transcript_path);
      } catch {}
      if (home && input.session_id) summary = mergeSavedContext(summary, await stateLoader(home, input.session_id));
      const message = resumeMessage(summary, now);
      if (message) resumeMessages.push(message);
    } catch {}
  })();

  const usageMessages = [];
  const usagePart = (async () => {
    try {
      if (!home) throw new Error("CODEX_HOME is unavailable");
      // Earlier versions did not retain the original login. Today's login cannot
      // establish a resumed session's historical identity when its record is absent.
      // A new session records its login only when the read actually succeeded.
      const capture = source === "resume"
        ? async () => null
        : (target) => identityGetter(target, { throwOnFailure: true, timeoutMs: readBudget() });
      const identity = await getSessionIdentity(home, input.session_id, capture);
      // What remains is measured ONCE and both decisions come from that one value, so a
      // read is never promised the full budget by one clock reading and refused by another.
      // The read's own budget is that value less the margin; unless it is at least
      // MIN_FETCH_BUDGET_MS, show what is cached rather than start a read that cannot finish.
      const remaining = deadlineMs - (Date.now() - started);
      const cacheOnly = remaining < MIN_FETCH_BUDGET_MS + READ_MARGIN_MS;
      const timeoutMs = Math.max(READ_MARGIN_MS, remaining - READ_MARGIN_MS);
      const usage = await usageGetter({ codexHome: home, now, identity, timeoutMs, ...(cacheOnly ? { cacheOnly: true } : {}) });
      const presented = await usagePresentation(usage, { codexHome: home, identity });
      const built = [];
      // A resumed session's identity is the one it STARTED under, which may no longer be the
      // login in use, so on a resume the wording says so rather than naming a current account.
      const resumed = source === "resume";
      if (Number.isFinite(presented.snapshot.availableCount)) {
        const banked = formatUsageLines(presented.snapshot, now)[0];
        built.push(resumed ? banked.replace(/^Banked resets/, "Banked resets (starting account)") : banked);
      }
      if (presented.identity) {
        if (resumed) built.push(`Started as ${presented.identity}.`);
        else built.push(presented.identity.startsWith("Seat ") ? `${presented.identity}.` : `Account: ${presented.identity}.`);
      }
      usageMessages.push(...built);
    } catch {}
  })();
  let timer;
  // The deadline counts from startedAt: the start of the hook process when run as the hook
  // (main passes it), otherwise the moment this function was called.
  const expired = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, deadlineMs - (Date.now() - started))); });
  try {
    await Promise.race([Promise.all([transcriptPart, usagePart]), expired]);
  } finally {
    clearTimeout(timer);
  }
  messages.push(...resumeMessages.splice(0), ...usageMessages.splice(0));
  return messages.length ? { systemMessage: messages.join(" ") } : {};
}

async function main() {
  let output = "{}\n";
  try {
    const raw = await readStdin(1024 * 1024);
    const input = JSON.parse(raw || "{}");
    output = `${JSON.stringify(await handleSessionStart(input, { ...deadlineOption(), startedAt: PROCESS_STARTED_AT }))}\n`;
  } catch {}
  // A read that outlived the deadline may still hold handles open, and its Codex
  // app-server is still running. The hook is done once its answer is flushed: stop those
  // servers (they would otherwise be orphaned), then end the process.
  process.stdout.write(output, async () => {
    try {
      await disposeAllAppServers();
    } catch {}
    process.exit(0);
  });
}

// Lets a test shorten the deadline of the real hook process; unset in normal use.
function deadlineOption() {
  const value = Number(process.env.CACHE_STATUSBAND_HOOK_DEADLINE_MS);
  return Number.isFinite(value) && value > 0 ? { deadlineMs: value } : {};
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
