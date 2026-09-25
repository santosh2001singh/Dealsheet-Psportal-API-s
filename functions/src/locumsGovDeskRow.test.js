const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isLocumsDealSheetRow,
  sanitizeLocumsDealSheetRow,
} = require("./locumsDerivedPlacementFields");
const {
  computeDerivedPlacementFields,
  mapDealSheetRevenueDetailsToBq,
} = require("./columnMappings");

/**
 * A locums row is decided by the ROW, not by the recruiter's email.
 *
 * Rows route into cynet_locums_deal_sheet on OFFERING as well — the GOV desk sits on
 * @cynethealth.com and places locums work — but every derivation still keyed on the email alone, so
 * those rows landed in the locums table and then took cynet health's shape.
 *
 * Live case, deal sheet 5161506 (yogesh.t@cynethealth.com, OFFERING=LOCUMS):
 *   * Nexus sent hourly_revenue 250.25; GROSS_MARGIN stored 249.25, because health's derived step
 *     overwrote the API figure with a computed one.
 *   * W2_PAY_RATE_NEW / FINAL_*_NEW / FIRST_WEEK_HOURS / BILLABLE_ORIENTATION survived, though the
 *     locums sanitizer exists to strip exactly those.
 */

const GOV_ROW = {
  ASSIGNMENT_RECRUITER_EMAIL: "yogesh.t@cynethealth.com",
  OFFERING: "LOCUMS",
  PAY_RATE: 0,
  BILL_RATE: 260,
  CLIENT_MSP_FEE: 0.0375,
  PLACEMENT_TYPE: "CT",
  START_DATE: "2026-02-16",
  W2_PAY_RATE_NEW: 0,
  FINAL_PAY_RATE_NEW: 0,
  FINAL_COST_NEW: 1,
  FINAL_BILL_RATE_NEW: 250.25,
  FIRST_WEEK_HOURS: 32,
  BILLABLE_ORIENTATION: "0.00%",
};

const HEALTH_ROW = {
  ASSIGNMENT_RECRUITER_EMAIL: "someone@cynethealth.com",
  OFFERING: "NURSING",
  PAY_RATE: 50,
  BILL_RATE: 80,
  PLACEMENT_TYPE: "CT",
  START_DATE: "2026-02-16",
  W2_PAY_RATE_NEW: 1,
};

test("a locums row is either the recruiter's domain OR the offering", () => {
  assert.equal(isLocumsDealSheetRow({ ASSIGNMENT_RECRUITER_EMAIL: "a@cynetlocums.com" }), true);
  assert.equal(isLocumsDealSheetRow(GOV_ROW), true);
  assert.equal(isLocumsDealSheetRow(HEALTH_ROW), false);
  assert.equal(isLocumsDealSheetRow({ ASSIGNMENT_RECRUITER_EMAIL: "a@cynethealth.com" }), false);
});

test("the OFFERING half is case- and whitespace-insensitive", () => {
  for (const v of ["LOCUMS", "locums", "  Locums  "]) {
    assert.equal(isLocumsDealSheetRow({ OFFERING: v }), true, v);
  }
});

test("a null or non-object row is never locums", () => {
  for (const v of [null, undefined, "", 0, "LOCUMS"]) {
    assert.equal(isLocumsDealSheetRow(v), false, String(v));
  }
});

// --------------------------------------------------------------------------
// The two failures the live GOV row showed.
// --------------------------------------------------------------------------

test("a GOV-desk row takes the locums derivations, not health's", () => {
  const out = computeDerivedPlacementFields(GOV_ROW);
  assert.equal("CALCULATED_MARGIN" in out, true, "locums fills CALCULATED_MARGIN");
  // ...and must NOT emit GROSS_MARGIN, which is the API's hourly_revenue on this table.
  assert.equal("GROSS_MARGIN" in out, false, "computing it would clobber Nexus's figure");
  assert.equal("MARGIN" in out, false);
  assert.equal("NET_MARGIN" in out, false);
});

test("Nexus's hourly revenue reaches GROSS_MARGIN on a GOV-desk row", () => {
  // The live payload for deal sheet 5161506.
  const out = mapDealSheetRevenueDetailsToBq(
    { hourly_revenue: 250.25, gross_margin_percentage: 100 },
    GOV_ROW
  );
  assert.equal(out.GROSS_MARGIN, 250.25);
  assert.equal(out.MARGIN, undefined, "the locums table has no MARGIN column");
});

test("the sanitizer strips the *_NEW family from a GOV-desk row", () => {
  const out = sanitizeLocumsDealSheetRow(GOV_ROW);
  for (const c of [
    "W2_PAY_RATE_NEW",
    "FINAL_PAY_RATE_NEW",
    "FINAL_COST_NEW",
    "FINAL_BILL_RATE_NEW",
    "FIRST_WEEK_HOURS",
    "BILLABLE_ORIENTATION",
  ]) {
    assert.equal(c in out, false, `${c} must not survive`);
  }
});

// --------------------------------------------------------------------------
// Cynet health must be untouched by all of it.
// --------------------------------------------------------------------------

test("a health row keeps health's derivations", () => {
  const out = computeDerivedPlacementFields(HEALTH_ROW);
  assert.equal("CALCULATED_MARGIN" in out, false);
  assert.ok("NET_MARGIN" in out || "GROSS_MARGIN" in out);
});

test("a health row still takes hourly revenue in MARGIN", () => {
  const out = mapDealSheetRevenueDetailsToBq(
    { hourly_revenue: 55.5, gross_margin_percentage: 9.8 },
    HEALTH_ROW
  );
  assert.equal(out.MARGIN, 55.5);
  assert.equal(out.GROSS_MARGIN, undefined);
});

test("the sanitizer leaves a health row alone", () => {
  assert.equal(sanitizeLocumsDealSheetRow(HEALTH_ROW).W2_PAY_RATE_NEW, 1);
});
