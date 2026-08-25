const test = require("node:test");
const assert = require("node:assert/strict");

const config = require("./config");
const { resolveDomainTuning, applyDomainTuning } = config;

const DEFAULTS = { fetchAllMax: 20, batchDelayMs: 100, maxRetries: 3 };
const CANADA = { fetchAllMax: 5, batchDelayMs: 500, maxRetries: 5 };

/**
 * Canada syncs its whole Nexus history (no start-date filter), so one run fires thousands of
 * requests and trips the edge rate limit. Its pacing lives in code — NOT in per-function env vars —
 * because `gcloud --update-env-vars` truncated NEXUS_PASSWORD at its trailing "#", breaking auth
 * with a 401. With the tuning in code every function deploys with plain `firebase deploy`.
 */

test("canada gets the gentler fan-out", () => {
  assert.deepEqual(resolveDomainTuning("canada"), CANADA);
});

test("health and locums keep the fast defaults", () => {
  assert.deepEqual(resolveDomainTuning("health"), DEFAULTS);
  assert.deepEqual(resolveDomainTuning("locums"), DEFAULTS);
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
  assert.deepEqual(resolveDomainTuning("health"), DEFAULTS);

  applyDomainTuning("health");
  assert.equal(config.fetchAllMax, DEFAULTS.fetchAllMax);
  assert.equal(config.batchDelayMs, DEFAULTS.batchDelayMs);
  assert.equal(config.maxRetries, DEFAULTS.maxRetries);

  applyDomainTuning("canada");
  assert.equal(config.fetchAllMax, CANADA.fetchAllMax);
  assert.equal(config.batchDelayMs, CANADA.batchDelayMs);
  assert.equal(config.maxRetries, CANADA.maxRetries);

  // Leave the process on the defaults for any later test in the same file.
  applyDomainTuning("health");
});

test("applyDomainTuning returns what it applied", () => {
  assert.deepEqual(applyDomainTuning("canada"), CANADA);
  assert.deepEqual(applyDomainTuning("health"), DEFAULTS);
});

test("repeated application is stable", () => {
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(applyDomainTuning("canada"), CANADA);
    assert.deepEqual(applyDomainTuning("health"), DEFAULTS);
  }
});

test("only canada is tuned; credentials are never domain-scoped", () => {
  assert.deepEqual(Object.keys(config.domainTuning), ["canada"]);
  // Nexus credentials are shared across all three domains — the tuning must not touch them.
  for (const k of ["username", "password", "baseUrl", "csrfToken"]) {
    assert.ok(k in config.nexus, k);
  }
  const before = { ...config.nexus };
  applyDomainTuning("canada");
  assert.deepEqual(config.nexus, before, "domain tuning must not alter credentials");
  applyDomainTuning("health");
});
