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
