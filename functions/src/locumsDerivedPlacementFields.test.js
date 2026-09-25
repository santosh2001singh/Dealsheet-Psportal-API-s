const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isCynetLocumsRecruiter,
  mapLocumsTypeFromTenNintyNine,
  computeLocumsDerivedPlacementFields,
  sanitizeLocumsDealSheetRow,
  LOCUMS_EXCLUDED_API_OWNED_COLUMNS,
} = require("./locumsDerivedPlacementFields");

const locumsEmail = "recruiter@cynetlocums.com";

function baseRow(overrides = {}) {
  return {
    ASSIGNMENT_RECRUITER_EMAIL: locumsEmail,
    ...overrides,
  };
}

test("isCynetLocumsRecruiter matches @cynetlocums.com", () => {
  assert.equal(isCynetLocumsRecruiter("a@cynetlocums.com"), true);
  assert.equal(isCynetLocumsRecruiter("A@CynetLocums.COM"), true);
  assert.equal(isCynetLocumsRecruiter("a@cynethealth.com"), false);
});

test("mapLocumsTypeFromTenNintyNine maps 1099 flag", () => {
  assert.equal(mapLocumsTypeFromTenNintyNine({ ten_ninty_nine_checked: true }), "1099");
  assert.equal(mapLocumsTypeFromTenNintyNine({ ten_ninty_nine_checked: false }), null);
  assert.equal(mapLocumsTypeFromTenNintyNine({}), null);
});

test("CRNA 1099: W2 equals pay rate with no add-ons", () => {
  const out = computeLocumsDerivedPlacementFields(baseRow({
    PAY_RATE: 205,
    PAYMENT_TYPE: "1099",
    SCHEDULE_HOURS_1: 36,
    PROJECT_DURATION: 13,
    START_DATE: "2025-01-01",
  }));
  assert.equal(out.W2_PAY_RATE, 205);
  assert.equal(out.FINAL_PAY_RATE, 223.45);
});

test("HCA CT: W2 includes orientation spread over assignment hours", () => {
  const out = computeLocumsDerivedPlacementFields(baseRow({
    PAY_RATE: 300,
    PAYMENT_TYPE: "1099",
    SCHEDULE_HOURS_1: 40,
    PROJECT_DURATION: 12,
    NBO_HOURS: 4,
    PLACEMENT_TYPE: "CT",
    START_DATE: "2025-06-01",
  }));
  assert.equal(out.W2_PAY_RATE, 302.5);
  assert.equal(out.FINAL_PAY_RATE, 329.73);
});

test("final bill rate applies MSP fee", () => {
  const out = computeLocumsDerivedPlacementFields(baseRow({
    BILL_RATE: 155,
    CLIENT_MSP_FEE: 3.75,
    PAY_RATE: 100,
    PAYMENT_TYPE: "1099",
    START_DATE: "2025-01-01",
  }));
  assert.equal(out.FINAL_BILL_RATE, 149.19);
});

test("MSP fee stored as fraction still works", () => {
  const out = computeLocumsDerivedPlacementFields(baseRow({
    BILL_RATE: 155,
    CLIENT_MSP_FEE: 0.0375,
    PAY_RATE: 100,
    PAYMENT_TYPE: "1099",
    START_DATE: "2025-01-01",
  }));
  assert.equal(out.FINAL_BILL_RATE, 149.19);
});

test("margins: net and gross from bill rate minus pay/cost", () => {
  const out = computeLocumsDerivedPlacementFields(baseRow({
    BILL_RATE: 155,
    CLIENT_MSP_FEE: 3.75,
    PAY_RATE: 100,
    PAYMENT_TYPE: "1099",
    PLACEMENT_TYPE: "CT",
    START_DATE: "2025-01-01",
  }));
  assert.equal(out.FINAL_BILL_RATE, 149.19);
  assert.equal(out.FINAL_PAY_RATE, 109);
  assert.equal(out.FINAL_COST, 109);
  assert.equal(out.CALCULATED_MARGIN, 40.19);
  // MARGIN is retired on Locums: GROSS_MARGIN carries Nexus's hourly revenue instead.
  assert.equal("MARGIN" in out, false);
  assert.equal("NET_MARGIN" in out, false);
});

test("FT placement yields zero margins", () => {
  const out = computeLocumsDerivedPlacementFields(baseRow({
    BILL_RATE: 200,
    PAY_RATE: 100,
    PAYMENT_TYPE: "1099",
    PLACEMENT_TYPE: "FT",
    START_DATE: "2025-01-01",
  }));
  assert.equal(out.CALCULATED_MARGIN, 0);
});

test("PAYMENT_TYPE blank uses 1.14 W2 burden", () => {
  const out = computeLocumsDerivedPlacementFields(baseRow({
    PAY_RATE: 50,
    PAYMENT_TYPE: null,
    SCHEDULE_HOURS_1: 40,
    PROJECT_DURATION: 13,
    START_DATE: "2025-01-01",
  }));
  assert.equal(out.W2_PAY_RATE, 57);
  assert.equal(out.FINAL_PAY_RATE, 61.56);
});

test("PAYMENT_TYPE filled with start before May 2024 keeps W2 as final pay", () => {
  const out = computeLocumsDerivedPlacementFields(baseRow({
    PAY_RATE: 100,
    PAYMENT_TYPE: "1099",
    START_DATE: "2023-01-01",
  }));
  assert.equal(out.W2_PAY_RATE, 100);
  assert.equal(out.FINAL_PAY_RATE, 100);
});

test("locums rows always stamp ENTITY as Locum", () => {
  const out = computeLocumsDerivedPlacementFields(baseRow({
    PAY_RATE: 100,
    PAYMENT_TYPE: "1099",
    START_DATE: "2025-01-01",
  }));
  assert.equal(out.ENTITY, "Locum");
});

test("Gainwell exception uses final bill rate for W2 and final pay", () => {
  const out = computeLocumsDerivedPlacementFields(baseRow({
    ENTITY: "",
    PARENT_CLIENT_NAME: "Gainwell Technologies",
    SPECIALTY: "CRNA",
    BILL_RATE: 200,
    CLIENT_MSP_FEE: 0,
    PAY_RATE: 150,
    PAYMENT_TYPE: "1099",
    START_DATE: "2025-01-01",
  }));
  assert.equal(out.FINAL_BILL_RATE, 200);
  assert.equal(out.W2_PAY_RATE, 200);
  assert.equal(out.FINAL_PAY_RATE, 200);
  assert.equal(out.ENTITY, "Locum");
});

test("sanitizeLocumsDealSheetRow strips NEW rate family columns", () => {
  const row = sanitizeLocumsDealSheetRow({
    ASSIGNMENT_RECRUITER_EMAIL: locumsEmail,
    W2_PAY_RATE: 10,
    W2_PAY_RATE_NEW: 11,
    FINAL_PAY_RATE_NEW: 12,
    REGULAR_HOURS_1: 8,
  });
  assert.equal(row.W2_PAY_RATE, 10);
  assert.equal(row.W2_PAY_RATE_NEW, undefined);
  assert.equal(row.FINAL_PAY_RATE_NEW, undefined);
  assert.equal(row.REGULAR_HOURS_1, undefined);
});

test("sanitizeLocumsDealSheetRow leaves non-locums rows unchanged", () => {
  const row = sanitizeLocumsDealSheetRow({
    ASSIGNMENT_RECRUITER_EMAIL: "x@cynethealth.com",
    W2_PAY_RATE_NEW: 11,
  });
  assert.equal(row.W2_PAY_RATE_NEW, 11);
});

test("LOCUMS_EXCLUDED_API_OWNED_COLUMNS includes NEW rate fields", () => {
  assert.equal(LOCUMS_EXCLUDED_API_OWNED_COLUMNS.has("W2_PAY_RATE_NEW"), true);
  assert.equal(LOCUMS_EXCLUDED_API_OWNED_COLUMNS.has("FINAL_BILL_RATE_NEW"), true);
  // Both are real Locums columns now — CALCULATED_MARGIN from the derived step, GROSS_MARGIN from
  // the API's hourly revenue — so neither may be stripped on insert.
  assert.equal(LOCUMS_EXCLUDED_API_OWNED_COLUMNS.has("CALCULATED_MARGIN"), false);
  assert.equal(LOCUMS_EXCLUDED_API_OWNED_COLUMNS.has("GROSS_MARGIN"), false);
});

test("1099 OT: FINAL_OT_PAY_RATE = OT_RATE x 1.09", () => {
  const out = computeLocumsDerivedPlacementFields(baseRow({
    PLACEMENT_TYPE: "CT",
    PAYMENT_TYPE: "1099",
    OT_RATE: 150,
    PARENT_CLIENT_NAME: "The Southeast Permanente Medical Group",
  }));
  assert.equal(out.FINAL_OT_PAY_RATE, 163.5);
});

test("1099 Holiday: FINAL_HOLIDAY_PAY_RATE = HOLIDAY_RATE x 1.09", () => {
  const out = computeLocumsDerivedPlacementFields(baseRow({
    PLACEMENT_TYPE: "CT",
    PAYMENT_TYPE: "1099",
    HOLIDAY_RATE: 150,
  }));
  assert.equal(out.FINAL_HOLIDAY_PAY_RATE, 163.5);
});

test("1099 zero call back: FINAL_CALL_BACK_PAY_RATE = 0", () => {
  const out = computeLocumsDerivedPlacementFields(baseRow({
    PLACEMENT_TYPE: "CT",
    PAYMENT_TYPE: "1099",
    CALL_BACK_RATE: 0,
  }));
  assert.equal(out.FINAL_CALL_BACK_PAY_RATE, 0);
});

test("FT placement: premium pay rates are null", () => {
  const out = computeLocumsDerivedPlacementFields(baseRow({
    PLACEMENT_TYPE: "FT",
    PAYMENT_TYPE: "1099",
    OT_RATE: 150,
    HOLIDAY_RATE: 150,
    CALL_BACK_RATE: 0,
  }));
  assert.equal(out.FINAL_OT_PAY_RATE, null);
  assert.equal(out.FINAL_HOLIDAY_PAY_RATE, null);
  assert.equal(out.FINAL_CALL_BACK_PAY_RATE, null);
});

test("Gainwell parent: FINAL_OT_PAY_RATE = OT_RATE x 1.23 when PAYMENT_TYPE not 1099", () => {
  const out = computeLocumsDerivedPlacementFields(baseRow({
    PLACEMENT_TYPE: "CT",
    PAYMENT_TYPE: null,
    PARENT_CLIENT_NAME: "Gainwell Technologies",
    OT_RATE: 100,
  }));
  assert.equal(out.FINAL_OT_PAY_RATE, 123);
});

test("1099 beats Gainwell for FINAL_OT_PAY_RATE", () => {
  const out = computeLocumsDerivedPlacementFields(baseRow({
    PLACEMENT_TYPE: "CT",
    PAYMENT_TYPE: "1099",
    PARENT_CLIENT_NAME: "Gainwell Technologies",
    OT_RATE: 100,
  }));
  assert.equal(out.FINAL_OT_PAY_RATE, 109);
});

test("health recruiter does not get premium pay rates from computeDerivedPlacementFields", () => {
  const { computeDerivedPlacementFields } = require("./columnMappings");
  const out = computeDerivedPlacementFields({
    ASSIGNMENT_RECRUITER_EMAIL: "recruiter@cynethealth.com",
    PLACEMENT_TYPE: "CT",
    PAYMENT_TYPE: "1099",
    PAY_RATE: 100,
    OT_RATE: 150,
    HOLIDAY_RATE: 150,
    CALL_BACK_RATE: 0,
    SCHEDULE_HOURS_1: 40,
    PROJECT_DURATION: 13,
    BILL_RATE: 200,
  });
  assert.equal(out.FINAL_OT_PAY_RATE, undefined);
  assert.equal(out.FINAL_HOLIDAY_PAY_RATE, undefined);
  assert.equal(out.FINAL_CALL_BACK_PAY_RATE, undefined);
});

// --- LOADING_COST_EXCEPTION (manual per-row loading override) -------------------------------
// Sheet: FINAL_PAY_RATE = W2 * IF(DP<>"", 1+DP, IF(type="",1.08, IF(start<2024-05-01, 1, 1.09)))
// A filled DP replaces the whole ladder, so the type-blank and pre-May-2024 branches never stack
// on top of it. Base row below lands on the 1.09 branch when DP is empty.
function loadingRow(overrides = {}) {
  return baseRow({
    PAY_RATE: 240,
    BILL_RATE: 425,
    CLIENT_MSP_FEE: 6,
    PAYMENT_TYPE: "1099",
    START_DATE: "2025-12-23",
    PLACEMENT_TYPE: "CT",
    ...overrides,
  });
}

test("no LOADING_COST_EXCEPTION keeps the 1.09 ladder", () => {
  const out = computeLocumsDerivedPlacementFields(loadingRow());
  assert.equal(out.W2_PAY_RATE, 240);
  assert.equal(out.FINAL_PAY_RATE, 261.6);
  assert.equal(out.FINAL_COST, 261.6);
  assert.equal(out.FINAL_BILL_RATE, 399.5);
  assert.equal(out.CALCULATED_MARGIN, 137.9);
});

test("LOADING_COST_EXCEPTION sets the multiplier to 1 + fraction", () => {
  const out = computeLocumsDerivedPlacementFields(loadingRow({ LOADING_COST_EXCEPTION: 0.15 }));
  assert.equal(out.FINAL_PAY_RATE, 276);
  assert.equal(out.FINAL_COST, 276);
  // FINAL_BILL_RATE and W2_PAY_RATE are upstream of the override and must not move.
  assert.equal(out.W2_PAY_RATE, 240);
  assert.equal(out.FINAL_BILL_RATE, 399.5);
  assert.equal(out.CALCULATED_MARGIN, 123.5);
});

test("LOADING_COST_EXCEPTION beats the blank-PAYMENT_TYPE 1.08 branch", () => {
  const out = computeLocumsDerivedPlacementFields(loadingRow({
    PAYMENT_TYPE: "",
    LOADING_COST_EXCEPTION: 0.15,
  }));
  // W2 carries the 1.14 blank-type burden, then DP — not 1.08 — scales it.
  assert.equal(out.W2_PAY_RATE, 273.6);
  assert.equal(out.FINAL_PAY_RATE, 314.64);
});

test("LOADING_COST_EXCEPTION beats the pre-May-2024 carve-out", () => {
  const out = computeLocumsDerivedPlacementFields(loadingRow({
    START_DATE: "2023-01-01",
    LOADING_COST_EXCEPTION: 0.15,
  }));
  assert.equal(out.FINAL_PAY_RATE, 276);
});

test("LOADING_COST_EXCEPTION of 0 is set, and means no loading", () => {
  const out = computeLocumsDerivedPlacementFields(loadingRow({ LOADING_COST_EXCEPTION: 0 }));
  assert.equal(out.FINAL_PAY_RATE, 240);
  assert.notEqual(out.FINAL_PAY_RATE, 261.6);
});

test("a blank-string LOADING_COST_EXCEPTION falls back to the ladder", () => {
  const out = computeLocumsDerivedPlacementFields(loadingRow({ LOADING_COST_EXCEPTION: "  " }));
  assert.equal(out.FINAL_PAY_RATE, 261.6);
});

test("Gainwell exception outranks LOADING_COST_EXCEPTION", () => {
  const out = computeLocumsDerivedPlacementFields(loadingRow({
    ENTITY: "",
    PARENT_CLIENT_NAME: "Gainwell Technologies",
    SPECIALTY: "CRNA",
    LOADING_COST_EXCEPTION: 0.15,
  }));
  assert.equal(out.FINAL_PAY_RATE, out.FINAL_BILL_RATE);
  assert.equal(out.FINAL_PAY_RATE, 399.5);
});

test("FT placement zeroes both margins even with LOADING_COST_EXCEPTION", () => {
  const out = computeLocumsDerivedPlacementFields(loadingRow({
    PLACEMENT_TYPE: "FT",
    LOADING_COST_EXCEPTION: 0.15,
  }));
  assert.equal(out.CALCULATED_MARGIN, 0);
});

test("blank PAYMENT_TYPE: DP still moves CALCULATED_MARGIN", () => {
  const withDp = computeLocumsDerivedPlacementFields(loadingRow({
    PAYMENT_TYPE: "",
    LOADING_COST_EXCEPTION: 0.15,
  }));
  const withoutDp = computeLocumsDerivedPlacementFields(loadingRow({ PAYMENT_TYPE: "" }));
  assert.notEqual(withDp.CALCULATED_MARGIN, withoutDp.CALCULATED_MARGIN);
});

test("the derived step writes CALCULATED_MARGIN and never MARGIN / NET_MARGIN", () => {
  // GROSS_MARGIN is Nexus's hourly_revenue (mapDealSheetRevenueDetailsToBq), so the derived step
  // must leave it alone too — otherwise the API figure would be overwritten on every sync.
  const out = computeLocumsDerivedPlacementFields(loadingRow());
  assert.equal("CALCULATED_MARGIN" in out, true);
  assert.equal("MARGIN" in out, false);
  assert.equal("NET_MARGIN" in out, false);
  assert.equal("GROSS_MARGIN" in out, false);
});

test("LOADING_COST_EXCEPTION is a manual column so the sync never blanks it", () => {
  const { MANUAL_COLUMNS } = require("./columnMappings");
  assert.equal(MANUAL_COLUMNS.has("LOADING_COST_EXCEPTION"), true);
});

// --- GM_OT --------------------------------------------------------------------------------
// The sheet's own formula, verbatim:
//   IFS(AR="","", AR="NA","NA", AR=$AR$1,"GM (OT)", (AR*AS)<>0, (AS*(1-AP)) - ((AR*1.14)+1))
// with AR=OT_RATE, AS=CLIENT_OT_RATE, AP=CLIENT_MSP_FEE. The burden is 1.14, not 1.15 — this went
// untested until Sep 2026, when the live Kirsten Carr row showed the two apart by OT_RATE x 0.01.

test("GM_OT uses the 1.14 burden the sheet states", () => {
  const out = computeLocumsDerivedPlacementFields(baseRow({
    OT_RATE: 230,
    CLIENT_OT_RATE: 338,
    CLIENT_MSP_FEE: 0.0375,
  }));
  // 338 * (1 - 0.0375) - ((230 * 1.14) + 1) = 62.13
  assert.equal(out.GM_OT, 62.13);
  // The retired 1.15 would have given 59.82.
  assert.notEqual(out.GM_OT, 59.82);
});

test("GM_OT normalises an MSP fee given as a percent", () => {
  const asPercent = computeLocumsDerivedPlacementFields(baseRow({
    OT_RATE: 230, CLIENT_OT_RATE: 338, CLIENT_MSP_FEE: 3.75,
  }));
  const asFraction = computeLocumsDerivedPlacementFields(baseRow({
    OT_RATE: 230, CLIENT_OT_RATE: 338, CLIENT_MSP_FEE: 0.0375,
  }));
  assert.equal(asPercent.GM_OT, asFraction.GM_OT);
});

test("GM_OT is blank unless BOTH rates are non-zero", () => {
  // The sheet's (AR*AS)<>0 guard: no margin is reported against a rate that was never agreed.
  for (const over of [
    { OT_RATE: 0, CLIENT_OT_RATE: 338 },
    { OT_RATE: 230, CLIENT_OT_RATE: 0 },
    { OT_RATE: null, CLIENT_OT_RATE: 338 },
    { OT_RATE: 230, CLIENT_OT_RATE: null },
    {},
  ]) {
    assert.equal(
      computeLocumsDerivedPlacementFields(baseRow({ CLIENT_MSP_FEE: 0.0375, ...over })).GM_OT,
      null,
      JSON.stringify(over)
    );
  }
});
