const test = require("node:test");
const assert = require("node:assert/strict");

const { hasBusinessColumnChanges } = require("./bigQueryClient");

const IGNORE = new Set(["ID", "DATE_AND_TIME", "IS_REJECTED"]);

// Regression: CONTRACT_ID is a Cynet-internal identity resolved INSIDE the insert pipeline, so a
// freshly-enriched incoming row has it null at compare time. Comparing null-incoming vs a populated
// baseline used to report a false "change", making every update-refresh re-append a 0-diff row
// forever (and flip IS_REJECTED null->False as a side effect).
const baseline = {
  ASSIGNMENT_RECRUITER_EMAIL: "mamta.b@cynethealth.com",
  DEAL_TYPE: "EXTENSION",
  PLACEMENT_STATUS: "DID NOT ACCEPT",
  CONTRACT_ID: "CHC1113",
  BILL_RATE: "90.0",
  START_DATE: "2024-08-06",
};

test("hasBusinessColumnChanges: incoming CONTRACT_ID=null vs populated baseline is NOT a change (no spurious re-append)", () => {
  const incoming = { ...baseline, CONTRACT_ID: null };
  assert.equal(hasBusinessColumnChanges(incoming, baseline, IGNORE), false);
});

test("hasBusinessColumnChanges: a real API-owned change is still detected even when CONTRACT_ID is unresolved", () => {
  const incoming = { ...baseline, CONTRACT_ID: null, BILL_RATE: "999.0" };
  assert.equal(hasBusinessColumnChanges(incoming, baseline, IGNORE), true);
});

test("hasBusinessColumnChanges: a genuine CONTRACT_ID reassignment (both non-null, different) is still detected", () => {
  const incoming = { ...baseline, CONTRACT_ID: "CHC9999" };
  assert.equal(hasBusinessColumnChanges(incoming, baseline, IGNORE), true);
});

test("hasBusinessColumnChanges: identical rows are unchanged", () => {
  assert.equal(hasBusinessColumnChanges({ ...baseline }, baseline, IGNORE), false);
});
