const test = require("node:test");
const assert = require("node:assert/strict");

const {
  usesRegularHoursOtSplit,
  computeW2PayRateNew,
  computeFinalBillRateNew,
  computeNewRateFamily,
  computeNewMargin,
  parseBillableOrientationFraction,
} = require("./w2PayRateNew");
const {
  mapDealSheetDetailToBq,
  mapDealSheetHoursDetailsToBq,
  formatBillableOrientationPercent,
  coerceApiFloatNullsToZero,
} = require("./columnMappings");

test("formatBillableOrientationPercent normalizes Nexus values", () => {
  assert.equal(formatBillableOrientationPercent("70.00"), "70.00%");
  assert.equal(formatBillableOrientationPercent("70.00%"), "70.00%");
  assert.equal(formatBillableOrientationPercent(null), "0.00%");
  assert.equal(formatBillableOrientationPercent(""), "0.00%");
  assert.equal(formatBillableOrientationPercent(0), "0.00%");
});

test("mapDealSheetDetailToBq maps billable orientation from Nexus deal sheet", () => {
  const out = mapDealSheetDetailToBq({
    id: 5226405,
    non_billable_orientation_hrs: 16,
    billable_orientation_hrs: 24,
    billable_orientation: "70.00",
  });
  assert.equal(out.NBO_HOURS, 16);
  assert.equal(out.BILLABLE_ORIENTATION_HRS, 24);
  assert.equal(out.BILLABLE_ORIENTATION, "70.00%");
});

test("coerceApiFloatNullsToZero defaults billable orientation fields", () => {
  const out = coerceApiFloatNullsToZero({
    BILLABLE_ORIENTATION_HRS: null,
    BILLABLE_ORIENTATION: null,
  });
  assert.equal(out.BILLABLE_ORIENTATION_HRS, 0);
  assert.equal(out.BILLABLE_ORIENTATION, "0.00%");
});

test("parseBillableOrientationFraction", () => {
  assert.equal(parseBillableOrientationFraction("70.00%"), 0.7);
  assert.equal(parseBillableOrientationFraction("0.00%"), 0);
  assert.equal(parseBillableOrientationFraction(null), 0);
});

test("usesRegularHoursOtSplit is true for CA and AK only", () => {
  assert.equal(usesRegularHoursOtSplit("CA"), true);
  assert.equal(usesRegularHoursOtSplit("ak"), true);
  assert.equal(usesRegularHoursOtSplit("TX"), false);
  assert.equal(usesRegularHoursOtSplit(null), false);
});

test("mapDealSheetHoursDetailsToBq fills REGULAR_HOURS for CA and AK, not TX", () => {
  const hoursRow = {
    total_assignment_hrs: 500,
    scheduled_hrs_1: 48,
    scheduled_hrs_2: 36,
    regular_hrs_1: 40,
    regular_hrs_2: 36,
  };
  const ca = mapDealSheetHoursDetailsToBq(hoursRow, "CA");
  const ak = mapDealSheetHoursDetailsToBq(hoursRow, "AK");
  const tx = mapDealSheetHoursDetailsToBq(hoursRow, "TX");
  assert.equal(ca.REGULAR_HOURS_1, 40);
  assert.equal(ca.REGULAR_HOURS_2, 36);
  assert.equal(ak.REGULAR_HOURS_1, 40);
  assert.equal(ak.REGULAR_HOURS_2, 36);
  assert.equal(tx.REGULAR_HOURS_1, 0);
  assert.equal(tx.REGULAR_HOURS_2, 0);
});

/** Shared row where regular-hours split differs from the 40-hour weekly path. */
function regularHoursSampleRow(clientState) {
  return {
    CLIENT_STATE: clientState,
    PLACEMENT_TYPE: "TRAVEL",
    SCHEDULE_HOURS_1: 48,
    SCHEDULE_HOURS_2: 36,
    REGULAR_HOURS_1: 40,
    REGULAR_HOURS_2: 36,
    FIRST_WEEK_HOURS: 1,
    SECOND_WEEK_HOURS: 1,
    PAY_RATE: 50,
    OT_RATE: 75,
    TOTAL_BONUS_TAXABLE: 0,
    TOTAL_BONUS_NON_TAXABLE: 0,
    PO_HOURS: 500,
    NBO_HOURS: 0,
    BILL_RATE: 100,
    CLIENT_OT_RATE: 150,
    CLIENT_MSP_FEE: 0,
    WEEKLY_PER_DIEM_NON_TAXED: 0,
    BILLABLE_ORIENTATION_HRS: 0,
    BILLABLE_ORIENTATION: "0.00%",
  };
}

test("CA and AK produce the same W2_PAY_RATE_NEW and FINAL_BILL_RATE_NEW", () => {
  const ca = regularHoursSampleRow("CA");
  const ak = regularHoursSampleRow("AK");
  assert.equal(computeW2PayRateNew(ca).W2_PAY_RATE_NEW, computeW2PayRateNew(ak).W2_PAY_RATE_NEW);
  assert.equal(computeFinalBillRateNew(ca), computeFinalBillRateNew(ak));
  const caFamily = computeNewRateFamily(ca);
  const akFamily = computeNewRateFamily(ak);
  assert.equal(caFamily.W2_PAY_RATE_NEW, akFamily.W2_PAY_RATE_NEW);
  assert.equal(caFamily.FINAL_BILL_RATE_NEW, akFamily.FINAL_BILL_RATE_NEW);
});

test("TX differs from CA/AK when schedule hours exceed regular hours", () => {
  const ca = computeNewRateFamily(regularHoursSampleRow("CA"));
  const tx = computeNewRateFamily(regularHoursSampleRow("TX"));
  // FINAL_BILL_RATE_NEW: CA uses regular-hours gross; TX uses PO*BR path — those differ.
  assert.notEqual(ca.FINAL_BILL_RATE_NEW, tx.FINAL_BILL_RATE_NEW);
});

test("computeNewMargin applies sheet orientation billing adjustment", () => {
  const row = {
    PO_HOURS: 500,
    BILLABLE_ORIENTATION_HRS: 24,
    BILLABLE_ORIENTATION: "70.00%",
  };
  const eu = 100;
  const eq = 80;
  const out = computeNewMargin(row, eu, eq);
  // adjustment = 100 * 24 * 0.30 / 500 = 1.44
  assert.ok(Math.abs(out - 18.56) < 1e-9);
});

test("computeNewMargin with zero billable hrs equals simple subtract", () => {
  const row = {
    PO_HOURS: 500,
    BILLABLE_ORIENTATION_HRS: 0,
    BILLABLE_ORIENTATION: "70.00%",
  };
  assert.equal(computeNewMargin(row, 100, 80), 20);
});

test("computeNewMargin returns null when PO_HOURS is zero", () => {
  const row = {
    PO_HOURS: 0,
    BILLABLE_ORIENTATION_HRS: 24,
    BILLABLE_ORIENTATION: "70.00%",
  };
  assert.equal(computeNewMargin(row, 100, 80), null);
});

test("computeNewMargin returns null when bill rate or cost is null", () => {
  const row = { PO_HOURS: 500, BILLABLE_ORIENTATION_HRS: 24, BILLABLE_ORIENTATION: "70.00%" };
  assert.equal(computeNewMargin(row, null, 80), null);
  assert.equal(computeNewMargin(row, 100, null), null);
});
