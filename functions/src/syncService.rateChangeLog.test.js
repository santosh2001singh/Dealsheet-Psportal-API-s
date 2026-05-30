const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildRateChangeLogRow } = require("./syncService");

function baseDealSheetRow(overrides = {}) {
  return {
    DEAL_SHEET_ID: 5208042,
    PLACEMENT_ID: 1311759,
    CONTRACT_ID: 9001,
    CANDIDATE_NAME: "Jane Doe",
    PLACEMENT_STATUS: "ACTIVE",
    START_DATE: "2026-04-01",
    END_DATE: "2026-10-01",
    SKU_NUMBER: "SKU-1",
    ASSIGNMENT_RECRUITER: "Recruiter A",
    ASSIGNMENT_RECRUITER_EMAIL: "recruiter@example.com",
    ACCOUNT_MANAGER: "AM One",
    SECONDARY_AM: "SAM",
    ASSOCIATE_AM: "AAM",
    RM: "RM1",
    TEAM_LEAD: "TL1",
    ATL: "ATL1",
    MSP_NAME: "MSP Co",
    END_CLIENT_DEPT_FACILITY: "Hospital / ER",
    DELIVERY_POC: "Delivery POC",
    ONSITE_AM: "Onsite Manager",
    CLIENT_STATE: "TX",
    DATE_AND_TIME: { value: "2026-05-29T12:00:00.000Z" },
    GUARANTEED_HOURS: 36,
    INITIAL_PROJECT_DURATION_IN_WEEKS: 13,
    ORIENTATION_HOURS: 16,
    ADDITIONAL_BONUS: 100,
    PAY_RATE: 85,
    WEEKLY_PER_DIEM_NON_TAXED: 1900,
    W2_PAY_RATE: 150,
    FINAL_PAY_RATE: 151,
    FINAL_COST: 163,
    BILL_RATE: 175,
    FINAL_BILL_RATE: 175,
    NET_MARGIN: 12,
    GROSS_MARGIN: 24,
    CLIENT_MSP_FEE: 4.5,
    NEW_MARGIN: 23.5,
    ...overrides,
  };
}

test("buildRateChangeLogRow maps NEW_* from latest and OLD_* from previous", () => {
  const latest = baseDealSheetRow({
    GROSS_MARGIN: 30,
    NET_MARGIN: 15,
    BILL_RATE: 180,
    NEW_MARGIN: 28,
  });
  const previous = baseDealSheetRow({
    GROSS_MARGIN: 24,
    NET_MARGIN: 12,
    BILL_RATE: 175,
    NEW_MARGIN: 23.5,
    GUARANTEED_HOURS: 40,
    WEEKLY_PER_DIEM_NON_TAXED: 1666,
  });

  const log = buildRateChangeLogRow(latest, previous);

  assert.equal(log.RATE_CHANGE, "YES");
  assert.equal(log.CONTRACT_ID, 9001);
  assert.equal(log.RATE_CHANGE_EFFECTIVE_DATE, "2026-05-29");
  assert.equal(log.RECRUITER, "Recruiter A");
  assert.equal(log.MSP, "MSP Co");
  assert.equal(log.ONSITE_MANAGER, "Onsite Manager");

  assert.equal(log.OLD_GUARANTEED_HOURS, 40);
  assert.equal(log.OLD_WEEKLY_PER_DIEM, 1666);
  assert.equal(log.OLD_GM_BASED_ON_NEW_LOADING_COST, 23.5);
  assert.equal(log.NEW_GUARANTEED_HOURS, 36);
  assert.equal(log.NEW_WEEKLY_PER_DIEM, 1900);
  assert.equal(log.NEW_GM_BASED_ON_NEW_LOADING_COST, 28);

  assert.equal(log.GM_DIFFERENCE, 6);
  assert.equal(log.BR_DIFFERENCE, 5);
  assert.equal(log.PROFIT_DIFFERENCE, 3);
});

test("buildRateChangeLogRow with null previous leaves OLD_* and diffs null", () => {
  const latest = baseDealSheetRow();
  const log = buildRateChangeLogRow(latest, null);

  assert.equal(log.OLD_GROSS_MARGIN, null);
  assert.equal(log.OLD_BILL_RATE, null);
  assert.equal(log.GM_DIFFERENCE, null);
  assert.equal(log.BR_DIFFERENCE, null);
  assert.equal(log.PROFIT_DIFFERENCE, null);
  assert.equal(log.NEW_GROSS_MARGIN, 24);
  assert.equal(log.NEW_BILL_RATE, 175);
});
