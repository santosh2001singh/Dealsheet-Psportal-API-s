const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveDurationMultiplier,
  computeBonusTotals,
} = require("./bonusTotals");

const sampleHours = {
  total_weeks: 13,
  total_months: 2.99,
  total_billable_hrs: 444,
  total_days: 39,
};

test("resolveDurationMultiplier ONE_TIME and empty default to 1", () => {
  assert.equal(resolveDurationMultiplier("ONE_TIME", sampleHours), 1);
  assert.equal(resolveDurationMultiplier("", sampleHours), 1);
  assert.equal(resolveDurationMultiplier(null, sampleHours), 1);
  assert.equal(resolveDurationMultiplier("UNKNOWN", sampleHours), 1);
});

test("resolveDurationMultiplier uses hours row fields", () => {
  assert.equal(resolveDurationMultiplier("WEEKLY", sampleHours), 13);
  assert.equal(resolveDurationMultiplier("MONTHLY", sampleHours), 2.99);
  assert.equal(resolveDurationMultiplier("HOURLY", sampleHours), 444);
  assert.equal(resolveDurationMultiplier("DAILY", sampleHours), 39);
});

test("resolveDurationMultiplier returns 0 when hours field missing", () => {
  assert.equal(resolveDurationMultiplier("WEEKLY", null), 0);
  assert.equal(resolveDurationMultiplier("MONTHLY", {}), 0);
  assert.equal(resolveDurationMultiplier("HOURLY", { total_weeks: 13 }), 0);
});

test("computeBonusTotals non-taxable weekly + one-time example (1095)", () => {
  const addCostRows = [
    {
      value: 75,
      deal_sheet_cost_data: {
        deal_sheet_category_id: "REIMBURSEMENT",
        deal_sheet_cost_duration_id: "WEEKLY",
      },
    },
    {
      value: 120,
      deal_sheet_cost_data: {
        deal_sheet_category_id: "REIMBURSEMENT",
        deal_sheet_cost_duration_id: "ONE_TIME",
      },
    },
  ];
  const out = computeBonusTotals(addCostRows, [], sampleHours);
  assert.equal(out.TOTAL_BONUS_TAXABLE, 0);
  assert.equal(out.TOTAL_BONUS_NON_TAXABLE, 1095);
});

test("computeBonusTotals monthly reimbursement + travel allowance (558.8)", () => {
  const addCostRows = [
    {
      value: 120,
      deal_sheet_cost_data: {
        deal_sheet_category_id: "REIMBURSEMENT",
        deal_sheet_cost_duration_id: "MONTHLY",
      },
    },
  ];
  const travelRows = [{ total_amount: 200 }];
  const out = computeBonusTotals(addCostRows, travelRows, sampleHours);
  assert.equal(out.TOTAL_BONUS_TAXABLE, 0);
  assert.equal(out.TOTAL_BONUS_NON_TAXABLE, 558.8);
});

test("computeBonusTotals taxable one-time + weekly bonus (5175)", () => {
  const addCostRows = [
    {
      value: 300,
      deal_sheet_cost_data: {
        deal_sheet_category_id: "BONUS",
        deal_sheet_cost_duration_id: "ONE_TIME",
      },
    },
    {
      value: 375,
      deal_sheet_cost_data: {
        deal_sheet_category_id: "BONUS",
        deal_sheet_cost_duration_id: "WEEKLY",
      },
    },
  ];
  const out = computeBonusTotals(addCostRows, [], sampleHours);
  assert.equal(out.TOTAL_BONUS_TAXABLE, 5175);
  assert.equal(out.TOTAL_BONUS_NON_TAXABLE, 0);
});

test("computeBonusTotals BONUS_FACILITY_PAID counts as taxable", () => {
  const addCostRows = [
    {
      value: 500,
      deal_sheet_cost_data: {
        deal_sheet_category_id: "BONUS_FACILITY_PAID",
        deal_sheet_cost_duration_id: "ONE_TIME",
      },
    },
  ];
  const out = computeBonusTotals(addCostRows, [], sampleHours);
  assert.equal(out.TOTAL_BONUS_TAXABLE, 500);
  assert.equal(out.TOTAL_BONUS_NON_TAXABLE, 0);
});

test("computeBonusTotals null or blank value contributes 0", () => {
  const addCostRows = [
    {
      value: null,
      deal_sheet_cost_data: {
        deal_sheet_category_id: "BONUS",
        deal_sheet_cost_duration_id: "ONE_TIME",
      },
    },
    {
      value: "",
      deal_sheet_cost_data: {
        deal_sheet_category_id: "REIMBURSEMENT",
        deal_sheet_cost_duration_id: "WEEKLY",
      },
    },
  ];
  const out = computeBonusTotals(addCostRows, [], sampleHours);
  assert.equal(out.TOTAL_BONUS_TAXABLE, 0);
  assert.equal(out.TOTAL_BONUS_NON_TAXABLE, 0);
});

test("computeBonusTotals empty inputs yield zeros", () => {
  assert.deepEqual(computeBonusTotals([], [], sampleHours), {
    TOTAL_BONUS_TAXABLE: 0,
    TOTAL_BONUS_NON_TAXABLE: 0,
  });
  assert.deepEqual(computeBonusTotals(null, null, null), {
    TOTAL_BONUS_TAXABLE: 0,
    TOTAL_BONUS_NON_TAXABLE: 0,
  });
});

test("computeBonusTotals HOURLY bonus uses total_billable_hrs", () => {
  const addCostRows = [
    {
      value: 10,
      deal_sheet_cost_data: {
        deal_sheet_category_id: "BONUS",
        deal_sheet_cost_duration_id: "HOURLY",
      },
    },
  ];
  const out = computeBonusTotals(addCostRows, [], sampleHours);
  assert.equal(out.TOTAL_BONUS_TAXABLE, 4440);
  assert.equal(out.TOTAL_BONUS_NON_TAXABLE, 0);
});

test("computeBonusTotals client_cost ONE_TIME COST adds to non-taxable", () => {
  const clientCostRows = [
    {
      id: 84537,
      cost_name: "Pre-Employment Module Bonus",
      cost: 150.0,
      deal_sheet_category: "COST",
      duration: "ONE_TIME",
    },
  ];
  const out = computeBonusTotals([], [], sampleHours, clientCostRows);
  assert.equal(out.TOTAL_BONUS_TAXABLE, 0);
  assert.equal(out.TOTAL_BONUS_NON_TAXABLE, 150);
});

test("computeBonusTotals client_cost WEEKLY COST uses total_weeks multiplier", () => {
  const clientCostRows = [
    {
      cost: 75,
      deal_sheet_category: "COST",
      duration: "WEEKLY",
    },
  ];
  const out = computeBonusTotals([], [], sampleHours, clientCostRows);
  assert.equal(out.TOTAL_BONUS_TAXABLE, 0);
  assert.equal(out.TOTAL_BONUS_NON_TAXABLE, 975);
});

test("computeBonusTotals client_cost BONUS category still non-taxable", () => {
  const clientCostRows = [
    {
      cost: 500,
      deal_sheet_category: "BONUS",
      duration: "ONE_TIME",
    },
  ];
  const out = computeBonusTotals([], [], sampleHours, clientCostRows);
  assert.equal(out.TOTAL_BONUS_TAXABLE, 0);
  assert.equal(out.TOTAL_BONUS_NON_TAXABLE, 500);
});

test("computeBonusTotals mixed addcost travel and client_cost", () => {
  const addCostRows = [
    {
      value: 300,
      deal_sheet_cost_data: {
        deal_sheet_category_id: "BONUS",
        deal_sheet_cost_duration_id: "ONE_TIME",
      },
    },
  ];
  const travelRows = [{ total_amount: 200 }];
  const clientCostRows = [
    {
      cost: 150,
      deal_sheet_category: "COST",
      duration: "ONE_TIME",
    },
  ];
  const out = computeBonusTotals(addCostRows, travelRows, sampleHours, clientCostRows);
  assert.equal(out.TOTAL_BONUS_TAXABLE, 300);
  assert.equal(out.TOTAL_BONUS_NON_TAXABLE, 350);
});

test("computeBonusTotals client_cost null or blank cost contributes 0", () => {
  const clientCostRows = [
    { cost: null, deal_sheet_category: "COST", duration: "ONE_TIME" },
    { cost: "", deal_sheet_category: "COST", duration: "WEEKLY" },
  ];
  const out = computeBonusTotals([], [], sampleHours, clientCostRows);
  assert.equal(out.TOTAL_BONUS_TAXABLE, 0);
  assert.equal(out.TOTAL_BONUS_NON_TAXABLE, 0);
});
