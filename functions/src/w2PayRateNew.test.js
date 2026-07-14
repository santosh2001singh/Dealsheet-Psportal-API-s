const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeNewMargin,
  parseBillableOrientationFraction,
} = require("./w2PayRateNew");
const {
  mapDealSheetDetailToBq,
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
  assert.equal(out.ORIENTATION_HOURS, 16);
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
