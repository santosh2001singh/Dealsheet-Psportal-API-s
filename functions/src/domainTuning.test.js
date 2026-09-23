const test = require("node:test");
const assert = require("node:assert/strict");

const config = require("./config");
const { resolveDomainTuning, applyDomainTuning } = config;

const DEFAULTS = { fetchAllMax: 20, batchDelayMs: 100, maxRetries: 3, placementConcurrency: 3 };
const CANADA = { fetchAllMax: 5, batchDelayMs: 500, maxRetries: 5, placementConcurrency: 2 };
const HEALTH = { fetchAllMax: 10, batchDelayMs: 250, maxRetries: 5, placementConcurrency: 3 };

/**
 * Canada and Locums sync their whole Nexus history (no start-date filter), so one run fires
 * thousands of requests and trips the edge rate limit. Health reaches the same limit by a different
 * route: its UPDATE trigger reuses fetchAllMax as per-placement concurrency, so the 20-wide default
 * refreshed 20 placements at once and burst their submittal GETs (2026-09-03). All three are paced
 * here; only an unknown domain keeps the defaults.
 *
 * The pacing lives in code — NOT in per-function env vars — because `gcloud --update-env-vars`
 * truncated NEXUS_PASSWORD at its trailing "#", breaking auth with a 401. With the tuning in code
 * every function deploys with plain `firebase deploy`.
 */

test("canada gets the gentler fan-out", () => {
  assert.deepEqual(resolveDomainTuning("canada"), CANADA);
});

test("health is paced too, between canada and the defaults", () => {
  // Added 2026-09-04. Health's enrich waves are small, but the UPDATE trigger USED TO reuse
  // fetchAllMax as its per-placement concurrency, so the old 20-wide default burst ~60 submittal
  // GETs into 0.4s and the edge answered HTML 403s — a run checked 1200 placements and appended 1.
  // Lowering fetchAllMax to 10 halved that burst but did not clear it (2026-09-11); the update
  // trigger now has its own placementConcurrency knob, asserted below.
  assert.deepEqual(resolveDomainTuning("health"), HEALTH);
});

/**
 * The update trigger's concurrency must stay decoupled from fetchAllMax.
 *
 * fetchAllMax counts URLs inside one enrich wave; the update loop's unit is a whole placement, which
 * costs ~13 Nexus requests (1 job-submittals + 1 deal-sheet-candidates in resolveRefreshSeed, then an
 * 11-URL wave). Driving the loop at fetchAllMax therefore multiplied the real burst by ~13 and the
 * edge answered HTML 403s across six distinct job_ids inside one second on 2026-09-11.
 */
test("update placement concurrency is its own knob, well below fetchAllMax", () => {
  for (const domain of ["health", "canada", "locums", undefined]) {
    const t = resolveDomainTuning(domain);
    assert.ok(
      t.placementConcurrency <= 3,
      `${domain}: placementConcurrency ${t.placementConcurrency} would burst ~${t.placementConcurrency * 13} requests`
    );
    assert.ok(
      t.placementConcurrency < t.fetchAllMax,
      `${domain}: placementConcurrency must not track fetchAllMax`
    );
  }
});

test("locums is paced like canada — it lost its start-date filter in Sep 2026", () => {
  // Its first unfiltered run answered HTML 403s on every wave1 sub-request and logged
  // "wave1 fallback: skipped=82 successful=344". Same shape as canada, so the same numbers.
  assert.deepEqual(resolveDomainTuning("locums"), CANADA);
});

test("an unknown or absent domain gets the defaults", () => {
  assert.deepEqual(resolveDomainTuning(undefined), DEFAULTS);
  assert.deepEqual(resolveDomainTuning(null), DEFAULTS);
  assert.deepEqual(resolveDomainTuning(""), DEFAULTS);
  assert.deepEqual(resolveDomainTuning("something_else"), DEFAULTS);
});

test("the domain match is case- and whitespace-insensitive", () => {
  for (const v of ["CANADA", "Canada", "  canada  "]) {
    assert.deepEqual(resolveDomainTuning(v), CANADA, v);
  }
});

test("applying one domain never leaks into the next", () => {
  // applyDomainTuning mutates the shared config, so the resolver must fall back to an immutable
  // baseline — otherwise canada's 5/500/5 would become health's defaults for the rest of the process.
  applyDomainTuning("canada");
  assert.deepEqual(resolveDomainTuning("health"), HEALTH);
  assert.deepEqual(resolveDomainTuning(undefined), DEFAULTS);

  applyDomainTuning("health");
  assert.equal(config.fetchAllMax, HEALTH.fetchAllMax);
  assert.equal(config.batchDelayMs, HEALTH.batchDelayMs);
  assert.equal(config.maxRetries, HEALTH.maxRetries);
  assert.equal(config.updatePlacementConcurrency, HEALTH.placementConcurrency);

  applyDomainTuning("canada");
  assert.equal(config.fetchAllMax, CANADA.fetchAllMax);
  assert.equal(config.batchDelayMs, CANADA.batchDelayMs);
  assert.equal(config.maxRetries, CANADA.maxRetries);
  assert.equal(config.updatePlacementConcurrency, CANADA.placementConcurrency);

  // Leave the process on the true defaults for any later test in the same file.
  applyDomainTuning(undefined);
});

test("applyDomainTuning returns what it applied", () => {
  assert.deepEqual(applyDomainTuning("canada"), CANADA);
  assert.deepEqual(applyDomainTuning("health"), HEALTH);
  assert.deepEqual(applyDomainTuning("locums"), CANADA);
  assert.deepEqual(applyDomainTuning(undefined), DEFAULTS);
});

test("repeated application is stable", () => {
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(applyDomainTuning("canada"), CANADA);
    assert.deepEqual(applyDomainTuning("health"), HEALTH);
    assert.deepEqual(applyDomainTuning("locums"), CANADA);
  }
});

test("all three domains are tuned; credentials are never domain-scoped", () => {
  assert.deepEqual(Object.keys(config.domainTuning).sort(), ["canada", "health", "locums"]);
  // Nexus credentials are shared across all three domains — the tuning must not touch them.
  for (const k of ["username", "password", "baseUrl", "csrfToken"]) {
    assert.ok(k in config.nexus, k);
  }
  const before = { ...config.nexus };
  applyDomainTuning("canada");
  assert.deepEqual(config.nexus, before, "domain tuning must not alter credentials");
  applyDomainTuning("health");
  assert.deepEqual(config.nexus, before, "domain tuning must not alter credentials");
  applyDomainTuning("locums");
  assert.deepEqual(config.nexus, before, "domain tuning must not alter credentials");
  applyDomainTuning(undefined);
});
