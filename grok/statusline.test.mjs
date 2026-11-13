import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  cacheLabel,
  capFirst,
  contextLabel,
  contrast,
  costLabel,
  formatTokens,
  HUES,
  loadWeekly,
  readLastBilling,
  remaining,
  render,
  segments,
  shade,
  weeklyLabel,
} from "./statusline.mjs";

const full = {
  model: { id: "grok-4.7", display_name: "Grok 4.7" },
  effort: { level: "high" },
  context_window: {
    context_window_size: 1000000,
    context_tokens: 287000,
    used_percentage: 29,
    session_usage: {
      input_tokens: 20000,
      cache_read_input_tokens: 80000,
      cache_creation_input_tokens: 1500,
      output_tokens: 400,
    },
  },
  cost: { total_cost_usd: 0.04 },
  authorization: "secret-token-should-not-appear",
};

describe("formatTokens", () => {
  it("keeps small counts and compacts the rest", () => {
    assert.equal(formatTokens(12), "12");
    assert.equal(formatTokens(1500), "1.5k");
    assert.equal(formatTokens(287000), "287k");
    assert.equal(formatTokens(2_500_000), "2.5M");
    assert.equal(formatTokens(Number.NaN), null);
  });
});

describe("segments", () => {
  it("shows only the fields Grok sent", () => {
    assert.deepEqual(
      segments(full).map((part) => part.label),
      ["Grok 4.7", "High", "Ctx 29% · 287k/1M", "Cache read 80k · write 1.5k", "Session $0.04"],
    );
  });

  it("omits a missing field instead of printing zero or null", () => {
    assert.deepEqual(segments({ model: { display_name: "Grok 4.7" } }).map((part) => part.label), ["Grok 4.7"]);
    assert.equal(contextLabel(undefined), null);
    assert.equal(cacheLabel(undefined), null);
    assert.equal(costLabel(undefined), null);
    assert.equal(render({}), "");
  });

  it("keeps a real zero", () => {
    assert.equal(contextLabel({ used_percentage: 0, context_tokens: 0 }), "ctx 0% · 0");
    assert.equal(cacheLabel({ cache_read_input_tokens: 0 }), "cache read 0");
    assert.equal(costLabel(0), "session $0");
  });

  it("does not invent rate limits, cache age, or a rewrite price", () => {
    const line = render(full);
    assert.match(line, /Grok 4\.7/);
    assert.match(line, /▶/);
    assert.doesNotMatch(line, /warm|cold|5h|week|rewrite|secret-token/i);
  });
});

describe("weekly usage", () => {
  const now = Date.parse("2026-10-29T11:46:00Z");
  // a credits line as Grok logs it; `pad` lengthens the line without adding fields the script reads
  const creditsLine = (percent, pad = "") =>
    JSON.stringify({
      ts: "2026-10-29T11:37:35.772Z",
      msg: "billing: fetched credits config",
      ctx: {
        config: { creditUsagePercent: percent, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-11-02T22:57:09.651+00:00" } },
        pad,
      },
    });
  // make the entry for one log look six minutes old, so the next call re-reads it
  const ageCache = (cachePath, logPath) => {
    const body = JSON.parse(readFileSync(cachePath, "utf8"));
    body.sources[logPath].scannedAt = now - 6 * 60 * 1000;
    writeFileSync(cachePath, JSON.stringify(body));
  };
  const weekly = {
    percent: 23,
    periodType: "USAGE_PERIOD_TYPE_WEEKLY",
    periodEnd: "2026-11-02T22:57:09.651+00:00",
  };

  it("shows the weekly percent and the time until reset", () => {
    assert.equal(weeklyLabel(weekly, now), "week 23% · 4d11h");
    assert.equal(weeklyLabel({ ...weekly, percent: 0 }, now), "week 0% · 4d11h");
    assert.equal(weeklyLabel({ ...weekly, percent: 23.4 }, now), "week 23.4% · 4d11h");
  });

  it("shows how old the reading is once it is an hour old, and never invents an age", () => {
    const at = (iso) => ({ ...weekly, fetchedAt: iso });
    assert.equal(weeklyLabel(at("2026-10-29T11:00:00Z"), now), "week 23% · 4d11h");
    assert.equal(weeklyLabel(at("2026-10-29T10:46:00Z"), now), "week 23% (read 60m ago) · 4d11h");
    assert.equal(weeklyLabel(at("2026-10-29T10:45:00Z"), now), "week 23% (read 1h01m ago) · 4d11h");
    assert.equal(weeklyLabel(at("2026-10-28T19:46:00Z"), now), "week 23% (read 16h00m ago) · 4d11h");
    assert.equal(weeklyLabel(at("2026-10-26T01:46:00Z"), now), "week 23% (read 3d10h ago) · 4d11h");
    assert.equal(weeklyLabel(weekly, now), "week 23% · 4d11h");
    assert.equal(weeklyLabel(at("not a time"), now), "week 23% · 4d11h");
    assert.equal(weeklyLabel(at("2026-10-29T13:00:00Z"), now), "week 23% · 4d11h");
  });

  it("accepts only a period type that ends in _WEEKLY", () => {
    assert.equal(weeklyLabel({ ...weekly, periodType: "USAGE_PERIOD_TYPE_BIWEEKLY" }, now), null);
    assert.equal(weeklyLabel({ ...weekly, periodType: "USAGE_PERIOD_TYPE_WEEKLY_EXTRA" }, now), null);
  });

  it("omits a monthly period, a finished week, and a missing reading", () => {
    assert.equal(weeklyLabel({ ...weekly, periodType: "USAGE_PERIOD_TYPE_MONTHLY" }, now), null);
    assert.equal(weeklyLabel({ ...weekly, periodEnd: "2026-10-27T08:35:33.435842+00:00" }, now), null);
    assert.equal(weeklyLabel(null, now), null);
    const labels = segments(full).map((part) => part.label);
    assert.equal(labels.some((label) => /^week /i.test(label)), false);
  });

  it("reads the last credits line and keeps every other field out of the cache", () => {
    const dir = mkdtempSync(join(tmpdir(), "csb-week-"));
    const logPath = join(dir, "unified.jsonl");
    const cachePath = join(dir, "usage.json");
    const line = JSON.stringify({
      ts: "2026-10-29T11:37:35.772Z",
      msg: "billing: fetched credits config",
      ctx: {
        config: {
          creditUsagePercent: 23,
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            end: "2026-11-02T22:57:09.651+00:00",
          },
        },
        subscriptionTier: "super-secret-tier",
        email: "user@example.com",
      },
    });
    writeFileSync(logPath, `noise\n${line}\nmore noise\n`);
    const first = loadWeekly(logPath, cachePath, now);
    assert.equal(weeklyLabel(first, now), "week 23% · 4d11h");
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    assert.deepEqual(Object.keys(cached).sort(), ["sources", "v"]);
    assert.equal(cached.v, 2);
    assert.deepEqual(Object.keys(cached.sources), [logPath]);
    const entry = cached.sources[logPath];
    assert.deepEqual(Object.keys(entry).sort(), ["record", "scannedAt", "sourceMtimeMs", "sourceSize"]);
    assert.deepEqual(Object.keys(entry.record).sort(), ["fetchedAt", "percent", "periodEnd", "periodType"]);
    assert.equal(JSON.stringify(cached).includes("super-secret-tier"), false);
    assert.equal(JSON.stringify(cached).includes("user@example.com"), false);

    writeFileSync(
      logPath,
      `${line}\n${JSON.stringify({
        ts: "2026-10-29T12:00:00Z",
        msg: "billing: fetched credits config",
        ctx: {
          config: {
            creditUsagePercent: 40,
            currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-11-02T22:57:09.651+00:00" },
          },
        },
      })}\n`,
    );
    assert.equal(loadWeekly(logPath, cachePath, now + 1000).percent, 23);
    ageCache(cachePath, logPath);
    assert.equal(loadWeekly(logPath, cachePath, now + 1000).percent, 40);
    writeFileSync(logPath, "no credits line\n");
    ageCache(cachePath, logPath);
    assert.equal(loadWeekly(logPath, cachePath, now + 2000).percent, 40);
  });

  it("scans a log with no credits line once per five minutes", () => {
    const dir = mkdtempSync(join(tmpdir(), "csb-week-"));
    const logPath = join(dir, "unified.jsonl");
    const cachePath = join(dir, "usage.json");
    writeFileSync(logPath, "no credits line\n");
    assert.equal(loadWeekly(logPath, cachePath, now), null);
    const entry = JSON.parse(readFileSync(cachePath, "utf8")).sources[logPath];
    assert.equal(entry.scannedAt, now);
    assert.equal(entry.record, null);
    // a credits line that shows up inside the window is not seen: the log was not re-read
    writeFileSync(logPath, `${creditsLine(61)}\n`);
    assert.equal(loadWeekly(logPath, cachePath, now + 60 * 1000), null);
    assert.equal(loadWeekly(logPath, cachePath, now + 6 * 60 * 1000).percent, 61);
  });

  it("drops the cached reading when the newest credits line cannot be used", () => {
    const dir = mkdtempSync(join(tmpdir(), "csb-week-"));
    const logPath = join(dir, "unified.jsonl");
    const cachePath = join(dir, "usage.json");
    writeFileSync(logPath, `${creditsLine(23)}\n`);
    assert.equal(loadWeekly(logPath, cachePath, now).percent, 23);
    const noPercent = JSON.stringify({
      ts: "2026-10-29T12:00:00Z",
      msg: "billing: fetched credits config",
      ctx: { config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-11-02T22:57:09.651+00:00" } } },
    });
    writeFileSync(logPath, `${creditsLine(23)}\n${noPercent}\n`);
    ageCache(cachePath, logPath);
    assert.equal(loadWeekly(logPath, cachePath, now + 1000), null);
    assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).sources[logPath].record, null);
  });

  it("re-reads when the cached scan time is in the future", () => {
    const dir = mkdtempSync(join(tmpdir(), "csb-week-"));
    const logPath = join(dir, "unified.jsonl");
    const cachePath = join(dir, "usage.json");
    writeFileSync(logPath, "no credits line\n");
    assert.equal(loadWeekly(logPath, cachePath, now + 60 * 60 * 1000), null);
    writeFileSync(logPath, `${creditsLine(61)}\n`);
    // the clock went back an hour: the stored scan time must not hold the throttle
    assert.equal(loadWeekly(logPath, cachePath, now).percent, 61);
    assert.deepEqual(readdirSync(dir).sort(), ["unified.jsonl", "usage.json"]);
  });

  it("does not re-read an unchanged log with no credits line after the window", () => {
    const dir = mkdtempSync(join(tmpdir(), "csb-week-"));
    const logPath = join(dir, "unified.jsonl");
    const cachePath = join(dir, "usage.json");
    writeFileSync(logPath, "no credits line\n");
    assert.equal(loadWeekly(logPath, cachePath, now), null);
    assert.equal(loadWeekly(logPath, cachePath, now + 6 * 60 * 1000), null);
    // same size and time as at the first scan: the entry is not rewritten
    assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).sources[logPath].scannedAt, now);
  });

  it("keeps a separate entry for each log in one cache file", () => {
    const dir = mkdtempSync(join(tmpdir(), "csb-week-"));
    const cachePath = join(dir, "usage.json");
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    writeFileSync(a, `${creditsLine(23)}\n`);
    writeFileSync(b, `${creditsLine(61)}\n`);
    assert.equal(loadWeekly(a, cachePath, now).percent, 23);
    assert.equal(loadWeekly(b, cachePath, now + 1000).percent, 61);
    const sources = JSON.parse(readFileSync(cachePath, "utf8")).sources;
    assert.deepEqual(Object.keys(sources).sort(), [a, b].sort());
    assert.equal(sources[a].record.percent, 23);
    assert.equal(sources[b].record.percent, 61);
    // both are served from the cache while it is fresh
    writeFileSync(a, "gone\n");
    writeFileSync(b, "gone\n");
    assert.equal(loadWeekly(a, cachePath, now + 2000).percent, 23);
    assert.equal(loadWeekly(b, cachePath, now + 3000).percent, 61);
  });

  it("treats the old single-entry cache file as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "csb-week-"));
    const logPath = join(dir, "unified.jsonl");
    const cachePath = join(dir, "usage.json");
    writeFileSync(logPath, "no credits line\n");
    writeFileSync(
      cachePath,
      JSON.stringify({
        source: logPath,
        sourceMtimeMs: 1,
        sourceSize: 1,
        scannedAt: now,
        record: { percent: 99, periodType: "USAGE_PERIOD_TYPE_WEEKLY", periodEnd: "2026-11-02T22:57:09.651+00:00", fetchedAt: null },
      }),
    );
    assert.equal(loadWeekly(logPath, cachePath, now + 1000), null);
    assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).v, 2);
  });

  it("does not show one log's reading for another log that shares the cache", () => {
    const dir = mkdtempSync(join(tmpdir(), "csb-week-"));
    const cachePath = join(dir, "usage.json");
    const credits = (percent) =>
      `${JSON.stringify({
        ts: "2026-10-29T11:37:35.772Z",
        msg: "billing: fetched credits config",
        ctx: { config: { creditUsagePercent: percent, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-11-02T22:57:09.651+00:00" } } },
      })}\n`;
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    writeFileSync(a, credits(23));
    writeFileSync(b, "no credits line\n");
    assert.equal(loadWeekly(a, cachePath, now).percent, 23);
    assert.equal(loadWeekly(b, cachePath, now + 1000), null);
    writeFileSync(b, credits(61));
    assert.equal(loadWeekly(b, cachePath, now + 6 * 60 * 1000).percent, 61);
    assert.equal(loadWeekly(a, cachePath, now + 6 * 60 * 1000 + 1000).percent, 23);
  });
});

describe("readLastBilling", () => {
  const credits = (percent, pad = "") =>
    JSON.stringify({
      ts: "2026-10-29T11:37:35.772Z",
      msg: "billing: fetched credits config",
      ctx: {
        config: { creditUsagePercent: percent, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-11-02T22:57:09.651+00:00" } },
        pad,
      },
    });
  const log = (body) => {
    const path = join(mkdtempSync(join(tmpdir(), "csb-bill-")), "unified.jsonl");
    writeFileSync(path, body);
    return path;
  };

  it("stops at the newest credits line even when it cannot be used", () => {
    const noPercent = JSON.stringify({
      ts: "2026-10-29T12:00:00Z",
      msg: "billing: fetched credits config",
      ctx: { config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-11-02T22:57:09.651+00:00" } } },
    });
    assert.equal(readLastBilling(log(`${credits(23)}\n${noPercent}\nnoise\n`)), null);
  });

  it("skips a line that only mentions the marker text", () => {
    const mention = JSON.stringify({ ts: "2026-10-29T12:00:00Z", msg: "other", ctx: { note: "billing: fetched credits config" } });
    assert.equal(readLastBilling(log(`${credits(23)}\n${mention}\n`)).percent, 23);
  });

  it("finds a credits line that straddles the chunk boundary", () => {
    const chunk = 256 * 1024;
    const line = credits(37, "p".repeat(400));
    const before = `${"a".repeat(999)}\n`;
    // the file ends so that size - chunk falls in the middle of the credits line
    const after = `${"z".repeat(chunk + Math.floor(line.length / 2) - line.length - 2)}\n`;
    const body = `${before}${line}\n${after}`;
    const boundary = body.length - chunk;
    assert.ok(boundary > before.length && boundary < before.length + line.length);
    assert.equal(readLastBilling(log(body)).percent, 37);
  });

  it("does not look past maxBytes", () => {
    const path = log(`${credits(23)}\n${"z".repeat(10000)}\n`);
    assert.equal(readLastBilling(path).percent, 23);
    assert.equal(readLastBilling(path, 2048), null);
  });
});

describe("display", () => {
  it("capitalises the first word and leaves a number or an email alone", () => {
    assert.equal(capFirst("● cache warm 42m"), "● Cache warm 42m");
    assert.equal(capFirst("high"), "High");
    assert.equal(capFirst("5h 43% · 2h17m"), "5h 43% · 2h17m");
    assert.equal(capFirst("you@example.com"), "you@example.com");
  });

  it("formats a reset under a day as hours and minutes, and past a day as days and hours", () => {
    const at = Date.parse("2026-10-29T08:00:00Z");
    assert.equal(remaining(Date.parse("2026-10-29T11:30:00Z") - at), "3h30m");
    assert.equal(remaining(Date.parse("2026-11-04T22:00:00Z") - at), "6d14h");
    assert.equal(remaining(Date.parse("2026-10-30T07:05:00Z") - at), "23h05m");
    assert.equal(remaining(Date.parse("2026-10-29T08:40:00Z") - at), "40m");
    assert.equal(remaining(177 * 3600000 + 48 * 60000), "7d9h");
    assert.equal(remaining(-1), null);
  });

  it("alternates dark and light shades that meet the contrast floors", () => {
    assert.equal(shade("model", 0).bg, HUES.model[0]);
    assert.equal(shade("effort", 1).bg, HUES.effort[1]);
    for (const [dark, light] of Object.values(HUES)) {
      assert.ok(contrast(dark, "#ffffff") >= 4.5);
      assert.ok(contrast(light, "#1e1e1e") >= 4.5);
      for (const [, otherLight] of Object.values(HUES)) assert.ok(contrast(dark, otherLight) >= 3);
    }
  });

  it("puts an arrow only between segments", () => {
    const plain = render(full).replace(/\x1b\[[0-9;]*m/g, "");
    assert.equal(plain.endsWith("▶"), false);
    assert.equal(plain.split("▶").length - 1, segments(full).length - 1);
    assert.match(plain, /Session \$0\.04 $/);
  });
});

describe("cli", () => {
  it("prints the band for a JSON payload on stdin", () => {
    const run = spawnSync(process.execPath, ["statusline.mjs"], {
      cwd: import.meta.dirname,
      env: { ...process.env, CSB_BILLING_LOG: "" },
      input: JSON.stringify(full),
      encoding: "utf8",
    });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /Ctx 29%/);
    assert.equal(run.stdout.includes("secret-token"), false);
    assert.equal(run.stderr, "");
  });

  it("prints the weekly block from a credits log and nothing else in that line", () => {
    const dir = mkdtempSync(join(tmpdir(), "csb-cli-"));
    const logPath = join(dir, "unified.jsonl");
    const cachePath = join(dir, "usage.json");
    writeFileSync(
      logPath,
      `${JSON.stringify({
        ts: "2026-10-29T11:37:35.772Z",
        msg: "billing: fetched credits config",
        ctx: {
          config: {
            creditUsagePercent: 23,
            // a period that has not ended yet: an ended one is hidden, which made this test expire
            currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: new Date(Date.now() + 3 * 86400000).toISOString() },
          },
          subscriptionTier: "super-secret-tier",
          email: "user@example.com",
        },
      })}\n`,
    );
    const run = spawnSync(process.execPath, ["statusline.mjs"], {
      cwd: import.meta.dirname,
      env: { ...process.env, CSB_BILLING_LOG: logPath, CSB_USAGE_CACHE: cachePath },
      input: JSON.stringify({ model: { display_name: "Grok 4.7" } }),
      encoding: "utf8",
    });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /Grok 4\.7/);
    assert.match(run.stdout, /Week 23%/);
    assert.equal(run.stdout.includes("super-secret-tier"), false);
    assert.equal(run.stdout.includes("user@example.com"), false);
    assert.equal(run.stdout.includes("secret-token"), false);
  });

  it("starts through the windows cmd wrapper", { skip: process.platform !== "win32" }, () => {
    const run = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", join(import.meta.dirname, "statusline.cmd")], {
      cwd: import.meta.dirname,
      env: { ...process.env, CSB_BILLING_LOG: "" },
      input: JSON.stringify({
        model: { display_name: "Grok 4.7" },
        authorization: "secret-token-should-not-appear",
      }),
      encoding: "utf8",
    });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /Grok 4\.7/);
    assert.equal(run.stdout.includes("secret-token"), false);
  });

  it("prints the band when started through a junction or symlink to the folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "csb-link-"));
    const link = join(dir, "grok-link");
    symlinkSync(import.meta.dirname, link, process.platform === "win32" ? "junction" : "dir");
    try {
      const run = spawnSync(process.execPath, [join(link, "statusline.mjs")], {
        env: { ...process.env, CSB_BILLING_LOG: "", CSB_USAGE_CACHE: join(dir, "usage.json") },
        input: JSON.stringify({ model: { display_name: "Grok 4.7" } }),
        encoding: "utf8",
      });
      assert.equal(run.status, 0);
      assert.match(run.stdout, /Grok 4\.7/);
    } finally {
      // remove the link only, never the folder it points to
      unlinkSync(link);
    }
    assert.ok(existsSync(join(import.meta.dirname, "statusline.mjs")));
  });

  it("fails closed on stdin that is not JSON", () => {
    const run = spawnSync(process.execPath, ["statusline.mjs"], {
      cwd: import.meta.dirname,
      env: { ...process.env, CSB_BILLING_LOG: "" },
      input: "not-json",
      encoding: "utf8",
    });
    assert.notEqual(run.status, 0);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /not a JSON object/);
  });
});
