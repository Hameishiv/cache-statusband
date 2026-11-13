import assert from "node:assert/strict";
import test from "node:test";
import { formatUsageLines } from "../src/format.mjs";
import { sanitizeRateLimits } from "../src/usage.mjs";

const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const rows = (count) => Array.from({ length: count }, (_, index) => ({ title: `Reset ${index + 1}`, expiresAt: 1_793_302_971 + index }));
const details = (snapshot) => formatUsageLines(snapshot, NOW, { includeResetDetails: true, locale: "en-US", timeZone: "UTC" }).join("\n");

test("reset rows cut by the plugin are reported as not shown, not as not supplied by Codex", () => {
  const safe = sanitizeRateLimits({ rateLimitResetCredits: { availableCount: 25, credits: rows(25) } });
  assert.equal(safe.credits.length, 20);
  assert.equal(safe.creditsOmitted, 5);
  const text = details({ ...safe, source: "live", fetchedAt: NOW });
  assert.match(text, /5 more reset expirations not shown\./);
  assert.doesNotMatch(text, /not supplied by Codex/);

  // Codex also under-reported: 25 sent, 30 counted. Each shortfall is named for what it is.
  const both = details({ ...sanitizeRateLimits({ rateLimitResetCredits: { availableCount: 30, credits: rows(25) } }), source: "live", fetchedAt: NOW });
  assert.match(both, /5 more reset expirations not shown\./);
  assert.match(both, /5 additional reset expirations were not supplied by Codex\./);
});

test("fewer rows than the count, with nothing cut, still says Codex did not supply them", () => {
  const safe = sanitizeRateLimits({ rateLimitResetCredits: { availableCount: 3, credits: rows(2) } });
  assert.equal(safe.creditsOmitted, 0);
  const text = details({ ...safe, source: "live", fetchedAt: NOW });
  assert.match(text, /1 additional reset expiration was not supplied by Codex\./);
  assert.doesNotMatch(text, /not shown/);
  // A cache written before the field existed has no creditsOmitted: it reads as zero.
  const old = details({ availableCount: 3, credits: rows(2), source: "cache", fetchedAt: NOW });
  assert.match(old, /1 additional reset expiration was not supplied by Codex\./);
});

test("an explicit null expiresAt reads 'does not expire'; a missing or invalid one stays 'expiration not supplied'", () => {
  const safe = sanitizeRateLimits({
    rateLimitResetCredits: {
      availableCount: 4,
      credits: [
        { title: "Forever", expiresAt: null },
        { title: "Silent" },
        { title: "Garbled", expiresAt: "soon" },
        { title: "Dated", expiresAt: 1_793_302_971 },
      ],
    },
  });
  assert.deepEqual(safe.credits.map((credit) => credit.neverExpires), [true, undefined, undefined, undefined]);
  const text = details({ ...safe, source: "live", fetchedAt: NOW });
  assert.match(text, /Forever — does not expire/);
  assert.match(text, /Silent — expiration not supplied/);
  assert.match(text, /Garbled — expiration not supplied/);
  assert.match(text, /Dated — expires /);
  // The flag survives the cache's JSON round trip.
  const cached = details({ ...JSON.parse(JSON.stringify(safe)), source: "cache", fetchedAt: NOW });
  assert.match(cached, /Forever — does not expire/);
});

test("rows Codex sent beyond its own count are described against that count", () => {
  const safe = sanitizeRateLimits({ rateLimitResetCredits: { availableCount: 20, credits: rows(25) } });
  assert.equal(safe.creditsOmitted, 5);
  const text = details({ ...safe, source: "live", fetchedAt: NOW });
  assert.match(text, /Banked resets: 20/);
  assert.match(text, /5 more rows beyond Codex's count of 20 not shown\./);
  assert.doesNotMatch(text, /more reset expirations not shown|not supplied by Codex/);
  const one = details({ ...sanitizeRateLimits({ rateLimitResetCredits: { availableCount: 20, credits: rows(21) } }), source: "live", fetchedAt: NOW });
  assert.match(one, /1 more row beyond Codex's count of 20 not shown\./);
});

test("reset rows whose status is not 'available' are dropped and counted apart from the 20-row cap", () => {
  const credits = [
    { title: "Usable", expiresAt: 1_793_302_971, status: "available" },
    { title: "No status", expiresAt: 1_793_302_972 },
    { title: "Null status", expiresAt: 1_793_302_973, status: null },
    { title: "Spent", expiresAt: 1_793_302_974, status: "redeeming" },
    { title: "Lapsed", expiresAt: 1_793_302_975, status: "redeemed" },
    { title: "Unsure", expiresAt: 1_793_302_977, status: "unknown" },
    { title: "Odd", expiresAt: 1_793_302_976, status: 7 },
  ];
  const safe = sanitizeRateLimits({ rateLimitResetCredits: { availableCount: 3, credits } });
  assert.deepEqual(safe.credits.map((credit) => credit.title), ["Usable", "No status", "Null status"]);
  assert.equal(safe.creditsNotAvailable, 4);
  assert.equal(safe.creditsOmitted, 0);
  const text = details({ ...safe, source: "live", fetchedAt: NOW });
  assert.doesNotMatch(text, /Spent|Lapsed|Unsure|Odd/);
  // Dropped for status is not "cut by the cap" and not "not supplied by Codex".
  assert.doesNotMatch(text, /not shown|not supplied by Codex/);

  // With many unusable rows and few usable ones, nothing is reported as cut by the cap.
  const many = [...rows(5), ...Array.from({ length: 30 }, () => ({ title: "Spent", status: "redeemed" }))];
  const capped = sanitizeRateLimits({ rateLimitResetCredits: { availableCount: 5, credits: many } });
  assert.equal(capped.credits.length, 5);
  assert.equal(capped.creditsOmitted, 0);
  assert.equal(capped.creditsNotAvailable, 30);
  assert.doesNotMatch(details({ ...capped, source: "live", fetchedAt: NOW }), /not shown/);
});

test("rows dropped for their status come out of the 'not supplied' remainder and are worded separately", () => {
  const dropped = (count) => Array.from({ length: count }, () => ({ title: "Spent", expiresAt: 1_793_302_999, status: "redeemed" }));
  // Codex counts 5; 3 usable rows are listed and 2 rows had another status: nothing is missing.
  const explained = sanitizeRateLimits({ rateLimitResetCredits: { availableCount: 5, credits: [...rows(3), ...dropped(2)] } });
  assert.equal(explained.creditsNotAvailable, 2);
  const text = details({ ...explained, source: "live", fetchedAt: NOW });
  assert.match(text, /2 reset rows with another status not shown\./);
  assert.doesNotMatch(text, /not supplied by Codex/);
  // Count 6 with the same rows: one is still not supplied, named apart from the two.
  const partly = details({ ...sanitizeRateLimits({ rateLimitResetCredits: { availableCount: 6, credits: [...rows(3), ...dropped(2)] } }), source: "live", fetchedAt: NOW });
  assert.match(partly, /2 reset rows with another status not shown\./);
  assert.match(partly, /1 additional reset expiration was not supplied by Codex\./);
  // One such row reads in the singular.
  const single = details({ ...sanitizeRateLimits({ rateLimitResetCredits: { availableCount: 4, credits: [...rows(3), ...dropped(1)] } }), source: "live", fetchedAt: NOW });
  assert.match(single, /1 reset row with another status not shown\./);
});
