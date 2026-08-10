const test = require("node:test");
const assert = require("node:assert/strict");

const { applyOriginalStartDateForDealRows } = require("./bigQueryClient");

test("applyOriginalStartDateForDealRows: DEAL row gets INITIAL_START_DATE = START_DATE when empty", () => {
  const out = applyOriginalStartDateForDealRows([
    { DEAL_TYPE: "DEAL", START_DATE: "2026-05-04", INITIAL_START_DATE: null },
  ]);
  assert.equal(out[0].INITIAL_START_DATE, "2026-05-04");
});

test("applyOriginalStartDateForDealRows: never overwrites an existing INITIAL_START_DATE (frozen)", () => {
  const out = applyOriginalStartDateForDealRows([
    { DEAL_TYPE: "DEAL", START_DATE: "2026-05-04", INITIAL_START_DATE: "2024-01-01" },
  ]);
  assert.equal(out[0].INITIAL_START_DATE, "2024-01-01");
});

test("applyOriginalStartDateForDealRows: EXTENSION rows untouched (inherit from parent/runrate instead)", () => {
  const out = applyOriginalStartDateForDealRows([
    { DEAL_TYPE: "EXTENSION", START_DATE: "2026-08-04", INITIAL_START_DATE: null },
  ]);
  assert.equal(out[0].INITIAL_START_DATE, null);
});

test("applyOriginalStartDateForDealRows: no START_DATE -> stays null", () => {
  const out = applyOriginalStartDateForDealRows([
    { DEAL_TYPE: "DEAL", START_DATE: null, INITIAL_START_DATE: null },
  ]);
  assert.equal(out[0].INITIAL_START_DATE, null);
});

test("applyOriginalStartDateForDealRows: blank-string INITIAL_START_DATE is treated as empty and filled", () => {
  const out = applyOriginalStartDateForDealRows([
    { DEAL_TYPE: "deal", START_DATE: "2026-05-04", INITIAL_START_DATE: "" },
  ]);
  assert.equal(out[0].INITIAL_START_DATE, "2026-05-04");
});

const { applyDidNotAcceptDateOverrides } = require("./bigQueryClient");

test("applyDidNotAcceptDateOverrides: DID NOT ACCEPT -> END_DATE=START_DATE, TENTATIVE_END_DATE=null", () => {
  const out = applyDidNotAcceptDateOverrides([
    { PLACEMENT_STATUS: "DID NOT ACCEPT", START_DATE: "2026-06-08", END_DATE: "2026-06-08", TENTATIVE_END_DATE: "2026-09-05" },
  ]);
  assert.equal(out[0].END_DATE, "2026-06-08");
  assert.equal(out[0].TENTATIVE_END_DATE, null);
});

test("applyDidNotAcceptDateOverrides: END_DATE mirrors START_DATE even when Nexus sent a different END_DATE", () => {
  const out = applyDidNotAcceptDateOverrides([
    { PLACEMENT_STATUS: "did not accept", START_DATE: "2026-06-08", END_DATE: "2026-12-31", TENTATIVE_END_DATE: "2026-09-05" },
  ]);
  assert.equal(out[0].END_DATE, "2026-06-08");
  assert.equal(out[0].TENTATIVE_END_DATE, null);
});

test("applyDidNotAcceptDateOverrides: other statuses untouched", () => {
  const out = applyDidNotAcceptDateOverrides([
    { PLACEMENT_STATUS: "STARTED", START_DATE: "2026-06-08", END_DATE: null, TENTATIVE_END_DATE: "2026-09-05" },
  ]);
  assert.equal(out[0].END_DATE, null);
  assert.equal(out[0].TENTATIVE_END_DATE, "2026-09-05");
});
