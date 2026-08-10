const test = require("node:test");
const assert = require("node:assert/strict");

const {
  rowNeedsOfferRejectedExtensionEndedDates,
  applyOfferRejectedExtensionEndedDatesForInsertRows,
} = require("./bigQueryClient");

test("rowNeedsOfferRejectedExtensionEndedDates: EXTENSION + DID NOT ACCEPT/START with candidate+parent qualifies", () => {
  const base = {
    DEAL_TYPE: "EXTENSION",
    PLACEMENT_STATUS: "DID NOT ACCEPT",
    CANDIDATE_ID: 25212370,
    PLACEMENT_ID: 1462609,
    PARENT_CLIENT_NAME: "NYC Health + Hospitals",
  };
  assert.equal(rowNeedsOfferRejectedExtensionEndedDates(base), true);
  assert.equal(rowNeedsOfferRejectedExtensionEndedDates({ ...base, PLACEMENT_STATUS: "DID NOT START" }), true);
  assert.equal(rowNeedsOfferRejectedExtensionEndedDates({ ...base, DEAL_TYPE: "DEAL" }), false);
  assert.equal(rowNeedsOfferRejectedExtensionEndedDates({ ...base, PLACEMENT_STATUS: "STARTED" }), false);
  assert.equal(rowNeedsOfferRejectedExtensionEndedDates({ ...base, PARENT_CLIENT_NAME: "" }), false);
  assert.equal(rowNeedsOfferRejectedExtensionEndedDates({ ...base, CANDIDATE_ID: null }), false);
});

test("applyOfferRejectedExtensionEndedDatesForInsertRows: overrides START_DATE/END_DATE from matched ENDED placement", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      PLACEMENT_STATUS: "DID NOT ACCEPT",
      CANDIDATE_ID: 25212370,
      PLACEMENT_ID: 1462609,
      PARENT_CLIENT_NAME: "NYC Health + Hospitals",
      START_DATE: "2026-07-05",
      END_DATE: "2026-07-05",
    },
    // ineligible (STARTED) -> untouched
    { DEAL_TYPE: "EXTENSION", PLACEMENT_STATUS: "STARTED", CANDIDATE_ID: 1, PLACEMENT_ID: 2, PARENT_CLIENT_NAME: "X", START_DATE: "2026-01-01" },
  ];
  const fetchFn = async (eligible) => {
    assert.equal(eligible.length, 1);
    assert.equal(eligible[0].PLACEMENT_ID, 1462609);
    return new Map([["1462609", { START_DATE: "2025-08-18", END_DATE: "2026-01-15" }]]);
  };
  const out = await applyOfferRejectedExtensionEndedDatesForInsertRows(rows, {}, { fetchFn });
  assert.equal(out[0].START_DATE, "2025-08-18"); // from prior ENDED placement
  assert.equal(out[0].END_DATE, "2026-01-15");
  assert.equal(out[1].START_DATE, "2026-01-01"); // ineligible untouched
});

test("applyOfferRejectedExtensionEndedDatesForInsertRows: no match -> row unchanged", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      PLACEMENT_STATUS: "DID NOT START",
      CANDIDATE_ID: 999,
      PLACEMENT_ID: 3,
      PARENT_CLIENT_NAME: "Y",
      START_DATE: "2026-07-05",
      END_DATE: "2026-07-05",
    },
  ];
  const fetchFn = async () => new Map(); // nothing matched
  const out = await applyOfferRejectedExtensionEndedDatesForInsertRows(rows, {}, { fetchFn });
  assert.equal(out[0].START_DATE, "2026-07-05");
  assert.equal(out[0].END_DATE, "2026-07-05");
});

test("applyOfferRejectedExtensionEndedDatesForInsertRows: no eligible rows -> fetch never called", async () => {
  let called = false;
  const fetchFn = async () => { called = true; return new Map(); };
  const rows = [{ DEAL_TYPE: "DEAL", PLACEMENT_STATUS: "STARTED", CANDIDATE_ID: 1, PLACEMENT_ID: 1, PARENT_CLIENT_NAME: "X" }];
  const out = await applyOfferRejectedExtensionEndedDatesForInsertRows(rows, {}, { fetchFn });
  assert.equal(called, false);
  assert.equal(out[0].PLACEMENT_STATUS, "STARTED");
});
