const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildInorganicHierarchyLogCandidate,
  buildInorganicHierarchyLogDedupeKey,
  resolveInorganicHierarchyLogRows,
  mergeInorganicHierarchyLogCandidates,
  filterInorganicHierarchyAgainstFrozenOrganic,
  fetchOnsiteAmCsmHierarchyByKey,
  applyOnsiteAmCsmHierarchyForRows,
} = require("./bigQueryClient");

test("buildInorganicHierarchyLogCandidate returns null when recruiter email is unchanged", () => {
  const latest = { ASSIGNMENT_RECRUITER_EMAIL: "new@cynethealth.com", DEAL_TYPE: "DEAL" };
  const previous = { ASSIGNMENT_RECRUITER_EMAIL: "New@CynetHealth.com " };
  assert.equal(buildInorganicHierarchyLogCandidate(latest, previous), null);
});

test("buildInorganicHierarchyLogCandidate returns null when new email is blank", () => {
  const latest = { ASSIGNMENT_RECRUITER_EMAIL: "", DEAL_TYPE: "DEAL" };
  const previous = { ASSIGNMENT_RECRUITER_EMAIL: "old@cynethealth.com" };
  assert.equal(buildInorganicHierarchyLogCandidate(latest, previous), null);
});

test("buildInorganicHierarchyLogCandidate returns null when either row is missing", () => {
  assert.equal(buildInorganicHierarchyLogCandidate(null, { ASSIGNMENT_RECRUITER_EMAIL: "a@x.com" }), null);
  assert.equal(buildInorganicHierarchyLogCandidate({ ASSIGNMENT_RECRUITER_EMAIL: "a@x.com" }, null), null);
});

test("buildInorganicHierarchyLogCandidate uses NEW_HIRE_DATE as anchor for DEAL rows", () => {
  const latest = {
    DEAL_SHEET_ID: 1,
    PLACEMENT_ID: 100,
    PLACEMENT_STATUS: "STARTED",
    CANDIDATE_NAME: "Jane Doe",
    CANDIDATE_ID: 55,
    DEAL_TYPE: "DEAL",
    NEW_HIRE_DATE: "2025-01-01T00:00:00.000Z",
    EXTENSION_DATE: "2099-01-01T00:00:00.000Z",
    ASSIGNMENT_RECRUITER_EMAIL: "new@cynethealth.com",
  };
  const previous = { ASSIGNMENT_RECRUITER_EMAIL: "old@cynethealth.com" };
  const candidate = buildInorganicHierarchyLogCandidate(latest, previous);
  assert.equal(candidate.DEAL_TYPE, "DEAL");
  assert.equal(candidate.anchorDate, "2025-01-01T00:00:00.000Z");
  assert.equal(candidate.newRecruiterEmail, "new@cynethealth.com");
  assert.equal(candidate.PLACEMENT_ID, 100);
});

test("buildInorganicHierarchyLogCandidate uses EXTENSION_DATE as anchor for EXTENSION rows", () => {
  const latest = {
    DEAL_SHEET_ID: 2,
    PLACEMENT_ID: 200,
    DEAL_TYPE: "EXTENSION",
    NEW_HIRE_DATE: null,
    EXTENSION_DATE: "2025-06-01T00:00:00.000Z",
    ASSIGNMENT_RECRUITER_EMAIL: "new@cynethealth.com",
  };
  const previous = { ASSIGNMENT_RECRUITER_EMAIL: "old@cynethealth.com" };
  const candidate = buildInorganicHierarchyLogCandidate(latest, previous);
  assert.equal(candidate.DEAL_TYPE, "EXTENSION");
  assert.equal(candidate.anchorDate, "2025-06-01T00:00:00.000Z");
});

test("buildInorganicHierarchyLogDedupeKey combines DEAL_SHEET_ID, PLACEMENT_ID, recruiter email, CSM levels, and hierarchy divergences", () => {
  const hierarchyBlank = ",,,,,,,,"; // 9 INORGANIC_HIERARCHY_DEDUPE_COLUMNS, all empty
  const row = { DEAL_SHEET_ID: 1, PLACEMENT_ID: 100, RECRUITER_EMAIL_ID: "New@CynetHealth.com " };
  assert.equal(buildInorganicHierarchyLogDedupeKey(row), `1|100|new@cynethealth.com|,,|${hierarchyBlank}`);
  // No signal at all -> nothing to dedupe on, empty key.
  assert.equal(buildInorganicHierarchyLogDedupeKey({ DEAL_SHEET_ID: 1, PLACEMENT_ID: 100 }), "");
  // CSM-only signal (no recruiter change) still produces a non-empty, distinguishing key.
  const csmOnlyRow = { DEAL_SHEET_ID: 1, PLACEMENT_ID: 100, INORGANIC_LEVEL_2_CSM: "Jane Manager" };
  assert.equal(buildInorganicHierarchyLogDedupeKey(csmOnlyRow), `1|100||jane manager,,|${hierarchyBlank}`);
  // Recruiter-hierarchy-only signal (no recruiter change, no CSM) still produces a distinguishing key.
  const hierarchyOnlyRow = { DEAL_SHEET_ID: 1, PLACEMENT_ID: 100, INORGANIC_ACCOUNT_MANAGER: "Nikhil Sharma" };
  assert.equal(
    buildInorganicHierarchyLogDedupeKey(hierarchyOnlyRow),
    "1|100||,,|nikhil sharma,,,,,,,,"
  );
  assert.equal(buildInorganicHierarchyLogDedupeKey(null), "");
});

test("resolveInorganicHierarchyLogRows fills recruiter identity and hierarchy from injected fetch deps", async () => {
  const candidates = [
    buildInorganicHierarchyLogCandidate(
      {
        DEAL_SHEET_ID: 1,
        PLACEMENT_ID: 100,
        PLACEMENT_STATUS: "STARTED",
        CANDIDATE_NAME: "Jane Doe",
        CANDIDATE_ID: 55,
        DEAL_TYPE: "DEAL",
        NEW_HIRE_DATE: "2025-01-01T00:00:00.000Z",
        ASSIGNMENT_RECRUITER_EMAIL: "ajay.k@cynethealth.com",
      },
      { ASSIGNMENT_RECRUITER_EMAIL: "old.recruiter@cynethealth.com" }
    ),
  ];

  const directoryFetchFn = async (emails) => {
    assert.deepEqual(emails, ["ajay.k@cynethealth.com"]);
    return new Map([
      ["ajay.k@cynethealth.com", { employeeId: "CY2393", externalId: "107558171539842111916", nameFull: "Ajay Kumar" }],
    ]);
  };
  const hierarchyFetchFn = async (targets) => {
    assert.equal(targets.length, 1);
    assert.equal(targets[0].externalId, "107558171539842111916");
    return new Map([
      [
        "0",
        [
          { hierarchy_level: "1", manager_name: "Nikhil Sharma", manager_employee_id: "CY2431", manager_title: "Sr. Delivery Manager" },
          { hierarchy_level: "2", manager_name: "Maneet Gupta", manager_employee_id: "CY2088", manager_title: "Associate Vice President - Delivery" },
          { hierarchy_level: "3", manager_name: "Ron Bagga", manager_employee_id: "CY879", manager_title: "Chief Growth Officer (CGO)" },
        ],
      ],
    ]);
  };

  const fetchEmailsFn = async (empNos) => ({
    byEmp: new Map((empNos || []).includes("CY2431") ? [["CY2431", "nikhil.s@cynethealth.com"]] : []),
    byName: new Map(),
  });
  const rows = await resolveInorganicHierarchyLogRows(candidates, {}, { directoryFetchFn, hierarchyFetchFn, fetchEmailsFn });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.DEAL_SHEET_ID, 1);
  assert.equal(row.PLACEMENT_ID, 100);
  assert.equal(row.RECRUITER_EMAIL_ID, "ajay.k@cynethealth.com");
  assert.equal(row.RECRUITER_NAME, "Ajay Kumar");
  assert.equal(row.INORGANIC_RECRUITER, "Ajay Kumar");
  assert.equal(row.INORGANIC_RECRUITER_EMP_NO, "CY2393");
  assert.equal(row.INORGANIC_ACCOUNT_MANAGER, "Nikhil Sharma");
  assert.equal(row.INORGANIC_ACCOUNT_MANAGER_EMP_NO, "CY2431");
  // "Associate Vice President - Delivery" is now its own AVP designation (split out of VP).
  assert.equal(row.INORGANIC_AVP, "Maneet Gupta");
  assert.equal(row.INORGANIC_AVP_EMP_NO, "CY2088");
  // INORGANIC_DELIVERY_POC = highest present in the deal-sheet POC chain (AVP beats ACCOUNT_MANAGER).
  assert.equal(row.INORGANIC_DELIVERY_POC, "Maneet Gupta");
  assert.equal(row.INORGANIC_DELIVERY_POC_EMP_NO, "CY2088");
  assert.equal(row.INORGANIC_DELIVERY_POC_EMAIL, null); // fetchEmailsFn only stubs CY2431
  // "Chief Growth Officer (CGO)" matches no known designation -> no INORGANIC_* column set for it.
  assert.equal(row.OWNERSHIP_EFFECTIVE_DATE, new Date().toISOString().slice(0, 10));
  assert.equal(typeof row.LAST_UPDATED, "string");
});

test("resolveInorganicHierarchyLogRows still logs recruiter identity when hierarchy lookup finds nothing", async () => {
  const candidates = [
    buildInorganicHierarchyLogCandidate(
      {
        DEAL_SHEET_ID: 1,
        PLACEMENT_ID: 100,
        DEAL_TYPE: "DEAL",
        ASSIGNMENT_RECRUITER_EMAIL: "unknown@cynethealth.com",
      },
      { ASSIGNMENT_RECRUITER_EMAIL: "old.recruiter@cynethealth.com" }
    ),
  ];

  const directoryFetchFn = async () => new Map();
  let hierarchyCalled = false;
  const hierarchyFetchFn = async () => {
    hierarchyCalled = true;
    return new Map();
  };

  const rows = await resolveInorganicHierarchyLogRows(candidates, {}, { directoryFetchFn, hierarchyFetchFn });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].RECRUITER_EMAIL_ID, "unknown@cynethealth.com");
  assert.equal(rows[0].RECRUITER_NAME, null);
  assert.equal(rows[0].INORGANIC_ACCOUNT_MANAGER, undefined);
  assert.equal(hierarchyCalled, false);
});

test("resolveInorganicHierarchyLogRows returns empty array for no candidates", async () => {
  const rows = await resolveInorganicHierarchyLogRows([]);
  assert.deepEqual(rows, []);
});

test("resolveInorganicHierarchyLogRows maps a CSM-only candidate (no recruiter change) with recruiter fields left null", async () => {
  const candidates = [
    {
      DEAL_SHEET_ID: 5,
      PLACEMENT_ID: 500,
      PLACEMENT_STATUS: "STARTED",
      CANDIDATE_NAME: "John Smith",
      CANDIDATE_ID: 77,
      csmDivergedLevels: { LEVEL_2_CSM: "New CSM Manager", LEVEL_3_CSM: null },
    },
  ];

  let directoryCalled = false;
  let hierarchyCalled = false;
  const directoryFetchFn = async () => {
    directoryCalled = true;
    return new Map();
  };
  const hierarchyFetchFn = async () => {
    hierarchyCalled = true;
    return new Map();
  };

  const rows = await resolveInorganicHierarchyLogRows(candidates, {}, { directoryFetchFn, hierarchyFetchFn });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].RECRUITER_EMAIL_ID, null);
  assert.equal(rows[0].RECRUITER_NAME, null);
  assert.equal(rows[0].INORGANIC_RECRUITER, null);
  assert.equal(rows[0].INORGANIC_LEVEL_2_CSM, "New CSM Manager");
  assert.equal(rows[0].INORGANIC_LEVEL_3_CSM, null);
  assert.equal(rows[0].INORGANIC_LEVEL_4_CSM, undefined);
  // Directory/hierarchy lookups are only for recruiter-change resolution; a CSM-only candidate
  // (already carrying its resolved diverged values) must not trigger either fetch.
  assert.equal(directoryCalled, false);
  assert.equal(hierarchyCalled, false);
});

test("resolveInorganicHierarchyLogRows combines recruiter-change and CSM-divergence signals on one row", async () => {
  const candidates = [
    {
      DEAL_SHEET_ID: 1,
      PLACEMENT_ID: 100,
      newRecruiterEmail: "ajay.k@cynethealth.com",
      anchorDate: "2025-01-01T00:00:00.000Z",
      csmDivergedLevels: { LEVEL_4_CSM: "Someone New" },
    },
  ];
  const directoryFetchFn = async () =>
    new Map([["ajay.k@cynethealth.com", { employeeId: "CY2393", externalId: "ext-1", nameFull: "Ajay Kumar" }]]);
  const hierarchyFetchFn = async () => new Map([["0", [
    { hierarchy_level: "1", manager_name: "Nikhil Sharma", manager_employee_id: "CY2431", manager_title: "Sr. Delivery Manager" },
  ]]]);

  const rows = await resolveInorganicHierarchyLogRows(candidates, {}, { directoryFetchFn, hierarchyFetchFn });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].RECRUITER_EMAIL_ID, "ajay.k@cynethealth.com");
  assert.equal(rows[0].INORGANIC_RECRUITER, "Ajay Kumar");
  assert.equal(rows[0].INORGANIC_ACCOUNT_MANAGER, "Nikhil Sharma");
  assert.equal(rows[0].INORGANIC_LEVEL_4_CSM, "Someone New");
});

test("mergeInorganicHierarchyLogCandidates combines both signals for the same placement into one candidate", () => {
  const recruiterCandidates = [
    { DEAL_SHEET_ID: 1, PLACEMENT_ID: 100, newRecruiterEmail: "new@cynethealth.com", anchorDate: null },
    { DEAL_SHEET_ID: 2, PLACEMENT_ID: 200, newRecruiterEmail: "other@cynethealth.com", anchorDate: null },
  ];
  const csmCandidates = [
    { DEAL_SHEET_ID: 1, PLACEMENT_ID: 100, csmDivergedLevels: { LEVEL_2_CSM: "New Manager" } },
    { DEAL_SHEET_ID: 3, PLACEMENT_ID: 300, csmDivergedLevels: { LEVEL_3_CSM: "Another Manager" } },
  ];

  const merged = mergeInorganicHierarchyLogCandidates(recruiterCandidates, csmCandidates);
  assert.equal(merged.length, 3);

  const combined = merged.find((c) => c.PLACEMENT_ID === 100);
  assert.equal(combined.newRecruiterEmail, "new@cynethealth.com");
  assert.deepEqual(combined.csmDivergedLevels, { LEVEL_2_CSM: "New Manager" });

  const recruiterOnly = merged.find((c) => c.PLACEMENT_ID === 200);
  assert.equal(recruiterOnly.newRecruiterEmail, "other@cynethealth.com");
  assert.equal(recruiterOnly.csmDivergedLevels, undefined);

  const csmOnly = merged.find((c) => c.PLACEMENT_ID === 300);
  assert.equal(csmOnly.newRecruiterEmail, undefined);
  assert.deepEqual(csmOnly.csmDivergedLevels, { LEVEL_3_CSM: "Another Manager" });
});

test("mergeInorganicHierarchyLogCandidates handles empty inputs", () => {
  assert.deepEqual(mergeInorganicHierarchyLogCandidates([], []), []);
  assert.deepEqual(mergeInorganicHierarchyLogCandidates(null, null), []);
});

test("fetchOnsiteAmCsmHierarchyByKey resolves hire-date-anchored CSM levels via ONSITE_AM_EMAIL only", async () => {
  const rows = [
    { ONSITE_AM_EMAIL: "onsite.am@cynethealth.com", NEW_HIRE_DATE: "2025-03-01T00:00:00.000Z", ASSIGNMENT_RECRUITER_EMAIL: "recruiter@cynethealth.com" },
  ];
  const directoryFetchFn = async (emails) => {
    assert.deepEqual(emails, ["onsite.am@cynethealth.com"]);
    return new Map([["onsite.am@cynethealth.com", { employeeId: "13293", externalId: "ext-onsite", nameFull: "Jessica Van Essen" }]]);
  };
  const hierarchyFetchFn = async (targets, opts) => {
    assert.equal(targets.length, 1);
    assert.equal(targets[0].externalId, "ext-onsite");
    assert.equal(opts.direction, "on_or_before");
    return new Map([["0", [
      { hierarchy_level: "1", manager_name: "Jodi Stanton", manager_title: "AVP Client Relationship & Strategy" },
    ]]]);
  };

  const levelsByKey = await fetchOnsiteAmCsmHierarchyByKey(rows, {}, { directoryFetchFn, hierarchyFetchFn });
  assert.deepEqual(levelsByKey.get("0"), { LEVEL_2_CSM: "Jodi Stanton", LEVEL_3_CSM: null, LEVEL_4_CSM: null });
});

test("fetchOnsiteAmCsmHierarchyByKey resolves CSM levels when the directory has external_id but employee_id is null", async () => {
  // Chelsea Waszak: directory_employees carries external_id but employee_id IS NULL. The chain must
  // still resolve — only external_id joins into directory_employee_hierarchy.
  const rows = [
    { ONSITE_AM_EMAIL: "chelsea.w@cynethealth.com", NEW_HIRE_DATE: "2026-08-04T13:49:58.000Z" },
  ];
  const directoryFetchFn = async () =>
    new Map([
      [
        "chelsea.w@cynethealth.com",
        { employeeId: null, externalId: "116414702927104296724", nameFull: "Chelsea Waszak" },
      ],
    ]);
  const hierarchyFetchFn = async (targets) => {
    assert.equal(targets.length, 1);
    assert.equal(targets[0].externalId, "116414702927104296724");
    return new Map([["0", [
      { hierarchy_level: "1", manager_name: "Jessica Van Essen", manager_title: "Client Success Director" },
      { hierarchy_level: "2", manager_name: "Jodi Stanton", manager_title: "AVP Client Relationship & Strategy" },
      { hierarchy_level: "3", manager_name: "Ron Bagga", manager_title: "CGO - Chief Growth Officer" },
      { hierarchy_level: "4", manager_name: "Nick Budhiraja", manager_title: "CO-CEO" },
    ]]]);
  };

  const levelsByKey = await fetchOnsiteAmCsmHierarchyByKey(rows, {}, { directoryFetchFn, hierarchyFetchFn });
  assert.deepEqual(levelsByKey.get("0"), {
    LEVEL_2_CSM: "Jessica Van Essen",
    LEVEL_3_CSM: "Jodi Stanton",
    LEVEL_4_CSM: null, // Ron Bagga excluded (C-level title)
  });
});

test("fetchOnsiteAmCsmHierarchyByKey skips rows whose directory entry has no external_id", async () => {
  const rows = [{ ONSITE_AM_EMAIL: "no.ext@cynethealth.com", NEW_HIRE_DATE: "2026-08-04T00:00:00.000Z" }];
  const directoryFetchFn = async () =>
    new Map([["no.ext@cynethealth.com", { employeeId: "CY1", externalId: null, nameFull: "No Ext" }]]);
  let hierarchyCalled = false;
  const hierarchyFetchFn = async () => {
    hierarchyCalled = true;
    return new Map();
  };

  const levelsByKey = await fetchOnsiteAmCsmHierarchyByKey(rows, {}, { directoryFetchFn, hierarchyFetchFn });
  assert.equal(hierarchyCalled, false);
  assert.equal(levelsByKey.size, 0);
});

test("applyOnsiteAmCsmHierarchyForRows recomputes on every call (not insert-once) and clears when ONSITE_AM_EMAIL is missing", async () => {
  const rows = [
    { PLACEMENT_ID: 1, ONSITE_AM_EMAIL: "onsite@cynethealth.com", LEVEL_2_CSM: "Stale Old Value" },
    { PLACEMENT_ID: 2, ONSITE_AM_EMAIL: null, LEVEL_2_CSM: "Should Be Cleared" },
  ];
  const fetchFn = async () =>
    new Map([["0", { LEVEL_2_CSM: "Fresh Manager", LEVEL_3_CSM: null, LEVEL_4_CSM: null }]]);

  const out = await applyOnsiteAmCsmHierarchyForRows(rows, {}, { fetchFn });
  assert.equal(out[0].LEVEL_2_CSM, "Fresh Manager");
  assert.equal(out[1].LEVEL_2_CSM, null);
});

test("filterInorganicHierarchyAgainstFrozenOrganic: EXTENSION same hierarchy → no divergence (skip insert)", () => {
  const inorganicRow = {
    DEAL_SHEET_ID: 10,
    PLACEMENT_ID: 500,
    RECRUITER_EMAIL_ID: "new@cynethealth.com",
    INORGANIC_RECRUITER: "New Recruiter",
    INORGANIC_RECRUITER_EMP_NO: "E999",
    INORGANIC_TL: "Same TL",
    INORGANIC_TL_EMP_NO: "TL1",
    INORGANIC_RM: "Same RM",
    INORGANIC_RM_EMP_NO: "RM1",
    INORGANIC_ACCOUNT_MANAGER: "Same AM",
    INORGANIC_ACCOUNT_MANAGER_EMP_NO: "AM1",
    INORGANIC_DELIVERY_POC: "Same AM",
    INORGANIC_DELIVERY_POC_EMP_NO: "AM1",
    INORGANIC_DELIVERY_POC_EMAIL: "am@cynethealth.com",
  };
  const frozen = {
    DEAL_TYPE: "EXTENSION",
    TEAM_LEAD: "Same TL",
    TEAM_LEAD_EMP_NO: "TL1",
    RM: "Same RM",
    RM_EMP_NO: "RM1",
    ACCOUNT_MANAGER: "Same AM",
    ACCOUNT_MANAGER_EMP_NO: "AM1",
  };
  const { row, hasDivergence } = filterInorganicHierarchyAgainstFrozenOrganic(inorganicRow, frozen);
  assert.equal(hasDivergence, false);
  assert.equal(row.INORGANIC_TL, null);
  assert.equal(row.INORGANIC_RM, null);
  assert.equal(row.INORGANIC_ACCOUNT_MANAGER, null);
  assert.equal(row.INORGANIC_DELIVERY_POC, null);
  // Recruiter identity may remain, but alone is not enough to insert.
  assert.equal(row.INORGANIC_RECRUITER, "New Recruiter");
});

test("filterInorganicHierarchyAgainstFrozenOrganic: EXTENSION new person only → only that INORGANIC_* kept", () => {
  const inorganicRow = {
    INORGANIC_RECRUITER: "New Recruiter",
    INORGANIC_RECRUITER_EMP_NO: "E999",
    INORGANIC_TL: "Same TL",
    INORGANIC_TL_EMP_NO: "TL1",
    INORGANIC_RM: "Brand New RM",
    INORGANIC_RM_EMP_NO: "RM_NEW",
    INORGANIC_ACCOUNT_MANAGER: "Same AM",
    INORGANIC_ACCOUNT_MANAGER_EMP_NO: "AM1",
    INORGANIC_DELIVERY_POC: "Same AM",
    INORGANIC_DELIVERY_POC_EMP_NO: "AM1",
  };
  const frozen = {
    TEAM_LEAD: "Same TL",
    TEAM_LEAD_EMP_NO: "TL1",
    RM: "Old RM",
    RM_EMP_NO: "RM1",
    ACCOUNT_MANAGER: "Same AM",
    ACCOUNT_MANAGER_EMP_NO: "AM1",
  };
  const { row, hasDivergence } = filterInorganicHierarchyAgainstFrozenOrganic(inorganicRow, frozen);
  assert.equal(hasDivergence, true);
  assert.equal(row.INORGANIC_TL, null);
  assert.equal(row.INORGANIC_TL_EMP_NO, null);
  assert.equal(row.INORGANIC_ACCOUNT_MANAGER, null);
  assert.equal(row.INORGANIC_ACCOUNT_MANAGER_EMP_NO, null);
  assert.equal(row.INORGANIC_RM, "Brand New RM");
  assert.equal(row.INORGANIC_RM_EMP_NO, "RM_NEW");
  assert.equal(row.INORGANIC_DELIVERY_POC, "Brand New RM");
  assert.equal(row.INORGANIC_DELIVERY_POC_EMP_NO, "RM_NEW");
});

test("filterInorganicHierarchyAgainstFrozenOrganic: EXTENSION fully different chain → all divergent roles set", () => {
  const inorganicRow = {
    INORGANIC_TL: "New TL",
    INORGANIC_TL_EMP_NO: "TL_NEW",
    INORGANIC_RM: "New RM",
    INORGANIC_RM_EMP_NO: "RM_NEW",
    INORGANIC_ACCOUNT_MANAGER: "New AM",
    INORGANIC_ACCOUNT_MANAGER_EMP_NO: "AM_NEW",
    INORGANIC_ATL: "New ATL",
    INORGANIC_ATL_EMP_NO: "ATL_NEW",
    INORGANIC_DELIVERY_POC: "New AM",
    INORGANIC_DELIVERY_POC_EMP_NO: "AM_NEW",
    INORGANIC_DELIVERY_POC_EMAIL: "newam@cynethealth.com",
  };
  const frozen = {
    TEAM_LEAD: "Old TL",
    TEAM_LEAD_EMP_NO: "TL_OLD",
    RM: "Old RM",
    RM_EMP_NO: "RM_OLD",
    ACCOUNT_MANAGER: "Old AM",
    ACCOUNT_MANAGER_EMP_NO: "AM_OLD",
    ATL: "Old ATL",
    ATL_EMP_NO: "ATL_OLD",
  };
  const { row, hasDivergence } = filterInorganicHierarchyAgainstFrozenOrganic(inorganicRow, frozen);
  assert.equal(hasDivergence, true);
  assert.equal(row.INORGANIC_TL, "New TL");
  assert.equal(row.INORGANIC_RM, "New RM");
  assert.equal(row.INORGANIC_ACCOUNT_MANAGER, "New AM");
  assert.equal(row.INORGANIC_ATL, "New ATL");
  assert.equal(row.INORGANIC_DELIVERY_POC, "New AM");
  assert.equal(row.INORGANIC_DELIVERY_POC_EMP_NO, "AM_NEW");
  // Same emp remains POC → keep prior email.
  assert.equal(row.INORGANIC_DELIVERY_POC_EMAIL, "newam@cynethealth.com");
});

test("filterInorganicHierarchyAgainstFrozenOrganic: same by name when emp missing still clears slot", () => {
  const inorganicRow = {
    INORGANIC_TL: "Alex Lead",
    INORGANIC_TL_EMP_NO: null,
    INORGANIC_RM: "Different RM",
    INORGANIC_RM_EMP_NO: "RM2",
  };
  const frozen = {
    TEAM_LEAD: "Alex Lead",
    TEAM_LEAD_EMP_NO: "TL1",
    RM: "Old RM",
    RM_EMP_NO: "RM1",
  };
  const { row, hasDivergence } = filterInorganicHierarchyAgainstFrozenOrganic(inorganicRow, frozen);
  assert.equal(hasDivergence, true);
  assert.equal(row.INORGANIC_TL, null);
  assert.equal(row.INORGANIC_RM, "Different RM");
});
