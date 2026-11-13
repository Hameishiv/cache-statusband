import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { after, describe, it } from "node:test";
import {
  billingLogPath,
  cacheLabel,
  capFirst,
  contextLabel,
  contrast,
  costLabel,
  formatTokens,
  HUES,
  loadWeekly,
  percentText,
  readLastBilling,
  readSources,
  remaining,
  render,
  segments,
  shade,
  usageCachePath,
  weeklyLabel,
} from "./statusline.mjs";

// the shell running the suite may export COLUMNS; the spawned CLI must not fit itself to it
delete process.env.COLUMNS;

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

// every temp folder a test makes is removed when the run ends
const made = [];
function tempDir(prefix) {
  const dir = mkdtempSync(prefix);
  made.push(dir);
  return dir;
}
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

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

  it("keeps the line to one line with no control codes from the payload", () => {
    const labels = segments({ model: { display_name: "Grok\n4.7\u001b[2J" }, effort: { level: "\u0007high" } }).map((p) => p.label);
    assert.deepEqual(labels, ["Grok 4.7 [2J", "High"]);
    assert.equal(segments({ model: { display_name: "\u001b\n" } }).length, 0);
  });

  it("rounds a fractional context percent to a tenth", () => {
    assert.equal(contextLabel({ used_percentage: 28.699999999999996 }), "ctx 28.7%");
    assert.equal(contextLabel({ used_percentage: 29 }), "ctx 29%");
    assert.equal(contextLabel({ used_percentage: -3 }), null);
    assert.equal(contextLabel({ used_percentage: -0.04 }), null);
  });

  it("keeps a real zero", () => {
    assert.equal(contextLabel({ used_percentage: 0, context_tokens: 0 }), "ctx 0% · 0");
    assert.equal(cacheLabel({ cache_read_input_tokens: 0 }), "cache read 0");
    // rounding never carries a figure into the next unit
    assert.equal(formatTokens(999949), "1M");
    assert.equal(formatTokens(999.6), "1k");
    assert.equal(formatTokens(999.4), "999");
    assert.equal(formatTokens(999499), "999k");
    assert.equal(formatTokens(999500), "1M");
    assert.equal(costLabel(9.999), "session $10");
    assert.equal(costLabel(9.994), "session $9.99");
    // a write count alone still says it is a cache figure
    assert.equal(cacheLabel({ cache_creation_input_tokens: 1500 }), "cache write 1.5k");
    assert.equal(costLabel(0), "session $0");
    // a negative count or amount is not a known figure
    assert.equal(costLabel(-0.04), null);
    assert.equal(costLabel(-0.004), null);
    assert.equal(cacheLabel({ cache_read_input_tokens: -80000 }), null);
    assert.equal(contextLabel({ context_tokens: -1500, context_window_size: 1e6 }), null);
    assert.equal(contextLabel({ used_percentage: 29, context_tokens: -1500 }), "ctx 29%");
    assert.equal(contextLabel({ context_tokens: 1500, context_window_size: 0 }), "ctx 1.5k");
    // Grok rounds to whole percents; the token counts say whether 0 or 100 is exact
    assert.equal(contextLabel({ used_percentage: 0, context_tokens: 3000, context_window_size: 2e6 }), "ctx <1% · 3k/2M");
    assert.equal(contextLabel({ used_percentage: 0, context_tokens: 0, context_window_size: 2e6 }), "ctx 0% · 0/2M");
    assert.equal(contextLabel({ used_percentage: 100, context_tokens: 1992000, context_window_size: 2e6 }), "ctx >99% · 2M/2M");
    assert.equal(contextLabel({ used_percentage: 100, context_tokens: 2e6, context_window_size: 2e6 }), "ctx 100% · 2M/2M");
    assert.equal(contextLabel({ used_percentage: 100, context_tokens: 300000, context_window_size: 256000 }), "ctx >100% · 300k/256k");
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
    fetchedAt: "2026-10-29T11:00:00Z",
  };

  it("shows the weekly percent and the time until reset", () => {
    assert.equal(weeklyLabel(weekly, now), "week 23% · 4d11h");
    assert.equal(weeklyLabel({ ...weekly, percent: 0 }, now), "week 0% · 4d11h");
    assert.equal(weeklyLabel({ ...weekly, percent: 23.4 }, now), "week 23.4% · 4d11h");
  });

  it("shows how old the reading is once it is an hour old, and marks an unknown read time", () => {
    const at = (iso) => ({ ...weekly, fetchedAt: iso });
    assert.equal(weeklyLabel(at("2026-10-29T11:00:00Z"), now), "week 23% · 4d11h");
    assert.equal(weeklyLabel(at("2026-10-29T10:46:00Z"), now), "week 23% (read 60m ago) · 4d11h");
    assert.equal(weeklyLabel(at("2026-10-29T10:45:00Z"), now), "week 23% (read 1h01m ago) · 4d11h");
    assert.equal(weeklyLabel(at("2026-10-28T19:46:00Z"), now), "week 23% (read 16h00m ago) · 4d11h");
    assert.equal(weeklyLabel(at("2026-10-26T01:46:00Z"), now), "week 23% (read 3d10h ago) · 4d11h");
    assert.equal(weeklyLabel(weekly, now), "week 23% · 4d11h");
    assert.equal(weeklyLabel(at("not a time"), now), "week 23% (read time unknown) · 4d11h");
    assert.equal(weeklyLabel({ ...weekly, fetchedAt: null }, now), "week 23% (read time unknown) · 4d11h");
    assert.equal(weeklyLabel(at("2026-10-29T13:00:00Z"), now), "week 23% (read time unknown) · 4d11h");
    // a few minutes of clock skew is not a moved clock
    assert.equal(weeklyLabel(at("2026-10-29T11:50:00Z"), now), "week 23% · 4d11h");
    assert.equal(weeklyLabel(at("2026-10-29T11:52:00Z"), now), "week 23% (read time unknown) · 4d11h");
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
    const dir = tempDir(join(tmpdir(), "csb-week-"));
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

  it("scans a log with no credits line once per re-read interval", () => {
    const dir = tempDir(join(tmpdir(), "csb-week-"));
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
    const dir = tempDir(join(tmpdir(), "csb-week-"));
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
    const dir = tempDir(join(tmpdir(), "csb-week-"));
    const logPath = join(dir, "unified.jsonl");
    const cachePath = join(dir, "usage.json");
    writeFileSync(logPath, "no credits line\n");
    assert.equal(loadWeekly(logPath, cachePath, now + 60 * 60 * 1000), null);
    writeFileSync(logPath, `${creditsLine(61)}\n`);
    // the clock went back an hour: the stored scan time must not hold the throttle
    assert.equal(loadWeekly(logPath, cachePath, now).percent, 61);
    assert.deepEqual(readdirSync(dir).sort(), ["unified.jsonl", "usage.json"]);
  });

  it("keeps the reading, and does not re-date the cache, when the log cannot be read", () => {
    const dir = tempDir(join(tmpdir(), "csb-week-"));
    const logPath = join(dir, "unified.jsonl");
    const cachePath = join(dir, "usage.json");
    writeFileSync(logPath, `${creditsLine(23)}\n`);
    assert.equal(loadWeekly(logPath, cachePath, now).percent, 23);
    ageCache(cachePath, logPath);
    const before = JSON.parse(readFileSync(cachePath, "utf8")).sources[logPath];
    // a directory where the log should be: stat works, reading it does not
    rmSync(logPath);
    mkdirSync(logPath);
    assert.equal(loadWeekly(logPath, cachePath, now + 1000).percent, 23);
    assert.deepEqual(JSON.parse(readFileSync(cachePath, "utf8")).sources[logPath], before);
  });

  it("writes no cache entry for a log it could not read", () => {
    const dir = tempDir(join(tmpdir(), "csb-week-"));
    const logPath = join(dir, "unified.jsonl");
    const cachePath = join(dir, "usage.json");
    mkdirSync(logPath);
    assert.equal(loadWeekly(logPath, cachePath, now), null);
    assert.equal(existsSync(cachePath), false);
  });

  it("leaves a cache file it cannot read as it is", () => {
    const dir = tempDir(join(tmpdir(), "csb-week-"));
    const logPath = join(dir, "unified.jsonl");
    // a folder where the cache file should be: it exists but cannot be read as a file
    const cachePath = join(dir, "usage.json");
    mkdirSync(cachePath);
    writeFileSync(join(cachePath, "keep"), "x");
    writeFileSync(logPath, `${creditsLine(23)}\n`);
    assert.equal(loadWeekly(logPath, cachePath, now).percent, 23);
    assert.deepEqual(readdirSync(cachePath), ["keep"]);
    assert.deepEqual(readdirSync(dir).sort(), ["unified.jsonl", "usage.json"]);
  });

  it("does not rewrite a cache file it could not read, and does not use its entries", () => {
    const dir = tempDir(join(tmpdir(), "csb-week-"));
    const logPath = join(dir, "unified.jsonl");
    const cachePath = join(dir, "usage.json");
    // a fresh entry for this very log: read normally, it would be shown
    const planted = { scannedAt: now, record: { percent: 99, periodType: "USAGE_PERIOD_TYPE_WEEKLY", periodEnd: "2026-11-02T22:57:09.651Z", fetchedAt: "2026-10-29T11:37:35.772Z" } };
    const body = JSON.stringify({ v: 2, sources: { [logPath]: planted } });
    writeFileSync(cachePath, body);
    writeFileSync(logPath, "{}\n");
    assert.equal(loadWeekly(logPath, cachePath, now).percent, 99);
    // the read fails (a lock, a permission error): the file on disk must be left exactly as it was
    assert.equal(loadWeekly(logPath, cachePath, now, () => null), null);
    assert.equal(readFileSync(cachePath, "utf8"), body);
    writeFileSync(logPath, `${creditsLine(23)}\n`);
    assert.equal(loadWeekly(logPath, cachePath, now, () => null).percent, 23);
    assert.equal(readFileSync(cachePath, "utf8"), body);
  });

  it("does not open a named pipe as the log", { skip: process.platform === "win32" }, (t) => {
    const dir = tempDir(join(tmpdir(), "csb-week-"));
    const logPath = join(dir, "unified.jsonl");
    if (spawnSync("mkfifo", [logPath]).status !== 0) return t.skip("mkfifo is not available");
    // run in a child with a time limit: opening a pipe with no writer would hang, not fail
    const run = spawnSync(process.execPath, [join(import.meta.dirname, "statusline.mjs")], {
      env: { ...process.env, CSB_BILLING_LOG: logPath, CSB_USAGE_CACHE: join(dir, "usage.json") },
      input: JSON.stringify({ model: { display_name: "Grok 4.7" } }),
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(run.signal, null);
    assert.equal(run.status, 0);
    assert.doesNotMatch(run.stdout, /Week/);
  });

  it("does not read a named pipe as the cache", { skip: process.platform === "win32" }, (t) => {
    const dir = tempDir(join(tmpdir(), "csb-week-"));
    const cachePath = join(dir, "usage.json");
    if (spawnSync("mkfifo", [cachePath]).status !== 0) return t.skip("mkfifo is not available");
    writeFileSync(join(dir, "unified.jsonl"), "");
    const run = spawnSync(process.execPath, [join(import.meta.dirname, "statusline.mjs")], {
      env: { ...process.env, CSB_BILLING_LOG: join(dir, "unified.jsonl"), CSB_USAGE_CACHE: cachePath },
      input: JSON.stringify({ model: { display_name: "Grok 4.7" } }),
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(run.signal, null);
    assert.equal(run.status, 0);
    // left in place, not replaced by a cache file
    assert.ok(statSync(cachePath).isFIFO());
  });

  it("tells a missing cache from one it cannot read", () => {
    const dir = tempDir(join(tmpdir(), "csb-week-"));
    assert.deepEqual(readSources(join(dir, "missing.json")), {});
    writeFileSync(join(dir, "bad.json"), "not json");
    assert.equal(readSources(join(dir, "bad.json")), null);
    // a file of some other shape, say from a mistyped CSB_USAGE_CACHE, is not ours to rewrite
    writeFileSync(join(dir, "other.json"), '{"name":"something else"}');
    assert.equal(readSources(join(dir, "other.json")), null);
    mkdirSync(join(dir, "folder.json"));
    assert.equal(readSources(join(dir, "folder.json")), null);
  });

  it("does not re-read an unchanged log with no credits line after the window", () => {
    const dir = tempDir(join(tmpdir(), "csb-week-"));
    const logPath = join(dir, "unified.jsonl");
    const cachePath = join(dir, "usage.json");
    writeFileSync(logPath, "no credits line\n");
    assert.equal(loadWeekly(logPath, cachePath, now), null);
    assert.equal(loadWeekly(logPath, cachePath, now + 6 * 60 * 1000), null);
    // same size and time as at the first scan: the entry is not rewritten
    assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).sources[logPath].scannedAt, now);
  });

  it("keeps a separate entry for each log in one cache file", () => {
    const dir = tempDir(join(tmpdir(), "csb-week-"));
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

  it("leaves a cache file in a newer format as it is", () => {
    const dir = tempDir(join(tmpdir(), "csb-week-"));
    const cachePath = join(dir, "usage.json");
    writeFileSync(cachePath, JSON.stringify({ v: 3, other: {} }));
    assert.equal(readSources(cachePath), null);
  });

  it("treats the old single-entry cache file as empty", () => {
    const dir = tempDir(join(tmpdir(), "csb-week-"));
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
    const dir = tempDir(join(tmpdir(), "csb-week-"));
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

describe("home folder", () => {
  it("uses no log and no cache when the home folder is relative", () => {
    const names = ["USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "GROK_HOME", "CSB_BILLING_LOG", "CSB_USAGE_CACHE", "LOCALAPPDATA", "XDG_CACHE_HOME"];
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) delete process.env[name];
      process.env.USERPROFILE = "relhome";
      process.env.HOME = "relhome";
      assert.equal(billingLogPath(), null);
      assert.equal(usageCachePath(), null);
      if (process.platform === "win32") {
        process.env.USERPROFILE = String.raw`\relhome`;
        assert.equal(billingLogPath(), null);
        assert.equal(usageCachePath(), null);
      }
    } finally {
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  });
});

describe("billingLogPath", () => {
  const keep = { log: process.env.CSB_BILLING_LOG, home: process.env.GROK_HOME };
  const restore = () => {
    for (const [key, value] of [["CSB_BILLING_LOG", keep.log], ["GROK_HOME", keep.home]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  it("shows nothing for a relative log setting, which would point inside the open repository", () => {
    try {
      delete process.env.CSB_BILLING_LOG;
      delete process.env.GROK_HOME;
      const fallback = billingLogPath();
      assert.equal(isAbsolute(fallback), true);
      // a log that was asked for by a relative path shows nothing, never the default log's reading
      process.env.CSB_BILLING_LOG = join("rel", "unified.jsonl");
      assert.equal(billingLogPath(), null);
      // a plain string, not join(), which would already collapse the ".."
      process.env.CSB_BILLING_LOG = `${tmpdir()}/a/../b.jsonl`;
      assert.equal(billingLogPath(), join(tmpdir(), "b.jsonl"));
      delete process.env.CSB_BILLING_LOG;
      if (process.platform === "win32") {
        // "\x" hangs off whichever drive is current; a UNC path is a full path
        process.env.GROK_HOME = String.raw`\grokhome`;
        assert.equal(billingLogPath(), null);
        process.env.GROK_HOME = String.raw`\\`;
        assert.equal(billingLogPath(), null);
        process.env.GROK_HOME = String.raw`\\srv\share\home`;
        assert.equal(billingLogPath(), String.raw`\\srv\share\home\logs\unified.jsonl`);
      }
      process.env.GROK_HOME = "relhome";
      assert.equal(billingLogPath(), null);
      const abs = join(tmpdir(), "grok-home");
      process.env.GROK_HOME = abs;
      assert.equal(billingLogPath(), join(abs, "logs", "unified.jsonl"));
      process.env.CSB_BILLING_LOG = "";
      assert.equal(billingLogPath(), null);
    } finally {
      restore();
    }
  });

  it("ignores a relative cache setting", () => {
    const keepCache = process.env.CSB_USAGE_CACHE;
    try {
      delete process.env.CSB_USAGE_CACHE;
      const fallback = usageCachePath();
      assert.equal(isAbsolute(fallback), true);
      process.env.CSB_USAGE_CACHE = join("rel", "usage.json");
      assert.equal(usageCachePath(), fallback);
      delete process.env.CSB_USAGE_CACHE;
      const baseVar = process.platform === "win32" ? "LOCALAPPDATA" : "XDG_CACHE_HOME";
      const keepBase = process.env[baseVar];
      try {
        process.env[baseVar] = "relbase";
        assert.equal(isAbsolute(usageCachePath()), true);
        assert.equal(usageCachePath().startsWith("relbase"), false);
      } finally {
        if (keepBase === undefined) delete process.env[baseVar];
        else process.env[baseVar] = keepBase;
      }
    } finally {
      if (keepCache === undefined) delete process.env.CSB_USAGE_CACHE;
      else process.env.CSB_USAGE_CACHE = keepCache;
    }
  });
});

describe("render width", () => {
  it("prints nothing when even the model name is wider than the row: it carries a version", () => {
    assert.equal(render({ model: { display_name: "Grok 4.7" } }, { columns: 7 }), "");
    assert.match(render({ model: { display_name: "Grok 4.7" } }, { columns: 10 }), /Grok 4\.7/);
  });

  it("prints nothing when a lone figure is wider than the row", () => {
    const line = render({ context_window: { used_percentage: 29, context_window_size: 1e6, context_tokens: 287000 } }, { columns: 5 });
    assert.equal(line, "");
  });

  const payload = {
    model: { display_name: "Grok 4.7" },
    effort: { level: "high" },
    context_window: { used_percentage: 29, context_window_size: 1e6, context_tokens: 287000 },
    cost: { total_cost_usd: 12.5 },
  };
  const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");

  it("drops trailing segments whole until the band fits the row", () => {
    const full = plain(render(payload));
    assert.match(full, /Session \$13/);
    for (const columns of [10, 20, 25, 35, 40, [...full].length - 1]) {
      const line = plain(render(payload, { columns }));
      assert.ok([...line].length <= columns, `${columns}: ${line}`);
      // never part of a number: the cost is either whole or gone
      if (line.includes("Session")) assert.match(line, /Session \$13 $/);
      if (line.includes("Ctx")) assert.match(line, /Ctx 29% · 287k\/1M /);
    }
    assert.equal(plain(render(payload, { columns: [...full].length })), full);
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
    const path = join(tempDir(join(tmpdir(), "csb-bill-")), "unified.jsonl");
    writeFileSync(path, body);
    return path;
  };

  it("shows no reading when a finished credits line is broken, not an older one", () => {
    const broken = '{"ts":"2026-10-29T12:00:00Z","msg":"billing: fetched credits config","ctx":{"config":{"creditUsag';
    assert.equal(readLastBilling(log(`${credits(24)}\n${broken}\n{"msg":"other"}\n`)), null);
  });

  it("passes over a credits line still being written at the end of the log", () => {
    const partial = '{"ts":"2026-10-29T12:00:00Z","msg":"billing: fetched credits config","ctx":{"config":{"creditUsag';
    assert.equal(readLastBilling(log(`${credits(24)}\n${partial}`)).percent, 24);
  });

  it("passes over an unfinished last line longer than one read chunk", () => {
    const partial = '{"ts":"2026-10-29T12:00:00Z","msg":"billing: fetched credits config","pad":"' + "x".repeat(300 * 1024);
    assert.equal(readLastBilling(log(`${credits(24)}\n${partial}`)).percent, 24);
  });

  it("does not take the weekly reset from the billing period", () => {
    const billingOnly = JSON.stringify({
      ts: "2026-10-29T12:00:00Z",
      msg: "billing: fetched credits config",
      ctx: {
        config: {
          creditUsagePercent: 23,
          currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
          billingPeriodEnd: "2026-11-02T22:57:09.651+00:00",
        },
      },
    });
    assert.equal(readLastBilling(log(`${billingOnly}\n`)), null);
  });

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
    // just under a day rounds to a whole day, never "24h00m"
    assert.equal(remaining(24 * 3600000 - 20000), "1d0h");
    assert.equal(remaining(20000), "<1m");
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
    const dir = tempDir(join(tmpdir(), "csb-cli-"));
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

  it("fits the row Grok reports in COLUMNS", () => {
    const run = spawnSync(process.execPath, ["statusline.mjs"], {
      cwd: import.meta.dirname,
      env: { ...process.env, CSB_BILLING_LOG: "", COLUMNS: "20" },
      input: JSON.stringify({ model: { display_name: "Grok 4.7" }, effort: { level: "high" }, cost: { total_cost_usd: 12.5 } }),
      encoding: "utf8",
    });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /Grok 4\.7/);
    assert.doesNotMatch(run.stdout, /Session/);
  });

  it("passes node's exit code through the windows cmd wrapper", { skip: process.platform !== "win32" }, () => {
    const run = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", join(import.meta.dirname, "statusline.cmd")], {
      cwd: import.meta.dirname,
      env: { ...process.env, CSB_BILLING_LOG: "" },
      input: "not json",
      encoding: "utf8",
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /not a JSON object/);
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

  it("does not run a node program from the folder it is started in", { skip: process.platform !== "win32" }, () => {
    const dir = tempDir(join(tmpdir(), "csb-cwd-"));
    writeFileSync(join(dir, "node.cmd"), "@echo HIJACKED-FROM-CWD\r\n");
    writeFileSync(join(dir, "node.bat"), "@echo HIJACKED-FROM-CWD\r\n");
    const base = { ...process.env, CSB_BILLING_LOG: "" };
    for (const key of Object.keys(base)) {
      if (key.toLowerCase() === "nodefaultcurrentdirectoryinexepath") delete base[key];
    }
    const pathKey = Object.keys(base).find((key) => key.toLowerCase() === "path") || "PATH";
    // the second case puts a relative folder first on PATH, which only leaving the folder blocks
    for (const env of [base, { ...base, [pathKey]: `.;${base[pathKey]}` }]) {
      const run = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", join(import.meta.dirname, "statusline.cmd")], {
        cwd: dir,
        env,
        input: JSON.stringify({ model: { display_name: "Grok 4.7" } }),
        encoding: "utf8",
      });
      assert.equal(run.stdout.includes("HIJACKED"), false);
      assert.equal(run.status, 0);
      assert.match(run.stdout, /Grok 4\.7/);
    }
  });

  it("prints the band when started through a junction or symlink to the folder", () => {
    const dir = tempDir(join(tmpdir(), "csb-link-"));
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

  it("fails closed on JSON that is not an object", () => {
    for (const input of ["null", "[]", "5", '"x"']) {
      const run = spawnSync(process.execPath, ["statusline.mjs"], {
        cwd: import.meta.dirname,
        env: { ...process.env, CSB_BILLING_LOG: "" },
        input,
        encoding: "utf8",
      });
      assert.equal(run.status, 1, input);
      assert.match(run.stderr, /not a JSON object/);
    }
  });
});

describe("percentText", () => {
  it("never rounds a figure into one it is not", () => {
    assert.equal(percentText(24), "24");
    assert.equal(percentText(28.7), "28.7");
    assert.equal(percentText(0), "0");
    assert.equal(percentText(0.04), "<0.1");
    assert.equal(percentText(0.05), "0.1");
    assert.equal(percentText(99.94), "99.9");
    assert.equal(percentText(99.96), ">99.9");
    assert.equal(percentText(99.95), ">99.9");
    assert.equal(percentText(100), "100");
    assert.equal(percentText(100.04), ">100");
    assert.equal(percentText(100.05), "100.1");
    assert.equal(percentText(-0.04), null);
  });
});
