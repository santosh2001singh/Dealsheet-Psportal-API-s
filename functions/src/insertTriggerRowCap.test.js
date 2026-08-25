const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Test switch: canada syncs its whole Nexus history with no start-date filter, so a full run takes a
 * long time and a mistake only shows up at the end. A row cap lets a run be checked in minutes.
 *
 * It is read PER DOMAIN from an env var, so setting it on the canada function alone leaves health
 * and locums running uncapped — env vars are per Cloud Run service, and the domain-suffixed name
 * means even a shared var would have to be set deliberately.
 */

const SRC = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");

/** Reconstruct the resolver so it can be exercised with a controlled env. */
function makeResolver() {
  const m = /function resolveInsertTriggerMaxRows\(domain\)[\s\S]*?\n}/.exec(SRC);
  assert.ok(m, "resolveInsertTriggerMaxRows must exist");
  const body = m[0].replace(
    "function resolveInsertTriggerMaxRows(domain)",
    "return (function(domain)"
  );
  // eslint-disable-next-line no-new-func
  return new Function("domain", "process", `${body})(domain);`);
}

const resolve = makeResolver();
const run = (domain, env) => resolve(domain, { env });

test("no env var means no cap — the production default", () => {
  for (const d of ["canada", "health", "locums", undefined]) {
    assert.equal(run(d, {}), 0, String(d));
  }
});

test("the canada var caps ONLY canada", () => {
  const env = { DEAL_SHEET_INSERT_TRIGGER_MAX_ROWS_CANADA: "100" };
  assert.equal(run("canada", env), 100);
  assert.equal(run("health", env), 0, "health must stay uncapped");
  assert.equal(run("locums", env), 0, "locums must stay uncapped");
});

test("a health var would cap only health", () => {
  // Proves the per-domain lookup is symmetric — nothing is hard-wired to canada.
  const env = { DEAL_SHEET_INSERT_TRIGGER_MAX_ROWS_HEALTH: "50" };
  assert.equal(run("health", env), 50);
  assert.equal(run("canada", env), 0);
});

test("the domain-specific var wins over the shared one", () => {
  const env = {
    DEAL_SHEET_INSERT_TRIGGER_MAX_ROWS: "999",
    DEAL_SHEET_INSERT_TRIGGER_MAX_ROWS_CANADA: "100",
  };
  assert.equal(run("canada", env), 100);
  assert.equal(run("health", env), 999, "the shared var still applies where no specific one is set");
});

test("junk and non-positive values mean no cap", () => {
  for (const v of ["0", "-5", "abc", "", "  "]) {
    assert.equal(run("canada", { DEAL_SHEET_INSERT_TRIGGER_MAX_ROWS_CANADA: v }), 0, JSON.stringify(v));
  }
});

test("the cap is passed to the pipeline as max_candidates", () => {
  assert.ok(
    SRC.includes("...(insertMaxRows > 0 ? { max_candidates: insertMaxRows } : {}),"),
    "the cap must reach the enrich stream, which already honours max_candidates"
  );
});

test("the cap is resolved from the run's own domain", () => {
  assert.ok(SRC.includes("const insertMaxRows = resolveInsertTriggerMaxRows(domain);"));
});

test("the UPDATE trigger is not capped", () => {
  // Only the insert trigger takes the cap; the update pass has its own max_pairs_per_run control.
  const updateBody = SRC.slice(SRC.indexOf("async function runDealSheetUpdateSyncForDomain"));
  assert.ok(!updateBody.includes("resolveInsertTriggerMaxRows"));
});
