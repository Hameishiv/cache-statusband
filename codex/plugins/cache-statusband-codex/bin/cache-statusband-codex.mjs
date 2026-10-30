#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { capFirst, formatAge, formatPercent, formatTokens, formatUsageLines } from "../src/format.mjs";
import { defaultCodexHome, parseRollout, projectName, scanSessions } from "../src/rollouts.mjs";
import { captureUsageIdentity, getUsageSnapshot } from "../src/usage.mjs";
import { usagePresentation } from "../src/settings.mjs";

const args = process.argv.slice(2);
const command = args.shift() ?? "help";

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

This program never reads authentication files or calls a usage endpoint.
`);
}

async function board(argv) {
  const options = parseOptions(argv);
  const home = resolve(options["codex-home"] ?? defaultCodexHome());
  const limit = integer(options.limit ?? "30", "--limit");
  const summaries = (await scanSessions(home, { includeArchived: Boolean(options.all) })).slice(0, limit);
  const identity = await captureUsageIdentity(home);
  const usageSnapshot = await getUsageSnapshot({ codexHome: home, identity });
  const presented = await usagePresentation(usageSnapshot, { codexHome: home, identity });
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ usage: presented.snapshot, sessions: summaries }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatUsageLines(presented.snapshot, Date.now(), { identity: presented.identity }).join(" | ")}\n\n`);
  if (!summaries.length) {
    process.stdout.write(`No Codex rollout transcripts found under ${home}.\n`);
    return;
  }
  const rows = summaries.map((item) => ({
    id: shorten(item.id, 12),
    state: item.archived ? "archived" : "stored",
    age: formatAge(item.updatedAt),
    model: shorten([item.model, item.effort].filter(Boolean).join("/") || "?", 24),
    context: contextText(item),
    project: shorten(projectName(item.cwd), 26),
  }));
  printTable(rows, [
    ["id", "SESSION"], ["state", "STATE"], ["age", "UPDATED"],
    ["model", "MODEL/EFFORT"], ["context", "CONTEXT"], ["project", "PROJECT"],
  ]);
}

async function usage(argv) {
  const options = parseOptions(argv);
  const home = resolve(options["codex-home"] ?? defaultCodexHome());
  const identity = await captureUsageIdentity(home);
  const snapshot = await getUsageSnapshot({ codexHome: home, identity });
  const presented = await usagePresentation(snapshot, { codexHome: home, identity });
  if (options.json) process.stdout.write(`${JSON.stringify(presented.snapshot, null, 2)}\n`);
  else process.stdout.write(`${formatUsageLines(presented.snapshot, Date.now(), { includeResetDetails: true, identity: presented.identity }).join("\n")}\n`);
}

async function session(argv) {
  const options = parseOptions(argv, true);
  const path = options._[0];
  if (!path) throw new Error("session requires a rollout .jsonl path");
  if (!existsSync(path)) throw new Error(`file not found: ${path}`);
  const summary = await parseRollout(path);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  const values = {
    session: summary.id,
    project: summary.cwd ?? "?",
    model: [summary.model, summary.effort].filter(Boolean).join("/") || "?",
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

function shorten(value, length) {
  const text = String(value ?? "?");
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}

function printTable(rows, columns) {
  const widths = Object.fromEntries(columns.map(([key, label]) => [key, Math.max(label.length, ...rows.map((row) => row[key].length))]));
  process.stdout.write(`${columns.map(([key, label]) => label.padEnd(widths[key])).join("  ")}\n`);
  for (const row of rows) process.stdout.write(`${columns.map(([key]) => row[key].padEnd(widths[key])).join("  ")}\n`);
}
