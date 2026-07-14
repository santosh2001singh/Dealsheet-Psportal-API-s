const test = require("node:test");
const assert = require("node:assert/strict");

const { buildRateChangeLogRow } = require("./syncService");

test("buildRateChangeLogRow includes billable orientation snapshots", () => {
  const latest = {
    SKU_NUMBER: "SKU1",
    CONTRACT_ID: "CHC-1",
    CANDIDATE_NAME: "Test Candidate",
    RATE_CHANGE: "YES",
    PLACEMENT_STATUS: "ACTIVE",
    START_DATE: "2026-01-01",
    ASSIGNMENT_RECRUITER: "Recruiter",
    ASSIGNMENT_RECRUITER_EMAIL: "rec@cynethealth.com",
    ORIENTATION_HOURS: 16,
    BILLABLE_ORIENTATION_HRS: 24,
    BILLABLE_ORIENTATION: "70.00%",
    FINAL_BILL_RATE_NEW: 100,
    FINAL_COST_NEW: 80,
    PO_HOURS: 500,
    NEW_MARGIN: 20,
  };
  const previous = {
    ORIENTATION_HOURS: 16,
    BILLABLE_ORIENTATION_HRS: 0,
    BILLABLE_ORIENTATION: "0.00%",
    FINAL_BILL_RATE_NEW: 100,
    FINAL_COST_NEW: 80,
    PO_HOURS: 500,
    NEW_MARGIN: 20,
  };

  const row = buildRateChangeLogRow(latest, previous);

  assert.equal(row.NEW_BILLABLE_ORIENTATION_HRS, 24);
  assert.equal(row.NEW_BILLABLE_ORIENTATION, "70.00%");
  assert.equal(row.OLD_BILLABLE_ORIENTATION_HRS, 0);
  assert.equal(row.OLD_BILLABLE_ORIENTATION, "0.00%");
});

test("buildRateChangeLogRow recomputes NEW_GM_BASED_ON_NEW_LOADING_COST with sheet formula", () => {
  const latest = {
    CONTRACT_ID: "CHC-2",
    RATE_CHANGE: "YES",
    BILLABLE_ORIENTATION_HRS: 24,
    BILLABLE_ORIENTATION: "70.00%",
    FINAL_BILL_RATE_NEW: 100,
    FINAL_COST_NEW: 80,
    PO_HOURS: 500,
    NEW_MARGIN: 20,
  };

  const row = buildRateChangeLogRow(latest, null);

  assert.ok(Math.abs(row.NEW_GM_BASED_ON_NEW_LOADING_COST - 18.56) < 1e-9);
  assert.notEqual(row.NEW_GM_BASED_ON_NEW_LOADING_COST, 20);
});

test("buildRateChangeLogRow uses simple margin when billable orientation hrs is zero", () => {
  const latest = {
    CONTRACT_ID: "CHC-3",
    RATE_CHANGE: "YES",
    BILLABLE_ORIENTATION_HRS: 0,
    BILLABLE_ORIENTATION: "70.00%",
    FINAL_BILL_RATE_NEW: 100,
    FINAL_COST_NEW: 80,
    PO_HOURS: 500,
  };

  const row = buildRateChangeLogRow(latest, null);
  assert.equal(row.NEW_GM_BASED_ON_NEW_LOADING_COST, 20);
});
