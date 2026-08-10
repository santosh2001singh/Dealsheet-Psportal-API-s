const test = require("node:test");
const assert = require("node:assert/strict");

const { buildRateChangeLogRow, buildContractSegmentRateChangeLogRow } = require("./syncService");

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
    NBO_HOURS: 16,
    BILLABLE_ORIENTATION_HRS: 24,
    BILLABLE_ORIENTATION: "70.00%",
    FINAL_BILL_RATE_NEW: 100,
    FINAL_COST_NEW: 80,
    PO_HOURS: 500,
    CALCULATED_MARGIN: 20,
  };
  const previous = {
    NBO_HOURS: 16,
    BILLABLE_ORIENTATION_HRS: 0,
    BILLABLE_ORIENTATION: "0.00%",
    FINAL_BILL_RATE_NEW: 100,
    FINAL_COST_NEW: 80,
    PO_HOURS: 500,
    CALCULATED_MARGIN: 20,
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
    CALCULATED_MARGIN: 20,
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

test("buildContractSegmentRateChangeLogRow: effective date is prev END + 1", () => {
  const previous = {
    CONTRACT_ID: "CHC1284",
    END_DATE: "2026-08-01",
    TENTATIVE_END_DATE: "2026-08-01",
    BILL_RATE: 80,
    FINAL_BILL_RATE: 75.0,
    LAST_UPDATED: "2026-07-30T14:00:00.000Z",
  };
  const latest = {
    CONTRACT_ID: "CHC1284",
    START_DATE: "2026-08-02",
    BILL_RATE: 80,
    FINAL_BILL_RATE: 75.0,
    ADDITIONAL_BONUS: 300,
    RATE_CHANGE: "NO",
    LAST_UPDATED: "2026-08-03T14:07:53.000Z",
  };
  const row = buildContractSegmentRateChangeLogRow(latest, previous);
  assert.equal(row.RATE_CHANGE, "YES");
  assert.equal(row.CONTRACT_ID, "CHC1284");
  assert.equal(row.RATE_CHANGE_EFFECTIVE_DATE, "2026-08-02");
  assert.equal(row.OLD_ADDITIONAL_BONUS, null);
  assert.equal(row.NEW_ADDITIONAL_BONUS, 300);
});

test("buildContractSegmentRateChangeLogRow: falls back to TENTATIVE + 1 when END null", () => {
  const previous = {
    CONTRACT_ID: "CHC1",
    END_DATE: null,
    TENTATIVE_END_DATE: "2026-04-04",
    BILL_RATE: 80,
  };
  const latest = {
    CONTRACT_ID: "CHC1",
    BILL_RATE: 85,
    LAST_UPDATED: "2026-05-01T00:00:00.000Z",
  };
  const row = buildContractSegmentRateChangeLogRow(latest, previous);
  assert.equal(row.RATE_CHANGE_EFFECTIVE_DATE, "2026-04-05");
});

test("buildContractSegmentRateChangeLogRow: no rate diff still builds when called (caller filters)", () => {
  const previous = { CONTRACT_ID: "CHC1", END_DATE: "2026-01-01", BILL_RATE: 80 };
  const latest = { CONTRACT_ID: "CHC1", BILL_RATE: 80, LAST_UPDATED: "2026-02-01T00:00:00.000Z" };
  const row = buildContractSegmentRateChangeLogRow(latest, previous);
  assert.equal(row.RATE_CHANGE_EFFECTIVE_DATE, "2026-01-02");
  assert.equal(row.OLD_BILL_RATE, 80);
  assert.equal(row.NEW_BILL_RATE, 80);
});
