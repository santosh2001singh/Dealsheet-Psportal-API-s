const test = require("node:test");
const assert = require("node:assert/strict");

const { hasBusinessColumnChanges } = require("./bigQueryClient");

const IGNORE = new Set(["ID", "LAST_UPDATED", "IS_REJECTED"]);

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

// START_DATE/END_DATE are compared normally at the gate. For DID NOT ACCEPT / DID NOT START
// EXTENSION rows, refreshPlacementRecordToBigQuery applies applyOfferRejectedExtensionEndedDates
// ForInsertRows to the compare row BEFORE calling the gate, so by the time these two dates reach
// the gate they already hold the final (overridden) values — no special-casing needed here.
const doNotAcceptExtBaseline = {
  ASSIGNMENT_RECRUITER_EMAIL: "ammy.n@cynethealth.com",
  DEAL_TYPE: "EXTENSION",
  PLACEMENT_STATUS: "DID NOT ACCEPT",
  CONTRACT_ID: "CHC1779",
  START_DATE: "2026-04-01",
  END_DATE: "2026-05-09",
};

test("hasBusinessColumnChanges: matching (already-overridden) START/END on a DID NOT ACCEPT EXTENSION is unchanged", () => {
  // Compare row was pre-overridden by the refresh, so it equals the stored baseline -> no append.
  const incoming = { ...doNotAcceptExtBaseline, CONTRACT_ID: null };
  assert.equal(hasBusinessColumnChanges(incoming, doNotAcceptExtBaseline, IGNORE), false);
});

test("hasBusinessColumnChanges: a genuinely different START/END (stale baseline) IS a change so it self-corrects", () => {
  const incoming = { ...doNotAcceptExtBaseline, CONTRACT_ID: null, START_DATE: "2026-05-10", END_DATE: "2026-05-10" };
  assert.equal(hasBusinessColumnChanges(incoming, doNotAcceptExtBaseline, IGNORE), true);
});
