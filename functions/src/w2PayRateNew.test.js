const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeW2PayRateNew,
  computeFinalPayRateNew,
  computeFinalCostNew,
  computeFinalBillRateNew,
  computeNewMargin,
  computeNewRateFamily,
} = require("./w2PayRateNew");

test("computeW2PayRateNew null when PLACEMENT_TYPE empty", () => {
  assert.equal(computeW2PayRateNew({ PLACEMENT_TYPE: null }).W2_PAY_RATE_NEW, null);
  assert.equal(computeW2PayRateNew({ PLACEMENT_TYPE: "" }).W2_PAY_RATE_NEW, null);
  assert.equal(computeW2PayRateNew({ PLACEMENT_TYPE: "   " }).W2_PAY_RATE_NEW, null);
});

test("computeW2PayRateNew zero for FT and INTERNAL", () => {
  assert.equal(computeW2PayRateNew({ PLACEMENT_TYPE: "FT" }).W2_PAY_RATE_NEW, 0);
  assert.equal(computeW2PayRateNew({ PLACEMENT_TYPE: "ft " }).W2_PAY_RATE_NEW, 0);
  assert.equal(computeW2PayRateNew({ PLACEMENT_TYPE: "INTERNAL" }).W2_PAY_RATE_NEW, 0);
});

test("computeW2PayRateNew non-CA CT basic example", () => {
  const out = computeW2PayRateNew({
    PLACEMENT_TYPE: "CT",
    CLIENT_STATE: "TX",
    SCHEDULE_HOURS_1: 40,
    SCHEDULE_HOURS_2: 0,
    REGULAR_HOURS_1: 0,
    REGULAR_HOURS_2: 0,
    FIRST_WEEK_HOURS: 7,
    SECOND_WEEK_HOURS: 6,
    PAY_RATE: 50,
    OT_RATE: 75,
    TOTAL_BONUS_TAXABLE: 0,
    TOTAL_BONUS_NON_TAXABLE: 0,
    PO_HOURS: 468,
    ORIENTATION_HOURS: 8,
  });
  const expected = (1.23 * 40 * 7 * 50) / (468 - 8);
  assert.ok(Math.abs(out.W2_PAY_RATE_NEW - expected) < 1e-9);
  assert.ok(Math.abs(out.W2_PAY_RATE_NEW - 37.43478260869565) < 1e-9);
});

test("computeW2PayRateNew non-CA CT with overtime and bonuses", () => {
  const out = computeW2PayRateNew({
    PLACEMENT_TYPE: "CT",
    CLIENT_STATE: "TX",
    SCHEDULE_HOURS_1: 48,
    SCHEDULE_HOURS_2: 0,
    FIRST_WEEK_HOURS: 13,
    SECOND_WEEK_HOURS: 0,
    PAY_RATE: 25,
    OT_RATE: 37.5,
    TOTAL_BONUS_TAXABLE: 500,
    TOTAL_BONUS_NON_TAXABLE: 1000,
    PO_HOURS: 624,
    ORIENTATION_HOURS: 8,
  });
  const stateBranch = 40 * 13 * 25 + 8 * 37.5 * 13;
  const numerator = 1.23 * stateBranch + 1.23 * 500 + 1000;
  const expected = numerator / (624 - 8);
  assert.ok(Math.abs(out.W2_PAY_RATE_NEW - expected) < 1e-9);
});

test("computeW2PayRateNew CA branch uses REGULAR_HOURS", () => {
  const out = computeW2PayRateNew({
    PLACEMENT_TYPE: "CT",
    CLIENT_STATE: "CA",
    SCHEDULE_HOURS_1: 36,
    REGULAR_HOURS_1: 36,
    SCHEDULE_HOURS_2: 48,
    REGULAR_HOURS_2: 40,
    FIRST_WEEK_HOURS: 7,
    SECOND_WEEK_HOURS: 6,
    PAY_RATE: 25,
    OT_RATE: 38.63,
    TOTAL_BONUS_TAXABLE: 0,
    TOTAL_BONUS_NON_TAXABLE: 0,
    PO_HOURS: 468,
    ORIENTATION_HOURS: 0,
  });
  const stateBranch =
    36 * 7 * 25 + 0 + 40 * 6 * 25 + 8 * 38.63 * 6;
  const expected = (1.23 * stateBranch) / 468;
  assert.ok(Math.abs(out.W2_PAY_RATE_NEW - expected) < 1e-9);
});

test("computeW2PayRateNew lowercase ca triggers CA branch", () => {
  const base = {
    PLACEMENT_TYPE: "CT",
    SCHEDULE_HOURS_1: 48,
    REGULAR_HOURS_1: 36,
    SCHEDULE_HOURS_2: 0,
    REGULAR_HOURS_2: 0,
    FIRST_WEEK_HOURS: 1,
    SECOND_WEEK_HOURS: 0,
    PAY_RATE: 10,
    OT_RATE: 20,
    PO_HOURS: 100,
    ORIENTATION_HOURS: 0,
  };
  const ca = computeW2PayRateNew({ ...base, CLIENT_STATE: "ca" });
  const tx = computeW2PayRateNew({ ...base, CLIENT_STATE: "TX" });
  const caExpected = (1.23 * (36 * 10 + 12 * 20)) / 100;
  const txExpected = (1.23 * (40 * 10 + 8 * 20)) / 100;
  assert.ok(Math.abs(ca.W2_PAY_RATE_NEW - caExpected) < 1e-9);
  assert.ok(Math.abs(tx.W2_PAY_RATE_NEW - txExpected) < 1e-9);
  assert.notEqual(ca.W2_PAY_RATE_NEW, tx.W2_PAY_RATE_NEW);
});

test("computeW2PayRateNew null when PO_HOURS equals ORIENTATION_HOURS", () => {
  const out = computeW2PayRateNew({
    PLACEMENT_TYPE: "CT",
    CLIENT_STATE: "TX",
    SCHEDULE_HOURS_1: 40,
    FIRST_WEEK_HOURS: 7,
    PAY_RATE: 50,
    PO_HOURS: 8,
    ORIENTATION_HOURS: 8,
  });
  assert.equal(out.W2_PAY_RATE_NEW, null);
});

test("computeW2PayRateNew null blank numeric inputs treated as zero", () => {
  const out = computeW2PayRateNew({
    PLACEMENT_TYPE: "CT",
    CLIENT_STATE: "TX",
    SCHEDULE_HOURS_1: 40,
    FIRST_WEEK_HOURS: 1,
    PAY_RATE: 100,
    OT_RATE: null,
    PO_HOURS: 100,
    ORIENTATION_HOURS: 0,
  });
  assert.equal(out.W2_PAY_RATE_NEW, (1.23 * 40 * 1 * 100) / 100);
});

test("computeFinalPayRateNew zero when W2 is 0", () => {
  assert.equal(
    computeFinalPayRateNew({ WEEKLY_PER_DIEM_NON_TAXED: 1000 }, 0),
    0
  );
});

test("computeFinalPayRateNew null when W2 is null", () => {
  assert.equal(
    computeFinalPayRateNew({ PLACEMENT_TYPE: null }, null),
    null
  );
});

test("computeFinalPayRateNew normal CT row", () => {
  const row = {
    PLACEMENT_TYPE: "CT",
    WEEKLY_PER_DIEM_NON_TAXED: 500,
    FIRST_WEEK_HOURS: 7,
    SECOND_WEEK_HOURS: 6,
    PO_HOURS: 468,
    ORIENTATION_HOURS: 8,
  };
  const w2 = 37.43478260869565;
  const expected = (500 * 13 * 1.09) / 460 + w2;
  assert.ok(Math.abs(computeFinalPayRateNew(row, w2) - expected) < 1e-9);
});

test("computeFinalPayRateNew null when denominator zero", () => {
  assert.equal(
    computeFinalPayRateNew(
      { PO_HOURS: 8, ORIENTATION_HOURS: 8, FIRST_WEEK_HOURS: 1 },
      10
    ),
    null
  );
});

test("computeFinalCostNew null when final pay is null", () => {
  assert.equal(computeFinalCostNew({ PO_HOURS: 100 }, null), null);
});

test("computeFinalCostNew normal", () => {
  const row = { PO_HOURS: 468, ORIENTATION_HOURS: 8 };
  const finalPay = 50;
  const expected = finalPay + 468 / 460;
  assert.ok(Math.abs(computeFinalCostNew(row, finalPay) - expected) < 1e-9);
});

test("computeFinalCostNew null when denominator zero", () => {
  assert.equal(computeFinalCostNew({ PO_HOURS: 8, ORIENTATION_HOURS: 8 }, 50), null);
});

test("computeFinalBillRateNew null when denominator zero", () => {
  assert.equal(
    computeFinalBillRateNew({ PO_HOURS: 8, ORIENTATION_HOURS: 8, BILL_RATE: 100 }),
    null
  );
});

test("computeFinalBillRateNew non-CA basic", () => {
  const row = {
    CLIENT_STATE: "TX",
    BILL_RATE: 100,
    CLIENT_MSP_FEE: 0,
    PO_HOURS: 468,
    ORIENTATION_HOURS: 8,
  };
  const expected = ((468 * 100 - 100 * 8) * 1) / 460;
  assert.ok(Math.abs(computeFinalBillRateNew(row) - expected) < 1e-9);
  assert.ok(Math.abs(computeFinalBillRateNew(row) - 100) < 1e-9);
});

test("computeFinalBillRateNew non-CA with MSP fee", () => {
  const row = {
    CLIENT_STATE: "TX",
    BILL_RATE: 100,
    CLIENT_MSP_FEE: 0.1,
    PO_HOURS: 468,
    ORIENTATION_HOURS: 8,
  };
  assert.ok(Math.abs(computeFinalBillRateNew(row) - 90) < 1e-9);
});

test("computeFinalBillRateNew CA branch", () => {
  const row = {
    CLIENT_STATE: "CA",
    BILL_RATE: 110,
    CLIENT_OT_RATE: 154,
    CLIENT_MSP_FEE: 0,
    SCHEDULE_HOURS_1: 36,
    REGULAR_HOURS_1: 36,
    SCHEDULE_HOURS_2: 48,
    REGULAR_HOURS_2: 40,
    FIRST_WEEK_HOURS: 7,
    SECOND_WEEK_HOURS: 6,
    PO_HOURS: 468,
    ORIENTATION_HOURS: 0,
  };
  const gross =
    36 * 7 * 110 +
    0 +
    40 * 6 * 110 +
    8 * 154 * 6;
  const expected = gross / 468;
  assert.ok(Math.abs(computeFinalBillRateNew(row) - expected) < 1e-9);
});

test("computeNewMargin null when bill or cost null", () => {
  assert.equal(computeNewMargin(null, 10), null);
  assert.equal(computeNewMargin(100, null), null);
});

test("computeNewMargin subtracts cost from bill", () => {
  assert.equal(computeNewMargin(90, 50), 40);
});

test("computeNewRateFamily FT placement", () => {
  const out = computeNewRateFamily({
    PLACEMENT_TYPE: "FT",
    BILL_RATE: 100,
    PO_HOURS: 468,
    ORIENTATION_HOURS: 8,
    CLIENT_MSP_FEE: 0,
    CLIENT_STATE: "TX",
  });
  assert.equal(out.W2_PAY_RATE_NEW, 0);
  assert.equal(out.FINAL_PAY_RATE_NEW, 0);
  assert.equal(out.FINAL_COST_NEW, 1.02);
  assert.equal(out.FINAL_BILL_RATE_NEW, 100);
  assert.equal(out.NEW_MARGIN, 98.98);
});

test("computeNewRateFamily empty placement", () => {
  const out = computeNewRateFamily({
    PLACEMENT_TYPE: "",
    BILL_RATE: 100,
    PO_HOURS: 468,
    ORIENTATION_HOURS: 8,
    CLIENT_MSP_FEE: 0,
    CLIENT_STATE: "TX",
  });
  assert.equal(out.W2_PAY_RATE_NEW, null);
  assert.equal(out.FINAL_PAY_RATE_NEW, null);
  assert.equal(out.FINAL_COST_NEW, null);
  assert.ok(Math.abs(out.FINAL_BILL_RATE_NEW - 100) < 1e-9);
  assert.equal(out.NEW_MARGIN, null);
});
