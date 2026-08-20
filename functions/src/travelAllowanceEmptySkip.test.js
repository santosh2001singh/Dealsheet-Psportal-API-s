const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isEmptyTravelAllowanceItem,
  mapTravelAllowanceLogRowsForDealSheet,
  mapTravelAllowanceToAdditionalBonus,
} = require("./columnMappings");

// Nexus returns a travel-allowance record for a deal sheet whether or not one was agreed. The empty
// case is type NONE with every amount zeroed, e.g. (deal sheet 5245333, Aug 2026):
//   { id: 4384048, travel_mileage: 0.0, mileage_amount: 0.0, travel_amount: 0.0, total_amount: 0.0,
//     first_check_amount: 0.0, last_check_amount: 0.0, deal_sheet_travel_allowance_type: "NONE" }
// Because the row carries an id, the pre-existing `id == null && value === 0` guard did not catch it,
// so practically every deal sheet logged one meaningless VALUE=0 row into ch_additional_cost_logs.

const CTX = {
  DEAL_SHEET_ID: 5245333,
  PLACEMENT_ID: 1460001,
  CANDIDATE_NAME: "Test Candidate",
  CANDIDATE_EMAIL: "t@example.com",
  ASSIGNMENT_RECRUITER_EMAIL: "r@cynethealth.com",
  START_DATE: "2026-07-01",
  TENTATIVE_END_DATE: "2026-09-30",
};

/** The live payload that motivated the skip. */
const EMPTY_PLACEHOLDER = {
  id: 4384048,
  travel_mileage: 0.0,
  mileage_amount: 0.0,
  travel_amount: 0.0,
  total_amount: 0.0,
  mileage_factor: 0.0,
  first_check_amount: 0.0,
  last_check_amount: 0.0,
  weekly_payout_amount: 0.0,
  deal_sheet: 5245333,
  deal_sheet_travel_allowance_type: "NONE",
};

test("the NONE + zero-total placeholder is recognised as empty", () => {
  assert.equal(isEmptyTravelAllowanceItem(EMPTY_PLACEHOLDER), true);
  // Case and whitespace must not defeat it.
  assert.equal(
    isEmptyTravelAllowanceItem({ ...EMPTY_PLACEHOLDER, deal_sheet_travel_allowance_type: " none " }),
    true
  );
  // A missing total is the same as zero.
  assert.equal(
    isEmptyTravelAllowanceItem({ deal_sheet_travel_allowance_type: "NONE", total_amount: null }),
    true
  );
});

test("BOTH conditions are required — either alone must NOT skip", () => {
  // A typed allowance totalling 0 still records that something was agreed.
  assert.equal(
    isEmptyTravelAllowanceItem({ ...EMPTY_PLACEHOLDER, deal_sheet_travel_allowance_type: "MILEAGE" }),
    false
  );
  // A NONE-typed row with real money still has to be accounted for.
  assert.equal(isEmptyTravelAllowanceItem({ ...EMPTY_PLACEHOLDER, total_amount: 500 }), false);
  // Neither condition holds.
  assert.equal(
    isEmptyTravelAllowanceItem({ deal_sheet_travel_allowance_type: "FLIGHT", total_amount: 1200 }),
    false
  );
});

test("the placeholder produces no log row", () => {
  assert.deepEqual(mapTravelAllowanceLogRowsForDealSheet([EMPTY_PLACEHOLDER], CTX, "2026-08-19T00:00:00Z"), []);
});

test("a typed allowance totalling zero is still logged", () => {
  const rows = mapTravelAllowanceLogRowsForDealSheet(
    [{ ...EMPTY_PLACEHOLDER, deal_sheet_travel_allowance_type: "MILEAGE" }],
    CTX,
    "2026-08-19T00:00:00Z"
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].VALUE, 0);
  assert.equal(rows[0].ADDITIONAL_COST_NAME, "Travel Allowances");
  assert.equal(rows[0].CATEGORY, "BONUS");
});

test("a NONE-typed allowance carrying money is still logged", () => {
  const rows = mapTravelAllowanceLogRowsForDealSheet(
    [{ ...EMPTY_PLACEHOLDER, total_amount: 500 }],
    CTX,
    "2026-08-19T00:00:00Z"
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].VALUE, 500);
});

test("a real allowance is unaffected and keeps its identity and notes", () => {
  const rows = mapTravelAllowanceLogRowsForDealSheet(
    [
      {
        id: 999111,
        total_amount: 1200,
        first_check_amount: 700,
        last_check_amount: 500,
        deal_sheet_travel_allowance_type: "FLIGHT",
      },
    ],
    CTX,
    "2026-08-19T00:00:00Z"
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ADDITIONAL_COST_ID, 999111);
  assert.equal(rows[0].VALUE, 1200);
  assert.equal(rows[0].DEAL_SHEET_ID, 5245333);
  assert.equal(rows[0].PLACEMENT_ID, 1460001);
  assert.match(rows[0].NOTES, /First check amount: 700/);
  assert.match(rows[0].NOTES, /Last check amount: 500/);
});

test("mixed rows: only the placeholder is dropped", () => {
  const rows = mapTravelAllowanceLogRowsForDealSheet(
    [
      EMPTY_PLACEHOLDER,
      { id: 2, total_amount: 300, deal_sheet_travel_allowance_type: "MILEAGE" },
      { id: 3, total_amount: 0, deal_sheet_travel_allowance_type: "NONE" },
      { id: 4, total_amount: 0, deal_sheet_travel_allowance_type: "FLIGHT" },
    ],
    CTX,
    "2026-08-19T00:00:00Z"
  );
  assert.deepEqual(
    rows.map((r) => r.ADDITIONAL_COST_ID),
    [2, 4],
    "both NONE+0 rows dropped; MILEAGE 300 and FLIGHT 0 kept"
  );
});

test("ADDITIONAL_BONUS still sums every row, including skipped placeholders", () => {
  // The money total is a separate concern from the audit log: a zero adds nothing anyway, so the
  // skip must not change any reported amount.
  assert.deepEqual(mapTravelAllowanceToAdditionalBonus([EMPTY_PLACEHOLDER]), {
    ADDITIONAL_BONUS: 0,
  });
  assert.deepEqual(
    mapTravelAllowanceToAdditionalBonus([
      EMPTY_PLACEHOLDER,
      { id: 2, total_amount: 1200, deal_sheet_travel_allowance_type: "FLIGHT" },
    ]),
    { ADDITIONAL_BONUS: 1200 }
  );
});

test("an empty or absent API response still produces nothing", () => {
  assert.deepEqual(mapTravelAllowanceLogRowsForDealSheet([], CTX, "t"), []);
  assert.deepEqual(mapTravelAllowanceLogRowsForDealSheet(null, CTX, "t"), []);
});
