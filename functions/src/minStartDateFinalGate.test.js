const test = require("node:test");
const assert = require("node:assert/strict");

const {
  startDateOnOrAfterUtcMin,
  effectiveMinFilterDate,
} = require("./columnMappings");

const MIN_MS = Date.UTC(2026, 0, 1);

// The caller-side filter (index.js filterEnrichedRowsByDealSheetMinStartDate) and the final gate
// inside insertEnrichedDealSheetBatch share these two helpers, so the cutoff can never disagree
// between them. What differs is WHEN they run: the caller sees the enriched row, the final gate sees
// the row after the pipeline's date rewrites.
const passesGate = (row) => startDateOnOrAfterUtcMin(effectiveMinFilterDate(row), MIN_MS);

test("row on the cutoff day is kept (>= is inclusive)", () => {
  assert.equal(passesGate({ START_DATE: "2026-01-01" }), true);
});

test("row before the cutoff is dropped", () => {
  assert.equal(passesGate({ START_DATE: "2025-12-31" }), false);
  assert.equal(passesGate({ START_DATE: "2022-10-27" }), false);
  assert.equal(passesGate({ START_DATE: "2025-03-04" }), false);
});

test("no upper bound — future starts are kept", () => {
  assert.equal(passesGate({ START_DATE: "2027-05-20" }), true);
});

test("blank START_DATE falls back to OFFER_TIME_START_DATE", () => {
  assert.equal(passesGate({ START_DATE: null, OFFER_TIME_START_DATE: "2026-03-01" }), true);
  assert.equal(passesGate({ START_DATE: "  ", OFFER_TIME_START_DATE: "2025-03-01" }), false);
});

test("no usable date at all -> dropped (never inserted on a guess)", () => {
  assert.equal(passesGate({ START_DATE: null, OFFER_TIME_START_DATE: null }), false);
});

// The actual leak: an offer-rejected EXTENSION passes the caller's filter on its own 2026 start date,
// then applyOfferRejectedExtensionEndedDatesForInsertRows rewrites START_DATE/END_DATE from the
// candidate's most-recent PRIOR ended assignment — which can be years old. Only a gate that runs
// AFTER that rewrite catches it.
test("pipeline rewrite to a prior ended assignment is caught by the post-rewrite gate", () => {
  const enriched = {
    DEAL_TYPE: "EXTENSION",
    PLACEMENT_STATUS: "DID NOT ACCEPT",
    START_DATE: "2026-06-15",
    END_DATE: "2026-06-15",
  };
  // Caller-side filter: passes, the row looks like a 2026 placement.
  assert.equal(passesGate(enriched), true);

  // Pipeline rewrites the dates from the candidate's 2022 ended assignment.
  const afterPipeline = { ...enriched, START_DATE: "2022-10-27", END_DATE: "2023-01-21" };

  // Final gate must reject it — this is the row that showed up in the table as START_DATE 2022-10-27.
  assert.equal(passesGate(afterPipeline), false);
});
