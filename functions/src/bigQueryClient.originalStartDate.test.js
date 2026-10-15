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
  test(`applyOriginalStartDateForDealRows: ${status} keeps an EARLIER INITIAL_START_DATE (contract lineage)`, () => {
    const out = applyOriginalStartDateForDealRows([
      { DEAL_TYPE: "DEAL", PLACEMENT_STATUS: status, START_DATE: "2026-09-28", INITIAL_START_DATE: "2026-09-14" },
    ]);
    assert.equal(out[0].INITIAL_START_DATE, "2026-09-14");
  });
}

// A contract cannot begin after the assignment it belongs to, so the status is irrelevant: the
// value is corrected whether or not the candidate has started.
//
// Live case (CANDIDATE_ID 31826743 "Lalla Drame", PLACEMENT_ID 1467110, Sep 2026): a fresh DEAL —
// no run-rate history, no extension — booked 2026-09-21, then pulled back to 2026-09-14. It tracked
// correctly while BOOKED, then froze at 09-21 the moment it turned STARTED and stayed a week ahead
// of its own start.
for (const status of ["STARTED", "ACTIVE", "ENDED", "ENDED<30"]) {
  test(`applyOriginalStartDateForDealRows: ${status} still re-syncs an INITIAL_START_DATE later than its own start`, () => {
    const out = applyOriginalStartDateForDealRows([
      { DEAL_TYPE: "DEAL", PLACEMENT_STATUS: status, START_DATE: "2026-09-14", INITIAL_START_DATE: "2026-09-21" },
    ]);
    assert.equal(out[0].INITIAL_START_DATE, "2026-09-14");
  });
}

// The Lalla Drame sequence end to end: the value must be right at every step, not only before the
// candidate starts.
test("applyOriginalStartDateForDealRows: a fresh DEAL tracks START_DATE across the whole booking lifecycle", () => {
  const steps = [
    { PLACEMENT_STATUS: "BOOKED", START_DATE: "2026-09-21", INITIAL_START_DATE: "2026-09-21" },
    { PLACEMENT_STATUS: "BOOKED", START_DATE: "2026-09-14", INITIAL_START_DATE: "2026-09-21" },
    { PLACEMENT_STATUS: "STARTED", START_DATE: "2026-09-14", INITIAL_START_DATE: "2026-09-21" },
  ];
  for (const step of steps) {
    const out = applyOriginalStartDateForDealRows([{ DEAL_TYPE: "DEAL", ...step }]);
    assert.equal(
      out[0].INITIAL_START_DATE,
      step.START_DATE,
      `${step.PLACEMENT_STATUS} row must report its own start as the contract start`
    );
  }
});

// OFFER_TIME_START_DATE is the column that holds the start as offered — frozen outright by
// applyOfferTimeStartDateFreeze, and START_DATE changes never release it. This function must not
// touch it while correcting INITIAL_START_DATE: the two answer different questions.
test("applyOriginalStartDateForDealRows: OFFER_TIME_START_DATE is left alone", () => {
  const out = applyOriginalStartDateForDealRows([
    {
      DEAL_TYPE: "DEAL",
      PLACEMENT_STATUS: "STARTED",
      START_DATE: "2026-09-14",
      INITIAL_START_DATE: "2026-09-21",
      OFFER_TIME_START_DATE: "2026-09-21",
    },
  ]);
  assert.equal(out[0].INITIAL_START_DATE, "2026-09-14", "contract start follows START_DATE");
  assert.equal(out[0].OFFER_TIME_START_DATE, "2026-09-21", "offer-time start stays frozen");
});

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
