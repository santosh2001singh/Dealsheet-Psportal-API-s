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
  assert.equal(out.NET_MARGIN, 40.19);
  assert.equal(out.MARGIN, 40.19);
});

test("FT placement yields zero margins", () => {
  const out = computeLocumsDerivedPlacementFields(baseRow({
    BILL_RATE: 200,
    PAY_RATE: 100,
    PAYMENT_TYPE: "1099",
    PLACEMENT_TYPE: "FT",
    START_DATE: "2025-01-01",
  }));
  assert.equal(out.NET_MARGIN, 0);
  assert.equal(out.MARGIN, 0);
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
  assert.equal(LOCUMS_EXCLUDED_API_OWNED_COLUMNS.has("CALCULATED_MARGIN"), true);
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
