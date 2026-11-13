#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { stripControls } from "../src/sanitize.mjs";
import { cacheUnwritableLine, capFirst, formatAge, formatPercent, formatTokens, formatUsageLines } from "../src/format.mjs";
import { defaultCodexHome, parseRollout, projectName, scanSessions } from "../src/rollouts.mjs";
import { captureUsageIdentity, getUsageSnapshot, resolveCodexLaunch } from "../src/usage.mjs";
import { configuredSeatIdentity, usagePresentation } from "../src/settings.mjs";

const args = process.argv.slice(2);
const command = args.shift() ?? "help";
// Set once warnIfCodexUnlaunchable has explained why Codex cannot be launched.
let codexUnlaunchableSaid = false;

try {
  if (["help", "--help", "-h"].includes(command)) help();
  else if (command === "board") await board(args);
  else if (command === "session") await session(args);
  else if (command === "usage") await usage(args);
  else if (command === "footer") footer();
  else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  process.stderr.write(`cache-statusband-codex: ${error.message}\n`);
  process.exitCode = 1;
}

function help() {
  process.stdout.write(`cache-statusband-codex

Commands:
  board [--all] [--json] [--limit N] [--codex-home PATH]
      List locally stored Codex sessions. --all includes archived sessions.
  usage [--json] [--codex-home PATH]
      Show five-hour/weekly limits and banked resets through Codex app-server.
  session PATH [--json]
      Summarize one Codex rollout transcript without reading prompt content.
  footer
      Print the recommended native Codex TUI footer setting.

This program never reads authentication files itself and makes no direct usage HTTP
request; usage is read through the Codex app-server.
`);
}

async function board(argv) {
  const options = parseOptions(argv);
  const home = resolve(options["codex-home"] ?? defaultCodexHome());
  const limit = integer(options.limit ?? "30", "--limit");
  warnIfCodexUnlaunchable();
  const summaries = await scanSessions(home, { includeArchived: Boolean(options.all), limit });
  // The usage part is separate from the session list: if it throws, say so on stderr and
  // still print the sessions (usage shown as unavailable, null in --json).
  let presented = { snapshot: null, identity: null };
  let usageKnown = true;
  try {
    const identity = await captureIdentityOrSay(home);
    const usageSnapshot = await getUsageSnapshot({ codexHome: home, identity });
    warnIfCacheUnwritable(usageSnapshot);
    presented = await usagePresentation(usageSnapshot, { codexHome: home, identity });
  } catch (error) {
    usageKnown = false;
    process.stderr.write(`cache-statusband-codex: usage not read: ${stripControls(error?.message ?? String(error))}\n`);
  }
  if (options.json) {
    process.stdout.write(`${json({ usage: usageKnown ? await publicSnapshot(presented.snapshot, home) : null, sessions: summaries })}\n`);
    return;
  }
  process.stdout.write(`${formatUsageLines(presented.snapshot, Date.now(), { identity: presented.identity }).join(" | ")}\n\n`);
  if (!summaries.length) {
    process.stdout.write(`No Codex rollout transcripts found under ${home}.\n`);
    return;
  }
  const rows = summaries.map((item) => ({
    id: shorten(clean(item.id), 12),
    state: item.archived ? "archived" : "stored",
    age: formatAge(item.updatedAt),
    model: shorten(clean([item.model, item.effort].filter(Boolean).join("/")) || "?", 24),
    context: contextText(item),
    project: shorten(clean(projectName(item.cwd)), 26),
  }));
  printTable(rows, [
    ["id", "SESSION"], ["state", "STATE"], ["age", "UPDATED"],
    ["model", "MODEL/EFFORT"], ["context", "CONTEXT"], ["project", "PROJECT"],
  ]);
}

async function usage(argv) {
  const options = parseOptions(argv);
  const home = resolve(options["codex-home"] ?? defaultCodexHome());
  warnIfCodexUnlaunchable();
  const identity = await captureIdentityOrSay(home);
  const snapshot = await getUsageSnapshot({ codexHome: home, identity });
  warnIfCacheUnwritable(snapshot);
  const presented = await usagePresentation(snapshot, { codexHome: home, identity });
  if (options.json) process.stdout.write(`${json(await publicSnapshot(presented.snapshot, home))}\n`);
  else process.stdout.write(`${formatUsageLines(presented.snapshot, Date.now(), { includeResetDetails: true, identity: presented.identity }).join("\n")}\n`);
}

// Reads the login the usage is for. When it cannot be read, say why in one line on stderr and
// carry on with no identity, which shows usage as unavailable (stdout and the exit code are
// the same as before). A configured seat that is unavailable stays silent: it is a deliberate
// fail-closed state, not a fault.
async function captureIdentityOrSay(home) {
  // A Codex home that does not exist has no login to read, and is never created: say so before
  // starting an app-server for it.
  if (!existsSync(home)) {
    if (!codexUnlaunchableSaid) say(`the Codex home ${stripControls(home)} does not exist`);
    return null;
  }
  try {
    const identity = await captureUsageIdentity(home, { throwOnFailure: true });
    if (!identity) say("no Codex account is signed in");
    return identity;
  } catch (error) {
    // An unlaunchable Codex was already explained by warnIfCodexUnlaunchable.
    if (error?.seatUnavailable || codexUnlaunchableSaid) return null;
    if (error?.signedOut) say("no Codex account is signed in");
    else if (error?.noAccountEmail) say(`the signed-in Codex login (${stripControls(error.accountType ?? "unknown type")}) has no ChatGPT account email, so usage cannot be read`);
    else say(captureFailureReason(error));
    return null;
  }
}

function captureFailureReason(error) {
  const code = error?.code;
  const message = stripControls(error?.message ?? String(error));
  if (code === "ENOENT") return "Codex was not found (is it installed and on your PATH? CODEX_BIN can point to it)";
  // A broken pipe or reset connection (or a failed write to the child) means Codex started
  // and then went away; only the other system codes are spawn-time failures.
  if (code === "EPIPE" || code === "ECONNRESET" || (typeof code === "string" && code.startsWith("ERR_STREAM_")) || error?.syscall === "write") return "Codex exited before answering";
  if (typeof code === "string" && /^E[A-Z0-9]+$/.test(code)) return `Codex could not be started (${code})`;
  return message || "the Codex account read failed";
}

function say(reason) {
  process.stderr.write(`cache-statusband-codex: usage not read: ${reason}
`);
}

// An unlaunchable Codex (for example a codex.cmd under a path containing %) makes every
// account read fail, which the readers report only as "identity unavailable". Say why,
// once. No usage is shown until Codex can be launched: with no verified account there is no
// cached fallback.
function warnIfCodexUnlaunchable() {
  try {
    resolveCodexLaunch();
  } catch (error) {
    codexUnlaunchableSaid = true;
    process.stderr.write(`cache-statusband-codex: ${error.message}\n`);
  }
}

// A cache that cannot be written means no usage was read at all; say so on stderr (once per
// command), which also covers --json, whose stdout carries only the snapshot.
function warnIfCacheUnwritable(snapshot) {
  const line = cacheUnwritableLine(snapshot);
  if (line) process.stderr.write(`cache-statusband-codex: ${line}\n`);
}

// With a seat configured, available or not, the email is deliberately not shown (a seat
// label or nothing is the identity), so the machine-readable output must not carry it or
// its key either, whatever identity was recorded for the session.
async function publicSnapshot(snapshot, home) {
  if (!(await configuredSeatIdentity(home))) return snapshot;
  const { accountEmail, identityKey, ...rest } = snapshot;
  return rest;
}

async function session(argv) {
  const options = parseOptions(argv, true);
  const path = options._[0];
  if (!path) throw new Error("session requires a rollout .jsonl path");
  if (!existsSync(path)) throw new Error(`file not found: ${path}`);
  const summary = await parseRollout(path);
  if (options.json) {
    process.stdout.write(`${json(summary)}\n`);
    return;
  }
  const values = {
    session: clean(summary.id),
    project: clean(summary.cwd) || "?",
    model: clean([summary.model, summary.effort].filter(Boolean).join("/")) || "?",
    context: contextText(summary),
    updated: `${formatAge(summary.updatedAt)} ago`,
    tokens: summary.totalUsage?.totalTokens == null ? "?" : formatTokens(summary.totalUsage.totalTokens),
  };
  for (const [key, value] of Object.entries(values)) process.stdout.write(`${capFirst(key).padEnd(9)} ${value}\n`);
}

function footer() {
  process.stdout.write(`status_line = ["model-with-reasoning", "context-remaining", "five-hour-limit", "weekly-limit", "estimated-thread-cost", "current-dir", "git-branch"]\nstatus_line_use_colors = true\n`);
}

function contextText(item) {
  if (!Number.isFinite(item.contextUsed) || !Number.isFinite(item.contextWindow)) return "?";
  return `${formatTokens(item.contextUsed)}/${formatTokens(item.contextWindow)} ${formatPercent(item.contextUsed, item.contextWindow)}`;
}

function parseOptions(argv, allowPositionals = false) {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) {
      if (!allowPositionals) throw new Error(`unexpected argument: ${value}`);
      options._.push(value);
      continue;
    }
    const key = value.slice(2);
    if (["all", "json"].includes(key)) options[key] = true;
    else {
      const next = argv[++i];
      if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
      options[key] = next;
    }
  }
  return options;
}

function integer(value, name) {
  const result = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(result) || result < 1 || result > 10_000) throw new Error(`${name} must be between 1 and 10000`);
  return result;
}

// Transcript fields are untrusted: drop C0/C1 control characters (terminal escapes).
function clean(value) {
  return stripControls(value);
}

// JSON.stringify escapes C0 controls but passes DEL and the C1 controls (8-bit terminal escape
// introducers), the line/paragraph separators and the bidirectional controls through, so a
// transcript string could still act on a terminal that prints the JSON. Escape those too.
function json(value) {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function shorten(value, length) {
  const text = String(value ?? "?");
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}

function printTable(rows, columns) {
  const widths = Object.fromEntries(columns.map(([key, label]) => [key, Math.max(label.length, ...rows.map((row) => row[key].length))]));
  process.stdout.write(`${columns.map(([key, label]) => label.padEnd(widths[key])).join("  ")}\n`);
  for (const row of rows) process.stdout.write(`${columns.map(([key]) => row[key].padEnd(widths[key])).join("  ")}\n`);
}
