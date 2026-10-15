const test = require("node:test");
const assert = require("node:assert/strict");

const config = require("./config");
const {
  buildOwnershipChangeLogRowsFromVersions,
  buildConsecutiveContractPlacementPairs,
  contractSegmentRateFieldsDiffer,
  applyPreviousRecruiterOnRecruiterChange,
  insertOwnershipChangeLogBatch,
} = require("./bigQueryClient");

// These fixtures predate the data-team cutoff; the cutoff has its own tests
// (ownershipChangeLogRules.test.js "data team cutoff").
config.ownershipLogDataTeamCutoff = "2000-01-01T00:00:00Z";

function baseRow(overrides) {
  return {
    DEAL_SHEET_ID: 10,
    PLACEMENT_ID: 100,
    CONTRACT_ID: "CHC1234",
    CANDIDATE_NAME: "Jane Candidate",
    CANDIDATE_EMAIL: "jane@x.com",
    PLACEMENT_STATUS: "STARTED",
    START_DATE: "2026-05-01",
    TENTATIVE_END_DATE: "2026-05-15",
    LAST_UPDATED: "2026-05-05T00:00:00Z",
    ASSIGNMENT_RECRUITER: "Old Rec",
    ASSIGNMENT_RECRUITER_EMAIL: "old.rec@cynethealth.com",
    RECRUITER_EMP_NO: "CY100",
    ONSITE_AM: "Onsite One",
    ONSITE_AM_EMAIL: "onsite.one@cynethealth.com",
    LEVEL_2_CSM: "Csm Two",
    LEVEL_3_CSM: "Csm Three",
    LEVEL_4_CSM: "Csm Four",
    ...overrides,
  };
}

/** Two versions of one running placement: the change happened mid-placement. */
function rowsForChange(previousOverrides, latestOverrides) {
  const previous = baseRow(previousOverrides);
  const latest = baseRow({ ...previousOverrides, LAST_UPDATED: "2026-05-06T00:00:00Z", ...latestOverrides });
  return buildOwnershipChangeLogRowsFromVersions([previous, latest], { nowIso: "2026-05-06T01:00:00Z" });
}

test("recruiter change mid-placement -> single RECRUITER row with owners + TENTATIVE_END_DATE + 1", () => {
  const rows = rowsForChange({}, {
    ASSIGNMENT_RECRUITER: "New Rec",
    ASSIGNMENT_RECRUITER_EMAIL: "new.rec@cynethealth.com",
    RECRUITER_EMP_NO: "CY200",
  });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.OWNERSHIP_ROLE, "RECRUITER");
  assert.equal(r.NEW_OWNER_NAME, "New Rec");
  assert.equal(r.NEW_OWNER_EMP_NO, "CY200");
  assert.equal(r.PREVIOUS_OWNER_NAME, "Old Rec");
  assert.equal(r.PREVIOUS_OWNER_EMP_NO, "CY100");
  assert.equal(r.PLACEMENT_ID, "100");
  assert.equal(r.CONTRACT_ID, "CHC1234");
  assert.equal(r.END_DATE_PREVIOUS_OWNER, "2026-05-15");
  assert.equal(r.OWNERSHIP_EFFECTIVE_DATE, "2026-05-16"); // tentative + 1
  assert.equal(r.EFFECTIVE_DATE_SOURCE, "TENTATIVE_PLUS_1");
  assert.equal(r.EFFECTIVE_DATE_PLACEMENT_ID, "100");
  assert.equal(r.SKU_NO, null);
  assert.equal(r.CHANGE_REASON_NOTES, null);
  assert.equal(r.EDITED_BY, null);
});

test("RM became recruiter -> 2 rows (RECRUITER assign + RM vacated NA)", () => {
  // Previous version: xyz (CY200) is the RM. Recruiter is Old Rec (CY100).
  const rows = rowsForChange({ RM: "Xyz Person", RM_EMP_NO: "CY200" }, {
    ASSIGNMENT_RECRUITER: "Xyz Person",
    ASSIGNMENT_RECRUITER_EMAIL: "xyz@cynethealth.com",
    RECRUITER_EMP_NO: "CY200",
  });
  assert.equal(rows.length, 2);

  const recruiterRow = rows.find((r) => r.OWNERSHIP_ROLE === "RECRUITER");
  assert.equal(recruiterRow.NEW_OWNER_NAME, "Xyz Person");
  assert.equal(recruiterRow.NEW_OWNER_EMP_NO, "CY200");
  assert.equal(recruiterRow.PREVIOUS_OWNER_NAME, "Old Rec");
  assert.equal(recruiterRow.PREVIOUS_OWNER_EMP_NO, "CY100");

  const rmRow = rows.find((r) => r.OWNERSHIP_ROLE === "RM");
  assert.equal(rmRow.NEW_OWNER_NAME, "NA");
  assert.equal(rmRow.NEW_OWNER_EMP_NO, "NA");
  assert.equal(rmRow.PREVIOUS_OWNER_NAME, "Xyz Person");
  assert.equal(rmRow.PREVIOUS_OWNER_EMP_NO, "CY200");
});

test("onsite AM change -> ONSITE_AM row, emp no null", () => {
  const rows = rowsForChange({}, { ONSITE_AM: "Onsite Two", ONSITE_AM_EMAIL: "onsite.two@cynethealth.com" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].OWNERSHIP_ROLE, "ONSITE_AM");
  assert.equal(rows[0].NEW_OWNER_NAME, "Onsite Two");
  assert.equal(rows[0].NEW_OWNER_EMP_NO, null);
  assert.equal(rows[0].PREVIOUS_OWNER_NAME, "Onsite One");
  assert.equal(rows[0].PREVIOUS_OWNER_EMP_NO, null);
});

test("multiple CSM levels change -> one row each", () => {
  const rows = rowsForChange({}, { LEVEL_2_CSM: "Csm Two New", LEVEL_4_CSM: "Csm Four New" });
  assert.deepEqual(rows.map((r) => r.OWNERSHIP_ROLE).sort(), ["LEVEL_2_CSM", "LEVEL_4_CSM"]);
  const l2 = rows.find((r) => r.OWNERSHIP_ROLE === "LEVEL_2_CSM");
  assert.equal(l2.NEW_OWNER_NAME, "Csm Two New");
  assert.equal(l2.PREVIOUS_OWNER_NAME, "Csm Two");
});

test("no change -> empty", () => {
  assert.deepEqual(rowsForChange({}, {}), []);
});

test("case-only recruiter email difference is not a change", () => {
  assert.deepEqual(rowsForChange({}, { ASSIGNMENT_RECRUITER_EMAIL: "Old.Rec@CynetHealth.com" }), []);
});

test("pure removal (latest blank) is not logged", () => {
  assert.deepEqual(rowsForChange({}, { ONSITE_AM: null, ONSITE_AM_EMAIL: null }), []);
});

// ---------------------------------------------------------------------------------------------
// insertOwnershipChangeLogBatch: switch, dedupe against the table, target table
// ---------------------------------------------------------------------------------------------

async function withWrites(enabled, fn) {
  const before = config.ownershipLogWritesEnabled;
  config.ownershipLogWritesEnabled = enabled;
  try {
    return await fn();
  } finally {
    config.ownershipLogWritesEnabled = before;
  }
}

const candidate = (overrides = {}) => ({
  CONTRACT_ID: "CHC12569",
  SKU_NO: "H9198",
  PLACEMENT_ID: "1466112",
  OWNERSHIP_ROLE: "ONSITE_AM",
  PREVIOUS_OWNER_NAME: "Elisa An",
  PREVIOUS_OWNER_EMP_NO: null,
  NEW_OWNER_NAME: "Jessica Van Essen",
  NEW_OWNER_EMP_NO: null,
  ...overrides,
});

test("insertOwnershipChangeLogBatch: does nothing while OWNERSHIP_LOG_WRITES_ENABLED is off", async () => {
  let queried = false;
  let inserted = false;
  const result = await withWrites(false, () =>
    insertOwnershipChangeLogBatch([candidate()], 0, {}, {
      queryFn: async () => { queried = true; return []; },
      insertAllFn: async () => { inserted = true; return { inserted: 1, attempted: 1, errors: [] }; },
    })
  );
  assert.equal(result.disabled, true);
  assert.equal(result.inserted, 0);
  assert.equal(queried, false);
  assert.equal(inserted, false);
});

test("insertOwnershipChangeLogBatch: a change the data team already has (by SKU) is skipped", async () => {
  const sqls = [];
  let insertedRows = null;
  const result = await withWrites(true, () =>
    insertOwnershipChangeLogBatch([candidate(), candidate({ OWNERSHIP_ROLE: "RECRUITER", PREVIOUS_OWNER_NAME: "A", NEW_OWNER_NAME: "B" })], 0, {}, {
      queryFn: async (sql) => {
        sqls.push(sql);
        // Data team row: SKU only, "NA"-free names, no emp nos.
        return sql.includes("TRIM(SKU_NO))") ? [{ SKU_NO: "H9198", CONTRACT_ID: null, OWNERSHIP_ROLE: "ONSITE_AM", PREVIOUS_OWNER_NAME: "Elisa An", NEW_OWNER_NAME: "Jessica Van Essen" }] : [];
      },
      insertAllFn: async (rows) => { insertedRows = rows; return { inserted: rows.length, attempted: rows.length, errors: [] }; },
    })
  );
  assert.equal(result.skippedExisting, 1);
  assert.equal(result.inserted, 1);
  assert.deepEqual(insertedRows.map((r) => r.OWNERSHIP_ROLE), ["RECRUITER"]);
  assert.ok(insertedRows[0].ID, "an ID is assigned");
  assert.equal(sqls.length, 2, "one lookup by CONTRACT_ID, one by SKU_NO");
});

test("insertOwnershipChangeLogBatch: reads and writes the ownership log table, never the deal sheet", async () => {
  // The old insert-time path passed no table and fell back to config.tableId (the deal sheet).
  const sqls = [];
  let target = null;
  await withWrites(true, () =>
    insertOwnershipChangeLogBatch([candidate()], 0, { datasetId: undefined, tableId: undefined }, {
      queryFn: async (sql) => { sqls.push(sql); return []; },
      insertAllFn: async (rows, opts) => { target = opts; return { inserted: rows.length, attempted: rows.length, errors: [] }; },
    })
  );
  assert.equal(target.tableId, config.ownershipChangeLogTableId);
  assert.equal(target.datasetId, config.ownershipChangeLogDatasetId);
  for (const sql of sqls) assert.ok(sql.includes(`.${config.ownershipChangeLogTableId}\``), sql);
});


test("applyPreviousRecruiterOnRecruiterChange: captures outgoing recruiter on temp fields when email changed", () => {
  const incoming = { ASSIGNMENT_RECRUITER_EMAIL: "new@cynethealth.com" };
  const baseline = {
    ASSIGNMENT_RECRUITER: "Old Rec",
    ASSIGNMENT_RECRUITER_EMAIL: "old@cynethealth.com",
    RECRUITER_EMP_NO: "CY100",
  };
  const { row, changed } = applyPreviousRecruiterOnRecruiterChange(incoming, baseline);
  assert.equal(changed, true);
  // In-memory only — PREVIOUS_RECRUITER_* is no longer written to the deal sheet.
  assert.equal(row.__PREV_RECRUITER_NAME, "Old Rec");
  assert.equal(row.__PREV_RECRUITER_EMAIL, "old@cynethealth.com");
  assert.equal(row.__PREV_RECRUITER_EMP_NO, "CY100");
  assert.equal(row.PREVIOUS_RECRUITER_NAME, undefined);
  assert.equal(row.PREVIOUS_RECRUITER_EMAIL, undefined);
});

test("applyPreviousRecruiterOnRecruiterChange: no-op when recruiter unchanged (case-insensitive)", () => {
  const incoming = { ASSIGNMENT_RECRUITER_EMAIL: "Same@CynetHealth.com" };
  const baseline = { ASSIGNMENT_RECRUITER_EMAIL: "same@cynethealth.com", ASSIGNMENT_RECRUITER: "Same Rec" };
  const { row, changed } = applyPreviousRecruiterOnRecruiterChange(incoming, baseline);
  assert.equal(changed, false);
  assert.equal(row.__PREV_RECRUITER_NAME, undefined);
});

test("applyPreviousRecruiterOnRecruiterChange: no-op when baseline recruiter email is blank", () => {
  const incoming = { ASSIGNMENT_RECRUITER_EMAIL: "new@cynethealth.com" };
  const baseline = { ASSIGNMENT_RECRUITER_EMAIL: "" };
  const { changed } = applyPreviousRecruiterOnRecruiterChange(incoming, baseline);
  assert.equal(changed, false);
});

test("applyPreviousRecruiterOnRecruiterChange: vacates the hierarchy role the NEW recruiter used to hold (TEAM_LEAD -> NA), matched by emp-no on baseline", () => {
  // Baseline: XYZ is the recruiter; Rohit (CY777) is the TEAM_LEAD.
  const baseline = {
    ASSIGNMENT_RECRUITER: "XYZ",
    ASSIGNMENT_RECRUITER_EMAIL: "xyz@cynethealth.com",
    RECRUITER_EMP_NO: "CY100",
    TEAM_LEAD: "Rohit",
    TEAM_LEAD_EMP_NO: "CY777",
    RM: "Alex",
    RM_EMP_NO: "CY888",
  };
  // Incoming: Rohit (CY777) is now the recruiter; hierarchy carried forward from baseline.
  const incoming = {
    ASSIGNMENT_RECRUITER: "Rohit",
    ASSIGNMENT_RECRUITER_EMAIL: "rohit@cynethealth.com",
    RECRUITER_EMP_NO: "CY777",
    TENTATIVE_END_DATE: "2026-05-15",
    TEAM_LEAD: "Rohit",
    TEAM_LEAD_EMP_NO: "CY777",
    RM: "Alex",
    RM_EMP_NO: "CY888",
  };
  const { row, changed } = applyPreviousRecruiterOnRecruiterChange(incoming, baseline);
  assert.equal(changed, true);
  // Recruiter handover captured in memory (feeds the ownership log, not the deal sheet)
  assert.equal(row.__PREV_RECRUITER_NAME, "XYZ");
  assert.equal(row.__PREV_RECRUITER_EMP_NO, "CY100");
  assert.equal(row.OWNERSHIP_EFFECTIVE_DATE, "2026-05-16"); // tentative + 1
  // TEAM_LEAD vacated because Rohit (CY777) is now the recruiter
  assert.equal(row.TEAM_LEAD, "NA");
  assert.equal(row.TEAM_LEAD_EMP_NO, "NA");
  // RM (Alex, CY888) untouched — a different person
  assert.equal(row.RM, "Alex");
  assert.equal(row.RM_EMP_NO, "CY888");
});

test("applyPreviousRecruiterOnRecruiterChange: no hierarchy vacated when the new recruiter held no role on baseline", () => {
  const baseline = {
    ASSIGNMENT_RECRUITER_EMAIL: "xyz@cynethealth.com",
    RECRUITER_EMP_NO: "CY100",
    TEAM_LEAD: "Rohit",
    TEAM_LEAD_EMP_NO: "CY777",
  };
  const incoming = {
    ASSIGNMENT_RECRUITER_EMAIL: "brandnew@cynethealth.com",
    RECRUITER_EMP_NO: "CY999", // matches no baseline hierarchy emp-no
    TENTATIVE_END_DATE: "2026-05-15",
    TEAM_LEAD: "Rohit",
    TEAM_LEAD_EMP_NO: "CY777",
  };
  const { row } = applyPreviousRecruiterOnRecruiterChange(incoming, baseline);
  assert.equal(row.TEAM_LEAD, "Rohit");
  assert.equal(row.TEAM_LEAD_EMP_NO, "CY777");
});

test("applyPreviousRecruiterOnRecruiterChange: emp-no match is trim/case-insensitive", () => {
  const baseline = {
    ASSIGNMENT_RECRUITER_EMAIL: "xyz@cynethealth.com",
    RECRUITER_EMP_NO: "CY100",
    ACCOUNT_MANAGER: "Rohit",
    ACCOUNT_MANAGER_EMP_NO: " cy777 ",
  };
  const incoming = {
    ASSIGNMENT_RECRUITER_EMAIL: "rohit@cynethealth.com",
    RECRUITER_EMP_NO: "CY777",
    TENTATIVE_END_DATE: "2026-05-15",
    ACCOUNT_MANAGER: "Rohit",
    ACCOUNT_MANAGER_EMP_NO: " cy777 ",
  };
  const { row } = applyPreviousRecruiterOnRecruiterChange(incoming, baseline);
  assert.equal(row.ACCOUNT_MANAGER, "NA");
  assert.equal(row.ACCOUNT_MANAGER_EMP_NO, "NA");
});

test("applyPreviousRecruiterOnRecruiterChange: does NOT vacate SECONDARY_RECRUITER even when new recruiter emp matches", () => {
  const baseline = {
    ASSIGNMENT_RECRUITER: "XYZ",
    ASSIGNMENT_RECRUITER_EMAIL: "xyz@cynethealth.com",
    RECRUITER_EMP_NO: "CY100",
    SECONDARY_RECRUITER: "Rohit",
    SECONDARY_RECRUITER_EMP_NO: "CY777",
    TEAM_LEAD: "Rohit",
    TEAM_LEAD_EMP_NO: "CY777",
  };
  const incoming = {
    ASSIGNMENT_RECRUITER: "Rohit",
    ASSIGNMENT_RECRUITER_EMAIL: "rohit@cynethealth.com",
    RECRUITER_EMP_NO: "CY777",
    TENTATIVE_END_DATE: "2026-05-15",
    SECONDARY_RECRUITER: "Rohit",
    SECONDARY_RECRUITER_EMP_NO: "CY777",
    TEAM_LEAD: "Rohit",
    TEAM_LEAD_EMP_NO: "CY777",
  };
  const { row, changed } = applyPreviousRecruiterOnRecruiterChange(incoming, baseline);
  assert.equal(changed, true);
  assert.equal(row.SECONDARY_RECRUITER, "Rohit");
  assert.equal(row.SECONDARY_RECRUITER_EMP_NO, "CY777");
  // Other hierarchy roles still vacate
  assert.equal(row.TEAM_LEAD, "NA");
  assert.equal(row.TEAM_LEAD_EMP_NO, "NA");
});

test("contract chain: a new extension with a new onsite AM is effective from its START_DATE", () => {
  // Rosalia-style: Stephanie ends 2026-08-01, Vish starts 2026-08-02 on the next extension.
  const previous = baseRow({
    PLACEMENT_ID: 1449593,
    CONTRACT_ID: "CHC1284",
    PLACEMENT_STATUS: "ENDED",
    ONSITE_AM: "Stephanie Marzan",
    ONSITE_AM_EMAIL: "stephanie.m2@cynethealth.com",
    START_DATE: "2026-05-03",
    END_DATE: "2026-08-01",
    TENTATIVE_END_DATE: "2026-08-01",
    LAST_UPDATED: "2026-07-01T00:00:00Z",
  });
  const latest = baseRow({
    PLACEMENT_ID: 1463975,
    CONTRACT_ID: "CHC1284",
    DEAL_TYPE: "EXTENSION",
    ONSITE_AM: "Vish Singh",
    ONSITE_AM_EMAIL: "vish.s2@cynethealth.com",
    START_DATE: "2026-08-02",
    END_DATE: null,
    TENTATIVE_END_DATE: "2026-11-07",
    LAST_UPDATED: "2026-07-20T00:00:00Z",
  });
  const rows = buildOwnershipChangeLogRowsFromVersions([previous, latest]);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.OWNERSHIP_ROLE, "ONSITE_AM");
  assert.equal(r.NEW_OWNER_NAME, "Vish Singh");
  assert.equal(r.PREVIOUS_OWNER_NAME, "Stephanie Marzan");
  assert.equal(r.PLACEMENT_ID, "1463975");
  assert.equal(r.CONTRACT_ID, "CHC1284");
  assert.equal(r.START_DATE, "2026-08-02");
  assert.equal(r.END_DATE_PREVIOUS_OWNER, "2026-08-01");
  assert.equal(r.OWNERSHIP_EFFECTIVE_DATE, "2026-08-02");
  assert.equal(r.EFFECTIVE_DATE_SOURCE, "EXTENSION_START");
  assert.equal(r.EFFECTIVE_DATE_PLACEMENT_ID, "1463975");
  assert.equal(r.CHANGE_REASON_NOTES, "CONTRACT_CHAIN");
});

test("contract chain: the handover lands on the new extension's start, not the old segment's end (Jemal Saleh)", () => {
  // Previous segment ended 2026-06-13; the new placement runs 2026-09-12 -> 2026-12-12.
  const previous = baseRow({
    PLACEMENT_ID: 1440000,
    CONTRACT_ID: "CHC3656",
    PLACEMENT_STATUS: "ENDED",
    END_DATE: "2026-06-13",
    TENTATIVE_END_DATE: "2026-06-13",
    LAST_UPDATED: "2026-06-01T00:00:00Z",
    ASSIGNMENT_RECRUITER: "Priyanka Bansal (R1A)",
    ASSIGNMENT_RECRUITER_EMAIL: "priyanka.b@cynethealth.com",
    RECRUITER_EMP_NO: "CY5660",
  });
  const latest = baseRow({
    PLACEMENT_ID: 1465103,
    CONTRACT_ID: "CHC3656",
    DEAL_TYPE: "EXTENSION",
    START_DATE: "2026-09-12",
    TENTATIVE_END_DATE: "2026-12-12",
    LAST_UPDATED: "2026-08-20T00:00:00Z",
    ASSIGNMENT_RECRUITER: "Kevin Prasad",
    ASSIGNMENT_RECRUITER_EMAIL: "kevin.p@cynethealth.com",
    RECRUITER_EMP_NO: "CY4256",
  });
  const recruiterRow = buildOwnershipChangeLogRowsFromVersions([previous, latest]).find((r) => r.OWNERSHIP_ROLE === "RECRUITER");
  assert.ok(recruiterRow);
  assert.equal(recruiterRow.PLACEMENT_ID, "1465103");
  assert.equal(recruiterRow.START_DATE, "2026-09-12");
  assert.equal(recruiterRow.END_DATE_PREVIOUS_OWNER, "2026-09-11");
  assert.equal(recruiterRow.OWNERSHIP_EFFECTIVE_DATE, "2026-09-12");
});

test("buildConsecutiveContractPlacementPairs: pairs consecutive START_DATE placements that pass shouldPair", () => {
  const heather = baseRow({
    PLACEMENT_ID: 1431143,
    CONTRACT_ID: "CHC1284",
    START_DATE: "2026-01-04",
    ONSITE_AM_EMAIL: "heather.h@cynethealth.com",
  });
  const alex = baseRow({
    PLACEMENT_ID: 1450188,
    CONTRACT_ID: "CHC1284",
    START_DATE: "2026-04-01",
    ONSITE_AM: "Alexandra Marcu",
    ONSITE_AM_EMAIL: "alexandra.m@cynethealth.com",
  });
  const sameAm = baseRow({
    PLACEMENT_ID: 999,
    CONTRACT_ID: "CHC1284",
    START_DATE: "2026-04-15",
    ONSITE_AM_EMAIL: "alexandra.m@cynethealth.com",
  });
  const onsiteAmDiffers = (next, prev) => next.ONSITE_AM_EMAIL !== prev.ONSITE_AM_EMAIL;
  const pairs = buildConsecutiveContractPlacementPairs([alex, sameAm, heather], onsiteAmDiffers);
  assert.equal(pairs.size, 1);
  assert.ok(pairs.has("CHC1284|1431143|1450188"));
  assert.equal(pairs.get("CHC1284|1431143|1450188").previous.PLACEMENT_ID, 1431143);
  assert.equal(pairs.get("CHC1284|1431143|1450188").latest.PLACEMENT_ID, 1450188);
});


test("contractSegmentRateFieldsDiffer: detects bill-rate change and RATE_CHANGE=YES", () => {
  assert.equal(
    contractSegmentRateFieldsDiffer(
      { BILL_RATE: 80, FINAL_BILL_RATE: 75.0, RATE_CHANGE: "NO" },
      { BILL_RATE: 80, FINAL_BILL_RATE: 75.2, RATE_CHANGE: "NO" }
    ),
    true
  );
  assert.equal(
    contractSegmentRateFieldsDiffer(
      { BILL_RATE: 80, FINAL_BILL_RATE: 75.2, RATE_CHANGE: "YES" },
      { BILL_RATE: 80, FINAL_BILL_RATE: 75.2, RATE_CHANGE: "NO" }
    ),
    true
  );
  assert.equal(
    contractSegmentRateFieldsDiffer(
      { BILL_RATE: 80, FINAL_BILL_RATE: 75.2, RATE_CHANGE: "NO" },
      { BILL_RATE: 80, FINAL_BILL_RATE: 75.2, RATE_CHANGE: "NO" }
    ),
    false
  );
});

test("the data-team cutoff applies by default (config.ownershipLogDataTeamCutoff); null turns it off", () => {
  const v = (pid, t, am) => ({
    DEAL_SHEET_ID: Number(pid), PLACEMENT_ID: pid, CONTRACT_ID: "CHC9", SKU_NUMBER: "H9", DEAL_TYPE: "EXTENSION",
    PLACEMENT_STATUS: "STARTED", START_DATE: pid === "1" ? "2026-08-01" : "2026-11-01", TENTATIVE_END_DATE: "2026-10-31",
    LAST_UPDATED: t, ONSITE_AM: am, ONSITE_AM_EMAIL: `${am}@x.com`,
  });
  const versions = [v("1", "2026-09-01T00:00:00Z", "A"), v("2", "2026-09-20T00:00:00Z", "B")];
  const saved = config.ownershipLogDataTeamCutoff;
  try {
    config.ownershipLogDataTeamCutoff = "2026-10-02T12:50:26Z";
    assert.equal(buildOwnershipChangeLogRowsFromVersions(versions).length, 0);
    assert.equal(buildOwnershipChangeLogRowsFromVersions(versions, { seenAfterMs: null }).length, 1);
  } finally {
    config.ownershipLogDataTeamCutoff = saved;
  }
});

test("the data-team cutoff skips Canada contracts (the data team has no Canada history)", () => {
  const v = (pid, t, am) => ({
    DEAL_SHEET_ID: Number(pid), PLACEMENT_ID: pid, CONTRACT_ID: "CAC9", SKU_NUMBER: null, DEAL_TYPE: "EXTENSION",
    CLIENT_STATE: "ON", _src: "cynet_health_canada_deal_sheet",
    PLACEMENT_STATUS: "STARTED", START_DATE: pid === "1" ? "2026-08-01" : "2026-11-01", TENTATIVE_END_DATE: "2026-10-31",
    LAST_UPDATED: t, ONSITE_AM: am, ONSITE_AM_EMAIL: `${am}@x.com`,
  });
  const versions = [v("1", "2026-09-01T00:00:00Z", "A"), v("2", "2026-09-20T00:00:00Z", "B")];
  const saved = config.ownershipLogDataTeamCutoff;
  try {
    config.ownershipLogDataTeamCutoff = "2026-10-02T12:50:26Z";
    assert.equal(buildOwnershipChangeLogRowsFromVersions(versions).length, 1);
  } finally {
    config.ownershipLogDataTeamCutoff = saved;
  }
});
