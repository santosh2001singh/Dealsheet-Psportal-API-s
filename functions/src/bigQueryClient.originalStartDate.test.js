const test = require("node:test");
const assert = require("node:assert/strict");

const { applyOriginalStartDateForDealRows } = require("./bigQueryClient");

test("applyOriginalStartDateForDealRows: DEAL row gets INITIAL_START_DATE = START_DATE when empty", () => {
  const out = applyOriginalStartDateForDealRows([
    { DEAL_TYPE: "DEAL", START_DATE: "2026-05-04", INITIAL_START_DATE: null },
  ]);
  assert.equal(out[0].INITIAL_START_DATE, "2026-05-04");
});

test("applyOriginalStartDateForDealRows: never overwrites an existing INITIAL_START_DATE once started (frozen)", () => {
  const out = applyOriginalStartDateForDealRows([
    { DEAL_TYPE: "DEAL", PLACEMENT_STATUS: "STARTED", START_DATE: "2026-05-04", INITIAL_START_DATE: "2024-01-01" },
  ]);
  assert.equal(out[0].INITIAL_START_DATE, "2024-01-01");
});

for (const status of ["STARTED", "ACTIVE", "ENDED", "ENDED<30"]) {
  test(`applyOriginalStartDateForDealRows: ${status} freezes INITIAL_START_DATE against a START_DATE change`, () => {
    const out = applyOriginalStartDateForDealRows([
      { DEAL_TYPE: "DEAL", PLACEMENT_STATUS: status, START_DATE: "2026-09-28", INITIAL_START_DATE: "2026-09-14" },
    ]);
    assert.equal(out[0].INITIAL_START_DATE, "2026-09-14");
  });
}

// A pre-start booking pulled EARLIER leaves INITIAL_START_DATE ahead of the row's own start, which
// no real initial start can be — so it is re-synced. Live shape: PLACEMENT_ID 1466685, initial
// start 2026-10-12 against a start pulled back to 2026-09-28.
test("applyOriginalStartDateForDealRows: pre-start booking pulled earlier re-syncs INITIAL_START_DATE", () => {
  const out = applyOriginalStartDateForDealRows([
    { DEAL_TYPE: "DEAL", PLACEMENT_STATUS: "BOOKED", START_DATE: "2026-09-28", INITIAL_START_DATE: "2026-10-12" },
  ]);
  assert.equal(out[0].INITIAL_START_DATE, "2026-09-28");
});

for (const status of ["BOOKED", "OFFERED", "DID NOT START", "DID NOT ACCEPT"]) {
  test(`applyOriginalStartDateForDealRows: ${status} is pre-start, so a LATER INITIAL_START_DATE tracks START_DATE`, () => {
    const out = applyOriginalStartDateForDealRows([
      { DEAL_TYPE: "DEAL", PLACEMENT_STATUS: status, START_DATE: "2026-09-28", INITIAL_START_DATE: "2026-10-12" },
    ]);
    assert.equal(out[0].INITIAL_START_DATE, "2026-09-28");
  });
}

// applyLegacyContractIdentityToDealRows (contractIdResolver.js) writes the matched run-rate row's
// START_DATE here, and it runs BEFORE this function in the insert path. That value is EARLIER than
// the row's own start by design — the contract began before this placement segment of it.
test("applyOriginalStartDateForDealRows: pre-start keeps an EARLIER INITIAL_START_DATE (run-rate contract lineage)", () => {
  const row = {
    DEAL_TYPE: "DEAL",
    PLACEMENT_STATUS: "BOOKED",
    START_DATE: "2026-09-14",
    INITIAL_START_DATE: "2026-06-08",
  };
  const out = applyOriginalStartDateForDealRows([row]);
  assert.equal(out[0], row);
  assert.equal(out[0].INITIAL_START_DATE, "2026-06-08");
});

for (const status of ["BOOKED", "OFFERED", "DID NOT START", "DID NOT ACCEPT"]) {
  test(`applyOriginalStartDateForDealRows: ${status} never overwrites a run-rate contract start`, () => {
    const out = applyOriginalStartDateForDealRows([
      { DEAL_TYPE: "DEAL", PLACEMENT_STATUS: status, START_DATE: "2026-09-14", INITIAL_START_DATE: "2025-02-17" },
    ]);
    assert.equal(out[0].INITIAL_START_DATE, "2025-02-17");
  });
}

// A pre-start pushback moves START_DATE forward, so the stale value is LEFT BEHIND (earlier) and
// must be kept — it is indistinguishable from lineage at this point. The re-sync only fires on the
// impossible direction: an initial start AFTER the row's own start.
test("applyOriginalStartDateForDealRows: a pushback that leaves INITIAL_START_DATE earlier is kept, not re-synced", () => {
  const out = applyOriginalStartDateForDealRows([
    { DEAL_TYPE: "DEAL", PLACEMENT_STATUS: "BOOKED", START_DATE: "2026-09-28", INITIAL_START_DATE: "2026-09-14" },
  ]);
  assert.equal(out[0].INITIAL_START_DATE, "2026-09-14");
});

test("applyOriginalStartDateForDealRows: pre-start with matching dates is left as-is (no needless rewrite)", () => {
  const row = { DEAL_TYPE: "DEAL", PLACEMENT_STATUS: "BOOKED", START_DATE: "2026-09-14", INITIAL_START_DATE: "2026-09-14" };
  const out = applyOriginalStartDateForDealRows([row]);
  assert.equal(out[0], row);
});

test("applyOriginalStartDateForDealRows: a timestamp-shaped INITIAL_START_DATE matching START_DATE is not rewritten", () => {
  const row = {
    DEAL_TYPE: "DEAL",
    PLACEMENT_STATUS: "BOOKED",
    START_DATE: "2026-09-14",
    INITIAL_START_DATE: "2026-09-14 00:00:00.000000 UTC",
  };
  const out = applyOriginalStartDateForDealRows([row]);
  assert.equal(out[0], row);
});

test("applyOriginalStartDateForDealRows: unknown status counts as pre-start", () => {
  const out = applyOriginalStartDateForDealRows([
    { DEAL_TYPE: "DEAL", PLACEMENT_STATUS: null, START_DATE: "2026-09-28", INITIAL_START_DATE: "2026-10-12" },
  ]);
  assert.equal(out[0].INITIAL_START_DATE, "2026-09-28");
});

test("applyOriginalStartDateForDealRows: status casing/padding is ignored when freezing", () => {
  const out = applyOriginalStartDateForDealRows([
    { DEAL_TYPE: "DEAL", PLACEMENT_STATUS: "  started ", START_DATE: "2026-09-28", INITIAL_START_DATE: "2026-09-14" },
  ]);
  assert.equal(out[0].INITIAL_START_DATE, "2026-09-14");
});

// The 33-row legacy repair anchors on deal.START_DATE == extension.INITIAL_START_DATE, and every
// one of those DEALs had already started. The freeze above is what keeps that anchor intact.
test("applyOriginalStartDateForDealRows: started EXTENSION-parent lineage anchor survives a late START_DATE correction", () => {
  const out = applyOriginalStartDateForDealRows([
    { DEAL_TYPE: "DEAL", PLACEMENT_STATUS: "ENDED", START_DATE: "2026-06-15", INITIAL_START_DATE: "2026-06-08" },
  ]);
  assert.equal(out[0].INITIAL_START_DATE, "2026-06-08");
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
