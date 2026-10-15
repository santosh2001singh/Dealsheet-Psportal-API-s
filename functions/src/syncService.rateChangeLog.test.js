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

// --- Oct 2026: every deal-sheet rate column is snapshotted, under the log table's own names ---------

const { extractRateSnapshotFields } = require("./syncService");
const {
  placementVersionRateFieldsDiffer,
  contractSegmentRateFieldsDiffer,
  fetchPlacementVersionRateChangePairsFromActive,
  RATE_LOG_ADDED_COMPARE_FIELDS,
} = require("./bigQueryClient");

const ADDED_SNAPSHOT_COLUMNS = [
  "OT_RATE", "HOLIDAY_RATE", "CALL_BACK_RATE", "ON_CALL_RATE",
  "CLIENT_OT_RATE", "CLIENT_HOLIDAY_RATE", "CLIENT_CALL_BACK_RATE", "CLIENT_ON_CALL_RATE",
  "W2_PAY_RATE_NEW", "FINAL_PAY_RATE_NEW", "FINAL_BILL_RATE_NEW", "FINAL_COST_NEW",
  "MARGIN", "CALCULATED_MARGIN", "GM_OT", "GP_PERCENTAGE",
  "TOTAL_BONUS_TAXABLE", "TOTAL_BONUS_NON_TAXABLE", "WEEKLY_WALLET_MONEY",
];

test("snapshot carries every added rate column as OLD_/NEW_ with the deal sheet's value", () => {
  const row = Object.fromEntries(ADDED_SNAPSHOT_COLUMNS.map((c, i) => [c, String(i + 1.5)]));
  const snap = extractRateSnapshotFields(row, "NEW_");
  ADDED_SNAPSHOT_COLUMNS.forEach((c, i) => assert.equal(snap[`NEW_${c}`], i + 1.5, c));
  const empty = extractRateSnapshotFields(null, "OLD_");
  for (const c of ADDED_SNAPSHOT_COLUMNS) assert.equal(empty[`OLD_${c}`], null, c);
});

test("snapshot keys use the deal sheet's names: duration, NBO hours and gross margin land", () => {
  const snap = extractRateSnapshotFields({ PROJECT_DURATION: 13, NBO_HOURS: 8, GROSS_MARGIN: 7.93 }, "OLD_");
  assert.equal(snap.OLD_PROJECT_DURATION, 13);
  assert.equal(snap.OLD_NBO_HOURS, 8);
  assert.equal(snap.OLD_GROSS_MARGIN, 7.93);
  for (const renamed of ["OLD_INITIAL_PROJECT_DURATION_IN_WEEKS", "OLD_ORIENTATION_HOURS"]) {
    assert.ok(!(renamed in snap), renamed);
  }
});

test("GM_DIFFERENCE is NEW - OLD gross margin", () => {
  const row = buildRateChangeLogRow({ CONTRACT_ID: "CHC1", GROSS_MARGIN: 9 }, { GROSS_MARGIN: 7.5 });
  assert.equal(row.GM_DIFFERENCE, 1.5);
});

test("placement version: any tracked rate change creates a pair, RATE_CHANGE flag or not", () => {
  const prev = { BILL_RATE: 57, OT_RATE: 26, GM_OT: 26.1, RATE_CHANGE: "NO" };
  assert.equal(placementVersionRateFieldsDiffer({ ...prev }, prev), false);
  assert.equal(placementVersionRateFieldsDiffer({ ...prev, OT_RATE: 30 }, prev), true);
  assert.equal(placementVersionRateFieldsDiffer({ ...prev, BILL_RATE: 60 }, prev), true);
  assert.equal(placementVersionRateFieldsDiffer({ ...prev, GM_OT: "27.0" }, prev), true);
});

test("placement version: a first fill or a blanked value is not a rate change", () => {
  assert.equal(placementVersionRateFieldsDiffer({ GP_PERCENTAGE: 10.37 }, { GP_PERCENTAGE: null }), false);
  assert.equal(placementVersionRateFieldsDiffer({ GP_PERCENTAGE: null }, { GP_PERCENTAGE: 10.37 }), false);
  assert.equal(placementVersionRateFieldsDiffer({ OT_RATE: "26.0" }, { OT_RATE: 26 }), false);
});

test("contract segment: added columns trigger too, but only when both placements have a value", () => {
  assert.equal(contractSegmentRateFieldsDiffer({ CLIENT_OT_RATE: 60 }, { CLIENT_OT_RATE: 57 }), true);
  assert.equal(contractSegmentRateFieldsDiffer({ CLIENT_OT_RATE: 60 }, { CLIENT_OT_RATE: null }), false);
  assert.equal(RATE_LOG_ADDED_COMPARE_FIELDS.includes("MARGIN"), false, "MARGIN was already compared");
});

test("fetchPlacementVersionRateChangePairsFromActive pairs rn 1/2 per placement and keeps only changes", async () => {
  const rows = [
    { CONTRACT_ID: "chc1", PLACEMENT_ID: 10, rn: 1, OT_RATE: 30, _src: "t" },
    { CONTRACT_ID: "CHC1", PLACEMENT_ID: 10, rn: 2, OT_RATE: 26, _src: "t" },
    { CONTRACT_ID: "CHC2", PLACEMENT_ID: 20, rn: 1, OT_RATE: 26 },
    { CONTRACT_ID: "CHC2", PLACEMENT_ID: 20, rn: 2, OT_RATE: 26 },
    { CONTRACT_ID: "CHC3", PLACEMENT_ID: 30, rn: 1, OT_RATE: 26 },
  ];
  let seenSql = "";
  const out = await fetchPlacementVersionRateChangePairsFromActive(
    { datasetId: "ds" },
    {
      buildUnionParts: async () => ["SELECT 1"],
      queryFn: async (sql) => { seenSql = sql; return rows; },
    }
  );
  assert.match(seenSql, /rn <= 2/);
  assert.deepEqual([...out.keys()], ["CHC1|10"]);
  assert.equal(out.get("CHC1|10").latest.OT_RATE, 30);
  assert.equal(out.get("CHC1|10").previous.OT_RATE, 26);
  assert.ok(!("_src" in out.get("CHC1|10").latest));
});

test("log row uses the deal sheet's own column names everywhere", () => {
  const latest = {
    CONTRACT_ID: "CHC1",
    ASSIGNMENT_RECRUITER: "Sid Kumar (R4A)",
    ASSIGNMENT_RECRUITER_EMAIL: "sid.k@cynethealth.com",
    MSP_NAME: "Direct",
    ONSITE_AM: "Julianna Shilliday",
    SCHEDULE_HOURS_1: 36,
    WEEKLY_PER_DIEM_NON_TAXED: 1074,
  };
  const row = buildRateChangeLogRow(latest, { SCHEDULE_HOURS_1: 40, WEEKLY_PER_DIEM_NON_TAXED: 1000 });
  assert.equal(row.ASSIGNMENT_RECRUITER, "Sid Kumar (R4A)");
  assert.equal(row.ASSIGNMENT_RECRUITER_EMAIL, "sid.k@cynethealth.com");
  assert.equal(row.MSP_NAME, "Direct");
  assert.equal(row.ONSITE_AM, "Julianna Shilliday");
  assert.equal(row.NEW_SCHEDULE_HOURS_1, 36);
  assert.equal(row.OLD_SCHEDULE_HOURS_1, 40);
  assert.equal(row.NEW_WEEKLY_PER_DIEM_NON_TAXED, 1074);
  assert.equal(row.OLD_WEEKLY_PER_DIEM_NON_TAXED, 1000);
  for (const old of [
    "RECRUITER", "RECRUITER_EMAIL_ID", "MSP", "ONSITE_MANAGER",
    "NEW_GUARANTEED_HOURS", "NEW_WEEKLY_PER_DIEM", "NEW_INITIAL_PROJECT_DURATION_IN_WEEKS", "NEW_ORIENTATION_HOURS",
  ]) {
    assert.ok(!(old in row), old);
  }
});

test("SCHEDULE_HOURS_1 change triggers a log only when both versions have hours", () => {
  assert.equal(placementVersionRateFieldsDiffer({ SCHEDULE_HOURS_1: 48 }, { SCHEDULE_HOURS_1: 36 }), true);
  assert.equal(contractSegmentRateFieldsDiffer({ SCHEDULE_HOURS_1: 48 }, { SCHEDULE_HOURS_1: null }), false);
});

test("buildRateChangeLogRow carries the NEW snapshot's PLACEMENT_ID as INT64", () => {
  assert.equal(buildRateChangeLogRow({ PLACEMENT_ID: 1470999, CONTRACT_ID: "CHC1" }, {}).PLACEMENT_ID, 1470999);
  assert.equal(buildRateChangeLogRow({ PLACEMENT_ID: " 1470999 " }, {}).PLACEMENT_ID, 1470999);
  assert.equal(buildRateChangeLogRow({ PLACEMENT_ID: { value: "1470999" } }, {}).PLACEMENT_ID, 1470999);
  assert.equal(buildRateChangeLogRow({}, {}).PLACEMENT_ID, null);
  // Contract segment: the log belongs to the newer placement, not the one before it.
  const seg = buildContractSegmentRateChangeLogRow(
    { PLACEMENT_ID: 2000002, CONTRACT_ID: "CHC1" },
    { PLACEMENT_ID: 2000001, CONTRACT_ID: "CHC1", END_DATE: "2026-08-22" }
  );
  assert.equal(seg.PLACEMENT_ID, 2000002);
});

test("rate log numbers are stored to 3 decimals (no float noise)", () => {
  // Lisa Miller, CHC23497: 2.8900000000000006 / 3.120000000000001 / 6.859999999999999 before.
  const row = buildRateChangeLogRow(
    { GROSS_MARGIN: 22.88, NET_MARGIN: 15.41, BILL_RATE: 116.25, FINAL_PAY_RATE: 93.3749 },
    { GROSS_MARGIN: 19.99, NET_MARGIN: 12.29, BILL_RATE: 116.25, FINAL_PAY_RATE: 96.26 }
  );
  assert.equal(row.GM_DIFFERENCE, 2.89);
  assert.equal(row.PROFIT_DIFFERENCE, 3.12);
  assert.equal(row.BR_DIFFERENCE, 0);
  assert.equal(row.NEW_FINAL_PAY_RATE, 93.375);
  assert.equal(row.OLD_FINAL_PAY_RATE, 96.26);
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "number") assert.equal(value, Math.round(value * 1000) / 1000, key);
  }
  // Small negatives keep their sign; tiny noise rounds to a clean 0.
  assert.equal(buildRateChangeLogRow({ GROSS_MARGIN: 6.66 }, { GROSS_MARGIN: 6.67 }).GM_DIFFERENCE, -0.01);
  assert.equal(buildRateChangeLogRow({ NET_MARGIN: 1e-12 }, { NET_MARGIN: 0 }).PROFIT_DIFFERENCE, 0);
});
