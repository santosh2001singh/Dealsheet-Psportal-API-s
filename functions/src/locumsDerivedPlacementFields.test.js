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
    TYPE: "1099",
    SCHEDULE_HOURS_1: 36,
    INITIAL_PROJECT_DURATION_IN_WEEKS: 13,
    START_DATE: "2025-01-01",
  }));
  assert.equal(out.W2_PAY_RATE, 205);
  assert.equal(out.FINAL_PAY_RATE, 223.45);
});

test("HCA CT: W2 includes orientation spread over assignment hours", () => {
  const out = computeLocumsDerivedPlacementFields(baseRow({
    PAY_RATE: 300,
    TYPE: "1099",
    SCHEDULE_HOURS_1: 40,
    INITIAL_PROJECT_DURATION_IN_WEEKS: 12,
    ORIENTATION_HOURS: 4,
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
    TYPE: "1099",
    START_DATE: "2025-01-01",
  }));
  assert.equal(out.FINAL_BILL_RATE, 149.19);
});

test("MSP fee stored as fraction still works", () => {
  const out = computeLocumsDerivedPlacementFields(baseRow({
    BILL_RATE: 155,
    CLIENT_MSP_FEE: 0.0375,
    PAY_RATE: 100,
    TYPE: "1099",
    START_DATE: "2025-01-01",
  }));
  assert.equal(out.FINAL_BILL_RATE, 149.19);
});

test("margins: net and gross from bill rate minus pay/cost", () => {
  const out = computeLocumsDerivedPlacementFields(baseRow({
    BILL_RATE: 155,
    CLIENT_MSP_FEE: 3.75,
    PAY_RATE: 100,
    TYPE: "1099",
    PLACEMENT_TYPE: "CT",
    START_DATE: "2025-01-01",
  }));
  assert.equal(out.FINAL_BILL_RATE, 149.19);
  assert.equal(out.FINAL_PAY_RATE, 109);
  assert.equal(out.FINAL_COST, 109);
  assert.equal(out.NET_MARGIN, 40.19);
  assert.equal(out.GROSS_MARGIN, 40.19);
});

test("FT placement yields zero margins", () => {
  const out = computeLocumsDerivedPlacementFields(baseRow({
    BILL_RATE: 200,
    PAY_RATE: 100,
    TYPE: "1099",
    PLACEMENT_TYPE: "FT",
    START_DATE: "2025-01-01",
  }));
  assert.equal(out.NET_MARGIN, 0);
  assert.equal(out.GROSS_MARGIN, 0);
});

test("TYPE blank uses 1.14 W2 burden", () => {
  const out = computeLocumsDerivedPlacementFields(baseRow({
    PAY_RATE: 50,
    TYPE: null,
    SCHEDULE_HOURS_1: 40,
    INITIAL_PROJECT_DURATION_IN_WEEKS: 13,
    START_DATE: "2025-01-01",
  }));
  assert.equal(out.W2_PAY_RATE, 57);
  assert.equal(out.FINAL_PAY_RATE, 61.56);
});

test("TYPE filled with start before May 2024 keeps W2 as final pay", () => {
  const out = computeLocumsDerivedPlacementFields(baseRow({
    PAY_RATE: 100,
    TYPE: "1099",
    START_DATE: "2023-01-01",
  }));
  assert.equal(out.W2_PAY_RATE, 100);
  assert.equal(out.FINAL_PAY_RATE, 100);
});

test("locums rows always stamp ENTITY as Locum", () => {
  const out = computeLocumsDerivedPlacementFields(baseRow({
    PAY_RATE: 100,
    TYPE: "1099",
    START_DATE: "2025-01-01",
  }));
  assert.equal(out.ENTITY, "Locum");
});

test("Gainwell exception uses final bill rate for W2 and final pay", () => {
  const out = computeLocumsDerivedPlacementFields(baseRow({
    ENTITY: "",
    PARENT_CLIENT_NAME: "Gainwell Technologies",
    POSITION: "CRNA",
    BILL_RATE: 200,
    CLIENT_MSP_FEE: 0,
    PAY_RATE: 150,
    TYPE: "1099",
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
  assert.equal(LOCUMS_EXCLUDED_API_OWNED_COLUMNS.has("NEW_MARGIN"), true);
});
