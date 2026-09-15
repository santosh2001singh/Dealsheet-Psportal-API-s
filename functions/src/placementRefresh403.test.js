const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveDomainTuning } = require("./config");

/**
 * Regression cover for the 2026-09-03 health update run that logged
 *   checked=1200 appended=1 no_change=178 not_found=1006 errors=15
 * while hundreds of `[placement refresh] submittal detail lookup failed ... status code 403` lines
 * scrolled past.
 *
 * Root cause was a burst: the update trigger reuses fetchAllMax as its per-placement concurrency, so
 * 20 placements refreshed in parallel and each fired its own submittal GET — ~60 requests inside
 * 0.4s, which the edge (Cloud Armor) answered with HTML 403 throttle pages. Two bugs turned that
 * throttle into silent data loss:
 *   1. fetchSubmittalByPlacementId called the NON-retrying nexusGetJson, so isTransientNexusError's
 *      edge-403 handling never ran.
 *   2. Its catch returned null, which made the caller resolve no job/deal-sheet and report
 *      action NOT_FOUND — so 403s were counted as not_found and the run exited green.
 *
 * Verified on 2026-09-04 that the same placement ids returned 200 JSON on a direct authenticated
 * call, confirming a throttle rather than a permissions problem.
 */

test("health has its own Nexus pacing, gentler than the 20-wide default", () => {
  const health = resolveDomainTuning("health");
  assert.ok(
    health.fetchAllMax < 20,
    `health fetchAllMax must be below the default 20 that caused the burst, got ${health.fetchAllMax}`
  );
  assert.ok(
    health.batchDelayMs > 100,
    `health batchDelayMs must exceed the default 100, got ${health.batchDelayMs}`
  );
  assert.ok(
    health.maxRetries >= 5,
    `health needs extra retries to ride out an edge throttle, got ${health.maxRetries}`
  );
});

test("health is paced less aggressively than canada", () => {
  // Canada enriches its whole history in one wave; health's volume is larger but bounded by its
  // start-date filter, so it should sit between canada and the old default rather than at canada's.
  const health = resolveDomainTuning("health");
  const canada = resolveDomainTuning("canada");
  assert.ok(
    health.fetchAllMax >= canada.fetchAllMax,
    "health should not be throttled harder than canada"
  );
});

test("locums still falls back to the defaults", () => {
  const locums = resolveDomainTuning("locums");
  assert.equal(locums.fetchAllMax, 20);
  assert.equal(locums.batchDelayMs, 100);
});

test("fetchSubmittalByPlacementId uses the retrying GET and rethrows non-404 failures", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(require.resolve("./syncService.js"), "utf8");
  const start = src.indexOf("async function fetchSubmittalByPlacementId");
  assert.ok(start > 0, "fetchSubmittalByPlacementId not found");
  const body = src.slice(start, src.indexOf("\n}", start));

  assert.ok(
    body.includes("nexusGetJsonWithRetry"),
    "must use the retrying GET so an edge-throttle 403 is retried"
  );
  assert.ok(
    !/\bawait nexusGetJson\(/.test(body),
    "must not call the bare non-retrying nexusGetJson"
  );
  // A 404 is a real missing submittal -> null (legitimate NOT_FOUND). Anything else must throw so
  // the caller reports ERROR instead of silently counting it as not_found.
  assert.ok(body.includes("isNotFoundNexusError"), "must special-case a genuine 404");
  assert.ok(/throw err/.test(body), "must rethrow non-404 failures rather than returning null");
});
