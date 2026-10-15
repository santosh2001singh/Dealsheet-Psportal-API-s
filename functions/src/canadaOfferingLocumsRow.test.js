const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isLocumsDealSheetRow,
  sanitizeLocumsDealSheetRow,
} = require("./locumsDerivedPlacementFields");
const {
  mapDealSheetRevenueDetailsToBq,
  computeDerivedPlacementFields,
} = require("./columnMappings");
const { applyManualColumnsCarryForward } = require("./bigQueryClient");
const { resolveActiveDealSheetTableIdForRow } = require("./recruiterDomainTables");

// Placement 1463925 (Susan Emily Somers, Sep 2026): Ontario, OFFERING=LOCUMS, @cynethealth.ca
// recruiter. It routed to the canada table (province wins) but was ALSO treated as locums, so
// MARGIN came out 0 and the whole T4 rate chain null. A Canadian-province row is Canada business only.

const SUSAN = {
  CLIENT_STATE: "ON",
  OFFERING: "LOCUMS",
  ASSIGNMENT_RECRUITER_EMAIL: "stella.s@cynethealth.ca",
  PLACEMENT_TYPE: "CT",
  PAYMENT_TYPE: "T4A", // ten_ninty_nine_checked = true -> Canada's T4A (locums would say "1099")
  PAY_RATE: 73,
  BILL_RATE: 125,
  CLIENT_MSP_FEE: 0,
  SCHEDULE_HOURS_1: 36,
  PROJECT_DURATION: 26,
  ADDITIONAL_BONUS: 0,
};

test("a Canadian-province row is never a locums row, whatever its OFFERING or recruiter", () => {
  assert.equal(isLocumsDealSheetRow(SUSAN), false);
  assert.equal(isLocumsDealSheetRow({ ...SUSAN, ASSIGNMENT_RECRUITER_EMAIL: "x@cynetlocums.com" }), false);
  // ...and it routes to the canada table, so table and derivations agree.
  assert.equal(resolveActiveDealSheetTableIdForRow(SUSAN), "cynet_health_canada_deal_sheet");
});

test("US locums rows are unchanged", () => {
  assert.equal(isLocumsDealSheetRow({ CLIENT_STATE: "TX", OFFERING: "LOCUMS" }), true);
  assert.equal(isLocumsDealSheetRow({ CLIENT_STATE: "NY", ASSIGNMENT_RECRUITER_EMAIL: "x@cynetlocums.com" }), true);
  // "CA" is California, not Canada.
  assert.equal(isLocumsDealSheetRow({ CLIENT_STATE: "CA", OFFERING: "LOCUMS" }), true);
  assert.equal(isLocumsDealSheetRow({ OFFERING: "LOCUMS" }), true);
});

test("Nexus hourly_revenue lands in MARGIN for the canada row", () => {
  const out = mapDealSheetRevenueDetailsToBq(
    { hourly_revenue: 49.81, gross_margin_percentage: 39.85 },
    { CLIENT_STATE: "ON", OFFERING: "LOCUMS", ASSIGNMENT_RECRUITER_EMAIL: "stella.s@cynethealth.ca" }
  );
  assert.deepEqual(out, { GP_PERCENTAGE: 39.85, MARGIN: 49.81 });
  // A US locums row still takes it in GROSS_MARGIN.
  assert.deepEqual(
    mapDealSheetRevenueDetailsToBq({ hourly_revenue: 10, gross_margin_percentage: 5 }, { CLIENT_STATE: "TX", OFFERING: "LOCUMS" }),
    { GP_PERCENTAGE: 5, GROSS_MARGIN: 10 }
  );
});

test("the canada row gets the Ontario T4A rate chain", () => {
  const out = computeDerivedPlacementFields(SUSAN);
  assert.equal(out.T4_PAY_RATE, 75.46); // 73 * 1.0337
  assert.equal(out.FINAL_PAY_RATE, 75.46);
  assert.equal(out.FINAL_COST, 77.72); // * 1.03
  assert.equal(out.FINAL_BILL_RATE, 125);
  assert.equal(out.CALCULATED_MARGIN, 47.28);
  assert.equal(out.GROSS_MARGIN, 49.54);
  assert.ok(!("MARGIN" in out), "MARGIN stays Nexus hourly_revenue");
});

test("the locums sanitizer leaves the canada row alone", () => {
  const row = { ...SUSAN, T4_PAY_RATE: 75.46, MARGIN: 49.81 };
  assert.deepEqual(sanitizeLocumsDealSheetRow(row), row);
});

test("a canada row keeps its stored ENTITY even with a locums recruiter", () => {
  const incoming = { ...SUSAN, ASSIGNMENT_RECRUITER_EMAIL: "x@cynetlocums.com", ENTITY: null };
  const baseline = { ...incoming, ENTITY: "CANADA HEALTH" };
  assert.equal(applyManualColumnsCarryForward(incoming, baseline).row.ENTITY, "CANADA HEALTH");
});
