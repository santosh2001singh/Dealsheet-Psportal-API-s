const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildOwnershipChangeLogRows,
  buildContractOwnershipChangeLogRows,
  buildOwnershipChangeLogDedupeKey,
  buildConsecutiveContractPlacementPairs,
  ownershipChangeRolesDiffer,
  contractSegmentRateFieldsDiffer,
  OWNERSHIP_CHANGE_REASON_CONTRACT_CHAIN,
  applyPreviousRecruiterOnRecruiterChange,
} = require("./bigQueryClient");

function baseRow(overrides) {
  return {
    DEAL_SHEET_ID: 10,
    PLACEMENT_ID: 100,
    CONTRACT_ID: "CHC1234",
    CANDIDATE_NAME: "Jane Candidate",
    CANDIDATE_EMAIL: "jane@x.com",
    START_DATE: "2026-05-01",
    TENTATIVE_END_DATE: "2026-05-15",
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

test("buildOwnershipChangeLogRows: pure recruiter change -> single RECRUITER row with correct owners + dates", () => {
  const previous = baseRow({});
  const latest = baseRow({
    ASSIGNMENT_RECRUITER: "New Rec",
    ASSIGNMENT_RECRUITER_EMAIL: "new.rec@cynethealth.com",
    RECRUITER_EMP_NO: "CY200",
  });
  const rows = buildOwnershipChangeLogRows(latest, previous);
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
  assert.equal(r.SKU_NO, null);
  assert.equal(r.CHANGE_REASON_NOTES, null);
  assert.equal(r.EDITED_BY, null);
});

test("buildOwnershipChangeLogRows: RM became recruiter -> 2 rows (RECRUITER assign + RM vacated NA)", () => {
  // Previous row: xyz (CY200) is the RM. Recruiter is Old Rec (CY100).
  const previous = baseRow({ RM: "Xyz Person", RM_EMP_NO: "CY200" });
  // Latest row: xyz (CY200) is now the recruiter.
  const latest = baseRow({
    ASSIGNMENT_RECRUITER: "Xyz Person",
    ASSIGNMENT_RECRUITER_EMAIL: "xyz@cynethealth.com",
    RECRUITER_EMP_NO: "CY200",
    RM: "Xyz Person",
    RM_EMP_NO: "CY200",
  });
  const rows = buildOwnershipChangeLogRows(latest, previous);
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

test("buildOwnershipChangeLogRows: onsite AM change -> ONSITE_AM row, emp no null", () => {
  const previous = baseRow({});
  const latest = baseRow({ ONSITE_AM: "Onsite Two", ONSITE_AM_EMAIL: "onsite.two@cynethealth.com" });
  const rows = buildOwnershipChangeLogRows(latest, previous);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].OWNERSHIP_ROLE, "ONSITE_AM");
  assert.equal(rows[0].NEW_OWNER_NAME, "Onsite Two");
  assert.equal(rows[0].NEW_OWNER_EMP_NO, null);
  assert.equal(rows[0].PREVIOUS_OWNER_NAME, "Onsite One");
  assert.equal(rows[0].PREVIOUS_OWNER_EMP_NO, null);
});

test("buildOwnershipChangeLogRows: multiple CSM levels change -> one row each", () => {
  const previous = baseRow({});
  const latest = baseRow({ LEVEL_2_CSM: "Csm Two New", LEVEL_4_CSM: "Csm Four New" });
  const rows = buildOwnershipChangeLogRows(latest, previous);
  const roles = rows.map((r) => r.OWNERSHIP_ROLE).sort();
  assert.deepEqual(roles, ["LEVEL_2_CSM", "LEVEL_4_CSM"]);
  const l2 = rows.find((r) => r.OWNERSHIP_ROLE === "LEVEL_2_CSM");
  assert.equal(l2.NEW_OWNER_NAME, "Csm Two New");
  assert.equal(l2.PREVIOUS_OWNER_NAME, "Csm Two");
});

test("buildOwnershipChangeLogRows: no change -> empty", () => {
  const previous = baseRow({});
  const latest = baseRow({});
  assert.deepEqual(buildOwnershipChangeLogRows(latest, previous), []);
});

test("buildOwnershipChangeLogRows: case-only recruiter email difference is not a change", () => {
  const previous = baseRow({ ASSIGNMENT_RECRUITER_EMAIL: "old.rec@cynethealth.com" });
  const latest = baseRow({ ASSIGNMENT_RECRUITER_EMAIL: "Old.Rec@CynetHealth.com" });
  assert.deepEqual(buildOwnershipChangeLogRows(latest, previous), []);
});

test("buildOwnershipChangeLogRows: pure removal (latest blank) is not logged", () => {
  const previous = baseRow({});
  const latest = baseRow({ ONSITE_AM: null, ONSITE_AM_EMAIL: null });
  assert.deepEqual(buildOwnershipChangeLogRows(latest, previous), []);
});

test("buildOwnershipChangeLogDedupeKey combines placement+role+owners; empty without placement or role", () => {
  const row = {
    PLACEMENT_ID: 100,
    OWNERSHIP_ROLE: "RECRUITER",
    NEW_OWNER_NAME: "New Rec",
    NEW_OWNER_EMP_NO: "CY200",
    PREVIOUS_OWNER_NAME: "Old Rec",
    PREVIOUS_OWNER_EMP_NO: "CY100",
  };
  assert.equal(buildOwnershipChangeLogDedupeKey(row), "100|RECRUITER|new rec|cy200|old rec|cy100");
  assert.equal(buildOwnershipChangeLogDedupeKey({ OWNERSHIP_ROLE: "RECRUITER" }), "");
  assert.equal(buildOwnershipChangeLogDedupeKey({ PLACEMENT_ID: 100 }), "");
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

test("buildContractOwnershipChangeLogRows: chain dates come from the NEW placement START_DATE", () => {
  // Rosalia-style: Stephanie ends 2026-08-01, Vish starts 2026-08-02
  const previous = baseRow({
    PLACEMENT_ID: 1449593,
    CONTRACT_ID: "CHC1284",
    ONSITE_AM: "Stephanie Marzan",
    ONSITE_AM_EMAIL: "stephanie.m2@cynethealth.com",
    START_DATE: "2026-05-03",
    END_DATE: "2026-08-01",
    TENTATIVE_END_DATE: "2026-08-01",
  });
  const latest = baseRow({
    PLACEMENT_ID: 1463975,
    CONTRACT_ID: "CHC1284",
    ONSITE_AM: "Vish Singh",
    ONSITE_AM_EMAIL: "vish.s2@cynethealth.com",
    START_DATE: "2026-08-02",
    END_DATE: null,
    TENTATIVE_END_DATE: "2026-11-07",
  });
  const rows = buildContractOwnershipChangeLogRows(latest, previous);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.OWNERSHIP_ROLE, "ONSITE_AM");
  assert.equal(r.NEW_OWNER_NAME, "Vish Singh");
  assert.equal(r.PREVIOUS_OWNER_NAME, "Stephanie Marzan");
  assert.equal(r.PLACEMENT_ID, "1463975");
  assert.equal(r.CONTRACT_ID, "CHC1284");
  assert.equal(r.START_DATE, "2026-08-02");
  // Both dates anchor on the new placement's START_DATE (2026-08-02) and stay adjacent.
  assert.equal(r.END_DATE_PREVIOUS_OWNER, "2026-08-01");
  assert.equal(r.OWNERSHIP_EFFECTIVE_DATE, "2026-08-02");
  assert.equal(r.CHANGE_REASON_NOTES, OWNERSHIP_CHANGE_REASON_CONTRACT_CHAIN);
});

test("buildContractOwnershipChangeLogRows: chain dates ignore the previous placement entirely", () => {
  const previous = baseRow({
    PLACEMENT_ID: 1,
    END_DATE: null,
    TENTATIVE_END_DATE: "2026-04-04",
    ONSITE_AM: "Heather Hoffman",
    ONSITE_AM_EMAIL: "heather.h@cynethealth.com",
  });
  const latest = baseRow({
    PLACEMENT_ID: 2,
    START_DATE: "2026-04-01",
    TENTATIVE_END_DATE: "2026-07-04",
    ONSITE_AM: "Alexandra Marcu",
    ONSITE_AM_EMAIL: "alexandra.m@cynethealth.com",
  });
  const rows = buildContractOwnershipChangeLogRows(latest, previous);
  // previous END/TENTATIVE (2026-04-04) is irrelevant now — only next.START_DATE matters.
  assert.equal(rows[0].END_DATE_PREVIOUS_OWNER, "2026-03-31");
  assert.equal(rows[0].OWNERSHIP_EFFECTIVE_DATE, "2026-04-01");
  assert.equal(rows[0].CHANGE_REASON_NOTES, "CONTRACT_CHAIN");
});

test("buildContractOwnershipChangeLogRows: handover lands on the new placement start (Jemal Saleh)", () => {
  // Previous segment ended 2026-06-13; the new placement runs 2026-09-12 -> 2026-12-12.
  // The handover is dated from the new placement's START_DATE: previous owner ends 2026-09-11,
  // new owner is effective 2026-09-12. Neither prevEnd+1 (2026-06-14) nor TENTATIVE+1.
  const previous = baseRow({
    PLACEMENT_ID: 1440000,
    CONTRACT_ID: "CHC3656",
    END_DATE: "2026-06-13",
    TENTATIVE_END_DATE: "2026-06-13",
    ASSIGNMENT_RECRUITER: "Priyanka Bansal (R1A)",
    ASSIGNMENT_RECRUITER_EMAIL: "priyanka.b@cynethealth.com",
    RECRUITER_EMP_NO: "CY5660",
  });
  const latest = baseRow({
    PLACEMENT_ID: 1465103,
    CONTRACT_ID: "CHC3656",
    START_DATE: "2026-09-12",
    TENTATIVE_END_DATE: "2026-12-12",
    ASSIGNMENT_RECRUITER: "Kevin Prasad",
    ASSIGNMENT_RECRUITER_EMAIL: "kevin.p@cynethealth.com",
    RECRUITER_EMP_NO: "CY4256",
  });
  const rows = buildContractOwnershipChangeLogRows(latest, previous);
  const recruiterRow = rows.find((r) => r.OWNERSHIP_ROLE === "RECRUITER");
  assert.ok(recruiterRow);
  assert.equal(recruiterRow.PLACEMENT_ID, "1465103");
  assert.equal(recruiterRow.START_DATE, "2026-09-12");
  assert.equal(recruiterRow.END_DATE_PREVIOUS_OWNER, "2026-09-11");
  assert.equal(recruiterRow.OWNERSHIP_EFFECTIVE_DATE, "2026-09-12");
});

test("buildConsecutiveContractPlacementPairs: pairs consecutive START_DATE placements with ownership diffs", () => {
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
  const pairs = buildConsecutiveContractPlacementPairs(
    [alex, sameAm, heather],
    ownershipChangeRolesDiffer
  );
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
