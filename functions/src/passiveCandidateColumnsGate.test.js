const test = require("node:test");
const assert = require("node:assert/strict");

const { hasBusinessColumnChanges } = require("./bigQueryClient");
const { computeChangedFields } = require("./syncService");

const IGNORE = ["ID", "LAST_UPDATED", "IS_REJECTED"];

// Deal sheet 5235889 / placement 1461690 got a new line each time the Nexus candidate record's
// status (ACTIVE -> BOOKED -> PREVIOUSLY EMPLOYED -> PENDING) or type (Local <-> Traveler A) flipped,
// with nothing else on the placement changing. Those two columns must not append on their own.
const baseline = {
  DEAL_SHEET_ID: "5235889",
  PLACEMENT_ID: "1461690",
  ASSIGNMENT_RECRUITER_EMAIL: "sid.k@cynethealth.com",
  DEAL_TYPE: "DEAL",
  PLACEMENT_STATUS: "ENDED",
  CONTRACT_ID: "CHC22468",
  START_DATE: "2026-07-06",
  END_DATE: "2026-09-05",
  BILL_RATE: "57.0",
  CANDIDATE_STATUS: "PREVIOUSLY EMPLOYED",
  PROVIDER_TYPE: "Local",
};

test("CANDIDATE_STATUS change alone does not append", () => {
  const incoming = { ...baseline, CANDIDATE_STATUS: "PENDING" };
  assert.equal(hasBusinessColumnChanges(incoming, baseline, new Set(IGNORE)), false);
  assert.deepEqual(computeChangedFields(incoming, baseline, IGNORE), []);
});

test("PROVIDER_TYPE change alone does not append", () => {
  const incoming = { ...baseline, PROVIDER_TYPE: "Traveler A" };
  assert.equal(hasBusinessColumnChanges(incoming, baseline, new Set(IGNORE)), false);
  assert.deepEqual(computeChangedFields(incoming, baseline, IGNORE), []);
});

test("CANDIDATE_STATUS + PROVIDER_TYPE together still do not append", () => {
  const incoming = { ...baseline, CANDIDATE_STATUS: "BOOKED", PROVIDER_TYPE: "Traveler A" };
  assert.equal(hasBusinessColumnChanges(incoming, baseline, new Set(IGNORE)), false);
});

test("a real change alongside CANDIDATE_STATUS appends", () => {
  const incoming = { ...baseline, PLACEMENT_STATUS: "STARTED", END_DATE: null, CANDIDATE_STATUS: "ACTIVE" };
  assert.equal(hasBusinessColumnChanges(incoming, baseline, new Set(IGNORE)), true);
  assert.deepEqual(computeChangedFields(incoming, baseline, IGNORE), ["END_DATE", "PLACEMENT_STATUS"]);
});
