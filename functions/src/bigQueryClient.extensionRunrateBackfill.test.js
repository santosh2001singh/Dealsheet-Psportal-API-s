const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EXTENSION_RUNRATE_HIERARCHY_COLUMNS,
  EXTENSION_RUNRATE_MANUAL_COLUMNS,
  EXTENSION_RUNRATE_ELIGIBLE_PLACEMENT_STATUSES,
  isExtensionRunrateEligiblePlacementStatus,
  buildRunrateEligiblePlacementStatusSqlPredicate,
  EXTENSION_PARENT_DEAL_INHERIT_COLUMNS,
  SQL_CANDIDATE_EMAIL_NORM,
  SQL_PHONE_NUMBER_NORM,
  rowNeedsExtensionInsertBackfill,
  rowNeedsExtensionRunrateBackfill,
  applyExtensionInheritForInsertRows,
  applyExtensionRunrateBackfillForInsertRows,
  resolveContractIdsForRunrateMatchedExtensions,
} = require("./bigQueryClient");

const noContractIdResolution = async () => new Map();
const noParentFetch = async () => new Map();
const noPriorExtensionFetch = async () => new Map();

test("SQL identity norms TRIM email and phone (both sides of EXTENSION parent/prior/contract joins)", () => {
  assert.equal(SQL_CANDIDATE_EMAIL_NORM, "LOWER(TRIM(IFNULL(CANDIDATE_EMAIL, '')))");
  assert.equal(SQL_PHONE_NUMBER_NORM, "TRIM(IFNULL(CELL_PHONE, ''))");
  assert.match(SQL_CANDIDATE_EMAIL_NORM, /TRIM/);
  assert.match(SQL_PHONE_NUMBER_NORM, /TRIM/);
  // Guard against regressing to the pre-fix untrimmed forms that dropped parent matches.
  assert.notEqual(SQL_CANDIDATE_EMAIL_NORM, "LOWER(IFNULL(CANDIDATE_EMAIL, ''))");
  assert.notEqual(SQL_PHONE_NUMBER_NORM, "IFNULL(CELL_PHONE, '')");
});

test("EXTENSION_RUNRATE_ELIGIBLE_PLACEMENT_STATUSES allows only STARTED, BOOKED, ENDED, ENDED<30", () => {
  assert.deepEqual([...EXTENSION_RUNRATE_ELIGIBLE_PLACEMENT_STATUSES], [
    "STARTED",
    "BOOKED",
    "ENDED",
    "ENDED<30",
  ]);
});

test("buildRunrateEligiblePlacementStatusSqlPredicate emits IN clause for eligible statuses", () => {
  assert.equal(
    buildRunrateEligiblePlacementStatusSqlPredicate(),
    "UPPER(TRIM(CAST(PLACEMENT_STATUS AS STRING))) IN ('STARTED', 'BOOKED', 'ENDED', 'ENDED<30')"
  );
  assert.equal(
    buildRunrateEligiblePlacementStatusSqlPredicate("r.PLACEMENT_STATUS"),
    "UPPER(TRIM(CAST(r.PLACEMENT_STATUS AS STRING))) IN ('STARTED', 'BOOKED', 'ENDED', 'ENDED<30')"
  );
});

test("isExtensionRunrateEligiblePlacementStatus excludes DID NOT START, DID NOT ACCEPT, and ACTIVE", () => {
  assert.equal(isExtensionRunrateEligiblePlacementStatus("ENDED"), true);
  assert.equal(isExtensionRunrateEligiblePlacementStatus("  ended<30 "), true);
  assert.equal(isExtensionRunrateEligiblePlacementStatus("STARTED"), true);
  assert.equal(isExtensionRunrateEligiblePlacementStatus("BOOKED"), true);
  assert.equal(isExtensionRunrateEligiblePlacementStatus("DID NOT START"), false);
  assert.equal(isExtensionRunrateEligiblePlacementStatus("DID NOT ACCEPT"), false);
  assert.equal(isExtensionRunrateEligiblePlacementStatus("ACTIVE"), false);
  assert.equal(isExtensionRunrateEligiblePlacementStatus(null), false);
  assert.equal(isExtensionRunrateEligiblePlacementStatus(""), false);
});

test("EXTENSION_RUNRATE_HIERARCHY_COLUMNS excludes assignment-recruiter identity fields", () => {
  const excluded = [
    "ASSIGNMENT_RECRUITER",
    "ASSIGNMENT_RECRUITER_EMAIL",
    "SECONDARY_RECRUITER",
    "RECRUITER_ID",
    "RECRUITER_EMP_NO",
    "PREVIOUS_RECRUITER_NAME",
  ];
  for (const col of excluded) {
    assert.equal(EXTENSION_RUNRATE_HIERARCHY_COLUMNS.includes(col), false, `${col} must not be included`);
  }
  for (const col of EXTENSION_RUNRATE_HIERARCHY_COLUMNS) {
    assert.equal(col.endsWith("_EMP_NO"), false, `${col} must not be an EMP_NO companion column`);
  }
});

test("EXTENSION_RUNRATE_MANUAL_COLUMNS covers sales/credentialing/payment + SECONDARY_RECRUITER", () => {
  const expected = [
    "CLIENT_RECRUITER",
    "CREDENTIALING_SPECIALIST",
    "CREDENTIALING_LEAD",
    "PRIMARY_SALES_PERSON",
    "SECONDARY_SALES_PERSON",
    "RECRUITMENT_MENTOR",
    "INVOICE_CYCLE_TO_CLIENT",
    "CLIENT_PAYMENT_TERMS",
    "CANDIDATE_PAYMENT_TERMS",
    "SECONDARY_RECRUITER",
    "SECONDARY_RECRUITER_EMP_NO",
    // Added Aug 2026, when this list also became the DEAL-side manual fill (legacyDealManualColumns).
    "ENTITY",
    "FIFTYTWO_TENURE_RTO_LASTDATE",
    "FIFTYTWO_TENURE_CANDIDATE_STATUS",
    "ST_DT_PUSHBACK_REASON",
    // Deal sheet column altered INT64 -> STRING to match the run-rate column it is filled from.
    "CLIENT_NAME_IN_CONREP",
    // Hand-written narrative that only ever existed on the run-rate side — null on every deal sheet
    // row until it is carried across.
    "BACKOUT_OR_TERMINATION",
    "COMMENTS",
  ];
  assert.deepEqual([...EXTENSION_RUNRATE_MANUAL_COLUMNS], expected);
  assert.equal(EXTENSION_RUNRATE_MANUAL_COLUMNS.includes("ASSIGNMENT_RECRUITER"), false);
  assert.equal(EXTENSION_RUNRATE_MANUAL_COLUMNS.includes("RECRUITER_CLUSTER_REGION"), false);
});

test("the ops columns are inheritable from BOTH the run-rate row and a parent DEAL", () => {
  // The set the business tracks by hand. Whichever tier places the row — the run-rate date window or
  // its parent DEAL — has to be able to supply all of them, or a row loses the field purely because
  // of which tier matched. Both lists are asserted so dropping one from either side fails here.
  for (const col of [
    "CLIENT_NAME_IN_CONREP",
    "ENTITY",
    "FIFTYTWO_TENURE_RTO_LASTDATE",
    "FIFTYTWO_TENURE_CANDIDATE_STATUS",
    "RECRUITMENT_MENTOR",
    "SECONDARY_RECRUITER",
    "ST_DT_PUSHBACK_REASON",
    "CLIENT_RECRUITER",
    "INVOICE_CYCLE_TO_CLIENT",
    "CLIENT_PAYMENT_TERMS",
    "CANDIDATE_PAYMENT_TERMS",
    "BACKOUT_OR_TERMINATION",
    "COMMENTS",
  ]) {
    assert.ok(
      EXTENSION_RUNRATE_MANUAL_COLUMNS.includes(col),
      `${col} is inheritable from the matched run-rate row`
    );
    assert.ok(
      EXTENSION_PARENT_DEAL_INHERIT_COLUMNS.includes(col),
      `${col} is inheritable from the parent DEAL`
    );
  }
});

test("EXTENSION_PARENT_DEAL_INHERIT_COLUMNS includes hierarchy and ops fields but not assignment recruiter", () => {
  assert.equal(EXTENSION_PARENT_DEAL_INHERIT_COLUMNS.includes("TEAM_LEAD_EMP_NO"), true);
  assert.equal(EXTENSION_PARENT_DEAL_INHERIT_COLUMNS.includes("NEW_HIRE_DATE"), true);
  assert.equal(EXTENSION_PARENT_DEAL_INHERIT_COLUMNS.includes("CLIENT_RECRUITER"), true);
  assert.equal(EXTENSION_PARENT_DEAL_INHERIT_COLUMNS.includes("PRIMARY_SALES_PERSON"), true);
  assert.equal(EXTENSION_PARENT_DEAL_INHERIT_COLUMNS.includes("SECONDARY_SALES_PERSON"), true);
  assert.equal(EXTENSION_PARENT_DEAL_INHERIT_COLUMNS.includes("RECRUITMENT_MENTOR"), true);
  assert.equal(EXTENSION_PARENT_DEAL_INHERIT_COLUMNS.includes("INVOICE_CYCLE_TO_CLIENT"), true);
  assert.equal(EXTENSION_PARENT_DEAL_INHERIT_COLUMNS.includes("CLIENT_PAYMENT_TERMS"), true);
  assert.equal(EXTENSION_PARENT_DEAL_INHERIT_COLUMNS.includes("CANDIDATE_PAYMENT_TERMS"), true);
  assert.equal(EXTENSION_PARENT_DEAL_INHERIT_COLUMNS.includes("ASSIGNMENT_RECRUITER"), false);
  assert.equal(EXTENSION_PARENT_DEAL_INHERIT_COLUMNS.includes("RECRUITER_ID"), false);
  assert.equal(EXTENSION_PARENT_DEAL_INHERIT_COLUMNS.includes("RECRUITER_CLUSTER_REGION"), false);
});

test("rowNeedsExtensionInsertBackfill: EXTENSION rows with PLACEMENT_ID qualify even when CONTRACT_ID is set", () => {
  const base = {
    DEAL_TYPE: "EXTENSION",
    CONTRACT_ID: "CHC1001",
    CANDIDATE_ID: 123,
    PLACEMENT_ID: 456,
  };
  assert.equal(rowNeedsExtensionInsertBackfill(base), true);
  assert.equal(rowNeedsExtensionRunrateBackfill(base), true);
  assert.equal(rowNeedsExtensionInsertBackfill({ ...base, DEAL_TYPE: "DEAL" }), false);
  assert.equal(rowNeedsExtensionInsertBackfill({ ...base, CANDIDATE_ID: null }), false);
  assert.equal(rowNeedsExtensionInsertBackfill({ ...base, PLACEMENT_ID: null }), false);
  assert.equal(rowNeedsExtensionInsertBackfill(null), false);
});

test("rowNeedsExtensionInsertBackfill: carried-forward update-append is never re-backfilled — protects a MOVE-vacated hierarchy field from flapping", () => {
  const base = {
    DEAL_TYPE: "EXTENSION",
    CANDIDATE_ID: 123,
    PLACEMENT_ID: 456,
  };
  assert.equal(rowNeedsExtensionInsertBackfill(base), true);
  assert.equal(rowNeedsExtensionInsertBackfill({ ...base, __CARRIED_FORWARD_UPDATE: true }), false);
});

test("applyExtensionInheritForInsertRows fills from parent DEAL even when CONTRACT_ID is already set", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      CONTRACT_ID: "CHC1001",
      CANDIDATE_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
      INITIAL_START_DATE: null,
      NEW_HIRE_DATE: null,
      TEAM_LEAD_EMP_NO: null,
      ASSIGNMENT_RECRUITER: "Current Recruiter",
      ASSIGNMENT_RECRUITER_EMAIL: "current.recruiter@cynetcorp.com",
    },
  ];

  let runrateFetchCalled = false;
  const parentFetchFn = async () =>
    new Map([
      [
        "999",
        {
          INITIAL_START_DATE: "2025-05-27",
          NEW_HIRE_DATE: "2025-04-16T00:00:00.000Z",
          TEAM_LEAD: "Jane Doe",
          TEAM_LEAD_EMP_NO: "EMP-TL-1",
        },
      ],
    ]);
  const runrateFetchFn = async () => {
    runrateFetchCalled = true;
    return new Map();
  };

  const out = await applyExtensionInheritForInsertRows(rows, {}, {
    parentFetchFn,
    priorExtensionFetchFn: noPriorExtensionFetch,
    runrateFetchFn,
    resolveContractIdsFn: noContractIdResolution,
  });

  assert.equal(out[0].CONTRACT_ID, "CHC1001");
  assert.equal(out[0].INITIAL_START_DATE, "2025-05-27");
  assert.equal(out[0].NEW_HIRE_DATE, "2025-04-16T00:00:00.000Z");
  assert.equal(out[0].TEAM_LEAD, "Jane Doe");
  assert.equal(out[0].TEAM_LEAD_EMP_NO, "EMP-TL-1");
  assert.equal(out[0].ASSIGNMENT_RECRUITER, "Current Recruiter");
  assert.equal(runrateFetchCalled, true);
});

test("applyExtensionInheritForInsertRows applies parent DEAL before runrate fallback", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      CONTRACT_ID: null,
      CANDIDATE_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
      INITIAL_START_DATE: null,
      NEW_HIRE_DATE: null,
      TEAM_LEAD: null,
    },
  ];

  const parentFetchFn = async () =>
    new Map([["999", { INITIAL_START_DATE: "2025-05-27", NEW_HIRE_DATE: "2025-04-16T00:00:00.000Z" }]]);
  const runrateFetchFn = async () =>
    new Map([
      [
        "999",
        {
          INITIAL_START_DATE: "2022-01-10",
          TEAM_LEAD: "Runrate Lead",
        },
      ],
    ]);

  const out = await applyExtensionInheritForInsertRows(rows, {}, {
    parentFetchFn,
    priorExtensionFetchFn: noPriorExtensionFetch,
    runrateFetchFn,
    resolveContractIdsFn: noContractIdResolution,
  });

  assert.equal(out[0].INITIAL_START_DATE, "2025-05-27");
  assert.equal(out[0].NEW_HIRE_DATE, "2025-04-16T00:00:00.000Z");
  assert.equal(out[0].TEAM_LEAD, "Runrate Lead");
});

test("applyExtensionInheritForInsertRows: prior-extension tier wins over runrate when no parent DEAL exists (dates/SKU/CONTRACT_ID from prior extension, not runrate)", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      CONTRACT_ID: null,
      CANDIDATE_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
      INITIAL_START_DATE: null,
      NEW_HIRE_DATE: null,
      SKU_NUMBER: null,
      TEAM_LEAD: null,
    },
  ];

  const priorExtensionFetchFn = async () =>
    new Map([
      [
        "999",
        {
          CONTRACT_ID: "CHC1235",
          INITIAL_START_DATE: "2022-03-01",
          NEW_HIRE_DATE: "2022-03-01T00:00:00.000Z",
          SKU_NUMBER: "SKU-FROM-PRIOR-EXT",
          TEAM_LEAD: "Latest Extension Lead",
        },
      ],
    ]);
  let runrateFetchCalled = false;
  const runrateFetchFn = async () => {
    runrateFetchCalled = true;
    return new Map([
      [
        "999",
        {
          INITIAL_START_DATE: "1999-01-01",
          NEW_HIRE_DATE: "1999-01-01T00:00:00.000Z",
          SKU_NUMBER: "SKU-FROM-RUNRATE-SHOULD-NOT-WIN",
          TEAM_LEAD: "Runrate Lead Should Not Win",
        },
      ],
    ]);
  };

  const out = await applyExtensionInheritForInsertRows(rows, {}, {
    parentFetchFn: noParentFetch,
    priorExtensionFetchFn,
    runrateFetchFn,
    resolveContractIdsFn: noContractIdResolution,
  });

  assert.equal(out[0].CONTRACT_ID, "CHC1235");
  assert.equal(out[0].INITIAL_START_DATE, "2022-03-01");
  assert.equal(out[0].NEW_HIRE_DATE, "2022-03-01T00:00:00.000Z");
  assert.equal(out[0].SKU_NUMBER, "SKU-FROM-PRIOR-EXT");
  assert.equal(out[0].TEAM_LEAD, "Latest Extension Lead");
  // runrate is still queried (unconditionally, like parent), but never overwrites what prior-extension already filled
  assert.equal(runrateFetchCalled, true);
});

test("applyExtensionInheritForInsertRows: parent DEAL still wins over prior-extension tier", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      CONTRACT_ID: null,
      CANDIDATE_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
      INITIAL_START_DATE: null,
      TEAM_LEAD: null,
    },
  ];

  const parentFetchFn = async () =>
    new Map([["999", { INITIAL_START_DATE: "2025-05-27", TEAM_LEAD: "Parent Deal Lead" }]]);
  const priorExtensionFetchFn = async () =>
    new Map([["999", { INITIAL_START_DATE: "2022-03-01", TEAM_LEAD: "Prior Extension Lead" }]]);

  const out = await applyExtensionInheritForInsertRows(rows, {}, {
    parentFetchFn,
    priorExtensionFetchFn,
    runrateFetchFn: noParentFetch,
    resolveContractIdsFn: noContractIdResolution,
  });

  assert.equal(out[0].INITIAL_START_DATE, "2025-05-27");
  assert.equal(out[0].TEAM_LEAD, "Parent Deal Lead");
});

test("applyExtensionInheritForInsertRows: prior-extension tier never overwrites an already-set value", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      CONTRACT_ID: "CHC-ALREADY-SET",
      CANDIDATE_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
      INITIAL_START_DATE: "2020-01-01",
      SKU_NUMBER: null,
    },
  ];

  const priorExtensionFetchFn = async () =>
    new Map([
      [
        "999",
        {
          CONTRACT_ID: "CHC1235",
          INITIAL_START_DATE: "2022-03-01",
          SKU_NUMBER: "SKU-FROM-PRIOR-EXT",
        },
      ],
    ]);

  const out = await applyExtensionInheritForInsertRows(rows, {}, {
    parentFetchFn: noParentFetch,
    priorExtensionFetchFn,
    runrateFetchFn: noParentFetch,
    resolveContractIdsFn: noContractIdResolution,
  });

  assert.equal(out[0].CONTRACT_ID, "CHC-ALREADY-SET");
  assert.equal(out[0].INITIAL_START_DATE, "2020-01-01");
  assert.equal(out[0].SKU_NUMBER, "SKU-FROM-PRIOR-EXT");
});

test("applyExtensionInheritForInsertRows fills empty date/hierarchy fields from the matched runrate row", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      CONTRACT_ID: null,
      CANDIDATE_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
      INITIAL_START_DATE: null,
      NEW_HIRE_DATE: null,
      TEAM_LEAD: null,
      ASSIGNMENT_RECRUITER: "Current Recruiter",
      ASSIGNMENT_RECRUITER_EMAIL: "current.recruiter@cynetcorp.com",
    },
  ];

  const runrateFetchFn = async (eligible) => {
    assert.equal(eligible.length, 1);
    assert.equal(eligible[0].PLACEMENT_ID, 999);
    return new Map([
      [
        "999",
        {
          INITIAL_START_DATE: "2022-01-10",
          NEW_HIRE_DATE: "2022-01-10T00:00:00.000Z",
          TEAM_LEAD: "Jane Doe",
          ATL: "John Smith",
          ASSIGNMENT_RECRUITER: "Historical Recruiter Should Not Apply",
        },
      ],
    ]);
  };

  const out = await applyExtensionInheritForInsertRows(rows, {}, {
    parentFetchFn: noParentFetch,
    priorExtensionFetchFn: noPriorExtensionFetch,
    runrateFetchFn,
    resolveContractIdsFn: noContractIdResolution,
  });
  assert.equal(out[0].INITIAL_START_DATE, "2022-01-10");
  assert.equal(out[0].NEW_HIRE_DATE, "2022-01-10T00:00:00.000Z");
  assert.equal(out[0].TEAM_LEAD, "Jane Doe");
  assert.equal(out[0].ATL, "John Smith");
  assert.equal(out[0].ASSIGNMENT_RECRUITER, "Current Recruiter");
  assert.equal(out[0].ASSIGNMENT_RECRUITER_EMAIL, "current.recruiter@cynetcorp.com");
});

test("applyExtensionInheritForInsertRows fills empty sales/credentialing/payment fields from runrate", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      CONTRACT_ID: null,
      CANDIDATE_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
      CLIENT_RECRUITER: null,
      CREDENTIALING_SPECIALIST: null,
      CREDENTIALING_LEAD: null,
      PRIMARY_SALES_PERSON: null,
      SECONDARY_SALES_PERSON: null,
      RECRUITMENT_MENTOR: null,
      INVOICE_CYCLE_TO_CLIENT: null,
      CLIENT_PAYMENT_TERMS: null,
      CANDIDATE_PAYMENT_TERMS: null,
      SECONDARY_RECRUITER: null,
      SECONDARY_RECRUITER_EMP_NO: null,
    },
  ];

  const runrateFetchFn = async () =>
    new Map([
      [
        "999",
        {
          CLIENT_RECRUITER: "Client Rec",
          CREDENTIALING_SPECIALIST: "Cred Spec",
          CREDENTIALING_LEAD: "Cred Lead",
          PRIMARY_SALES_PERSON: "Primary Sales",
          SECONDARY_SALES_PERSON: "Secondary Sales",
          RECRUITMENT_MENTOR: "Mentor",
          INVOICE_CYCLE_TO_CLIENT: "Net 30",
          CLIENT_PAYMENT_TERMS: "Net 45",
          CANDIDATE_PAYMENT_TERMS: "Weekly",
          SECONDARY_RECRUITER: "Sec Rec",
          SECONDARY_RECRUITER_EMP_NO: "CY9999",
        },
      ],
    ]);

  const out = await applyExtensionInheritForInsertRows(rows, {}, {
    parentFetchFn: noParentFetch,
    priorExtensionFetchFn: noPriorExtensionFetch,
    runrateFetchFn,
    resolveContractIdsFn: noContractIdResolution,
  });

  assert.equal(out[0].CLIENT_RECRUITER, "Client Rec");
  assert.equal(out[0].CREDENTIALING_SPECIALIST, "Cred Spec");
  assert.equal(out[0].CREDENTIALING_LEAD, "Cred Lead");
  assert.equal(out[0].PRIMARY_SALES_PERSON, "Primary Sales");
  assert.equal(out[0].SECONDARY_SALES_PERSON, "Secondary Sales");
  assert.equal(out[0].RECRUITMENT_MENTOR, "Mentor");
  assert.equal(out[0].INVOICE_CYCLE_TO_CLIENT, "Net 30");
  assert.equal(out[0].CLIENT_PAYMENT_TERMS, "Net 45");
  assert.equal(out[0].CANDIDATE_PAYMENT_TERMS, "Weekly");
  assert.equal(out[0].SECONDARY_RECRUITER, "Sec Rec");
  assert.equal(out[0].SECONDARY_RECRUITER_EMP_NO, "CY9999");
});

test("applyExtensionInheritForInsertRows does not overwrite non-empty manual ops fields from runrate", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      CONTRACT_ID: null,
      CANDIDATE_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
      CLIENT_RECRUITER: "Keep Me",
      PRIMARY_SALES_PERSON: "Keep Sales",
      SECONDARY_RECRUITER: "Keep Sec",
    },
  ];

  const runrateFetchFn = async () =>
    new Map([
      [
        "999",
        {
          CLIENT_RECRUITER: "Runrate Rec",
          PRIMARY_SALES_PERSON: "Runrate Sales",
          SECONDARY_RECRUITER: "Runrate Sec",
          CREDENTIALING_LEAD: "Fill Empty",
        },
      ],
    ]);

  const out = await applyExtensionInheritForInsertRows(rows, {}, {
    parentFetchFn: noParentFetch,
    priorExtensionFetchFn: noPriorExtensionFetch,
    runrateFetchFn,
    resolveContractIdsFn: noContractIdResolution,
  });

  assert.equal(out[0].CLIENT_RECRUITER, "Keep Me");
  assert.equal(out[0].PRIMARY_SALES_PERSON, "Keep Sales");
  assert.equal(out[0].SECONDARY_RECRUITER, "Keep Sec");
  assert.equal(out[0].CREDENTIALING_LEAD, "Fill Empty");
});

test("applyExtensionInheritForInsertRows: parent DEAL manual ops win over runrate", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      CONTRACT_ID: null,
      CANDIDATE_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
      CLIENT_RECRUITER: null,
      PRIMARY_SALES_PERSON: null,
      INVOICE_CYCLE_TO_CLIENT: null,
    },
  ];

  const parentFetchFn = async () =>
    new Map([
      [
        "999",
        {
          CLIENT_RECRUITER: "Parent Client Rec",
          PRIMARY_SALES_PERSON: "Parent Sales",
        },
      ],
    ]);
  const runrateFetchFn = async () =>
    new Map([
      [
        "999",
        {
          CLIENT_RECRUITER: "Runrate Client Rec",
          PRIMARY_SALES_PERSON: "Runrate Sales",
          INVOICE_CYCLE_TO_CLIENT: "Net 15",
        },
      ],
    ]);

  const out = await applyExtensionInheritForInsertRows(rows, {}, {
    parentFetchFn,
    priorExtensionFetchFn: noPriorExtensionFetch,
    runrateFetchFn,
    resolveContractIdsFn: noContractIdResolution,
  });

  assert.equal(out[0].CLIENT_RECRUITER, "Parent Client Rec");
  assert.equal(out[0].PRIMARY_SALES_PERSON, "Parent Sales");
  assert.equal(out[0].INVOICE_CYCLE_TO_CLIENT, "Net 15");
});

test("applyExtensionInheritForInsertRows also merges runrate-matched hierarchy *_EMP_NO fields (read straight from the run-rate table's own *_EMP_NO columns)", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      CONTRACT_ID: null,
      CANDIDATE_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
      TEAM_LEAD: null,
      TEAM_LEAD_EMP_NO: null,
      RM: null,
      RM_EMP_NO: "Already Set Manually",
    },
  ];

  const runrateFetchFn = async () =>
    new Map([
      [
        "999",
        {
          TEAM_LEAD: "Ajay Kumar",
          TEAM_LEAD_EMP_NO: "CY2393",
          RM: "Ajay Kumar",
          RM_EMP_NO: "CY2393",
        },
      ],
    ]);

  const out = await applyExtensionInheritForInsertRows(rows, {}, {
    parentFetchFn: noParentFetch,
    priorExtensionFetchFn: noPriorExtensionFetch,
    runrateFetchFn,
    resolveContractIdsFn: noContractIdResolution,
  });
  assert.equal(out[0].TEAM_LEAD, "Ajay Kumar");
  assert.equal(out[0].TEAM_LEAD_EMP_NO, "CY2393");
  assert.equal(out[0].RM, "Ajay Kumar");
  assert.equal(out[0].RM_EMP_NO, "Already Set Manually");
});

test("applyExtensionInheritForInsertRows backfills SKU_NUMBER: parent DEAL wins, else runrate match", async () => {
  const rows = [
    // parent DEAL provides SKU -> parent wins over runrate
    { DEAL_TYPE: "EXTENSION", CONTRACT_ID: null, CANDIDATE_ID: 1, CLIENT_ID: 5, PLACEMENT_ID: 111, SKU_NUMBER: null },
    // no parent match -> runrate SKU used
    { DEAL_TYPE: "EXTENSION", CONTRACT_ID: null, CANDIDATE_ID: 2, CLIENT_ID: 6, PLACEMENT_ID: 222, SKU_NUMBER: null },
    // already set -> untouched
    { DEAL_TYPE: "EXTENSION", CONTRACT_ID: null, CANDIDATE_ID: 3, CLIENT_ID: 7, PLACEMENT_ID: 333, SKU_NUMBER: "SKU-EXISTING" },
  ];
  const parentFetchFn = async () => new Map([["111", { SKU_NUMBER: "SKU-FROM-PARENT" }]]);
  const runrateFetchFn = async () =>
    new Map([
      ["111", { SKU_NUMBER: "SKU-FROM-RUNRATE-111" }],
      ["222", { SKU_NUMBER: "SKU-FROM-RUNRATE-222" }],
      ["333", { SKU_NUMBER: "SKU-FROM-RUNRATE-333" }],
    ]);

  const out = await applyExtensionInheritForInsertRows(rows, {}, {
    parentFetchFn,
    priorExtensionFetchFn: noPriorExtensionFetch,
    runrateFetchFn,
    resolveContractIdsFn: noContractIdResolution,
  });
  assert.equal(out[0].SKU_NUMBER, "SKU-FROM-PARENT");        // parent DEAL wins
  assert.equal(out[1].SKU_NUMBER, "SKU-FROM-RUNRATE-222");   // runrate fallback
  assert.equal(out[2].SKU_NUMBER, "SKU-EXISTING");           // never overwritten
});

test("applyExtensionInheritForInsertRows never overwrites an existing value", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      CONTRACT_ID: null,
      CANDIDATE_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
      INITIAL_START_DATE: "2019-06-01",
      NEW_HIRE_DATE: null,
      TEAM_LEAD: "Already Manually Set",
    },
  ];

  const runrateFetchFn = async () =>
    new Map([
      [
        "999",
        {
          INITIAL_START_DATE: "2022-01-10",
          NEW_HIRE_DATE: "2022-01-10T00:00:00.000Z",
          TEAM_LEAD: "Jane Doe",
        },
      ],
    ]);

  const out = await applyExtensionInheritForInsertRows(rows, {}, {
    parentFetchFn: noParentFetch,
    priorExtensionFetchFn: noPriorExtensionFetch,
    runrateFetchFn,
    resolveContractIdsFn: noContractIdResolution,
  });
  assert.equal(out[0].INITIAL_START_DATE, "2019-06-01");
  assert.equal(out[0].TEAM_LEAD, "Already Manually Set");
  assert.equal(out[0].NEW_HIRE_DATE, "2022-01-10T00:00:00.000Z");
});

test("applyExtensionInheritForInsertRows skips non-EXTENSION rows", async () => {
  const rows = [
    { DEAL_TYPE: "DEAL", CONTRACT_ID: null, CANDIDATE_ID: 1, PLACEMENT_ID: 1, INITIAL_START_DATE: null },
    { DEAL_TYPE: "EXTENSION", CONTRACT_ID: "CHC1001", CANDIDATE_ID: 2, CLIENT_ID: 9, PLACEMENT_ID: 2, INITIAL_START_DATE: null },
  ];
  let parentFetchCalled = false;
  let runrateFetchCalled = false;
  const parentFetchFn = async (eligible) => {
    parentFetchCalled = true;
    assert.equal(eligible.length, 1);
    assert.equal(eligible[0].PLACEMENT_ID, 2);
    return new Map([["2", { INITIAL_START_DATE: "2024-01-01" }]]);
  };
  const runrateFetchFn = async () => {
    runrateFetchCalled = true;
    return new Map();
  };
  const out = await applyExtensionInheritForInsertRows(rows, {}, { parentFetchFn, runrateFetchFn, priorExtensionFetchFn: noPriorExtensionFetch });
  assert.equal(parentFetchCalled, true);
  assert.equal(runrateFetchCalled, true);
  assert.equal(out[0].INITIAL_START_DATE, null);
  assert.equal(out[1].INITIAL_START_DATE, "2024-01-01");
});

test("applyExtensionInheritForInsertRows is a no-op when nothing matches (resolveContractIdsFn never called)", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      CONTRACT_ID: null,
      CANDIDATE_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
      INITIAL_START_DATE: null,
    },
  ];
  let resolveCalled = false;
  const runrateFetchFn = async () => new Map();
  const resolveContractIdsFn = async () => {
    resolveCalled = true;
    return new Map();
  };
  const out = await applyExtensionInheritForInsertRows(rows, {}, {
    parentFetchFn: noParentFetch,
    priorExtensionFetchFn: noPriorExtensionFetch,
    runrateFetchFn,
    resolveContractIdsFn,
  });
  assert.equal(out[0].INITIAL_START_DATE, null);
  assert.equal(resolveCalled, false);
});

test("applyExtensionInheritForInsertRows fills CONTRACT_ID from resolveContractIdsFn only for matched rows", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      CONTRACT_ID: null,
      CANDIDATE_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
      INITIAL_START_DATE: null,
    },
    {
      DEAL_TYPE: "EXTENSION",
      CONTRACT_ID: null,
      CANDIDATE_ID: 222,
      CLIENT_ID: 66,
      PLACEMENT_ID: 888,
      INITIAL_START_DATE: null,
    },
  ];

  const runrateFetchFn = async () => new Map([["999", { INITIAL_START_DATE: "2022-01-10" }]]);
  let receivedPlacementIds = null;
  const resolveContractIdsFn = async (matchedRows) => {
    receivedPlacementIds = matchedRows.map((r) => r.PLACEMENT_ID);
    return new Map([["999", "CHC1234"]]);
  };

  const out = await applyExtensionInheritForInsertRows(rows, {}, {
    parentFetchFn: noParentFetch,
    priorExtensionFetchFn: noPriorExtensionFetch,
    runrateFetchFn,
    resolveContractIdsFn,
  });
  assert.deepEqual(receivedPlacementIds, [999]);
  assert.equal(out[0].CONTRACT_ID, "CHC1234");
  assert.equal(out[1].CONTRACT_ID, null);
});

test("applyExtensionRunrateBackfillForInsertRows remains an alias for applyExtensionInheritForInsertRows", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      CONTRACT_ID: "CHC1001",
      CANDIDATE_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
      INITIAL_START_DATE: null,
    },
  ];
  const parentFetchFn = async () => new Map([["999", { INITIAL_START_DATE: "2025-05-27" }]]);
  const out = await applyExtensionRunrateBackfillForInsertRows(rows, {}, {
    parentFetchFn,
    priorExtensionFetchFn: noPriorExtensionFetch,
    runrateFetchFn: noParentFetch,
    resolveContractIdsFn: noContractIdResolution,
  });
  assert.equal(out[0].INITIAL_START_DATE, "2025-05-27");
});

// CONTRACT_ID is minted for DEAL_TYPE='DEAL' rows only (Aug 2026). A run-rate-matched EXTENSION can
// REUSE an id from a prior row of the same candidate+client identity, but must never get a fresh
// one — an EXTENSION with no originating DEAL is left null until its parent DEAL lands.
test("resolveContractIdsForRunrateMatchedExtensions reuses an existing CONTRACT_ID", async () => {
  const rows = [
    { PLACEMENT_ID: 1, CANDIDATE_ID: 111, CLIENT_ID: 55, CANDIDATE_EMAIL: "a@x.com", START_DATE: "2024-01-01" },
    { PLACEMENT_ID: 2, CANDIDATE_ID: 222, CLIENT_ID: 66, CANDIDATE_EMAIL: "b@x.com", START_DATE: "2024-02-01" },
  ];

  const fetchContractIdsForExtensionsFn = async (lookupInput, opts) => {
    assert.equal(opts.includeExtensionSource, true);
    assert.equal(lookupInput.length, 2);
    return new Map([["1", "CHC5000"]]);
  };

  const out = await resolveContractIdsForRunrateMatchedExtensions(
    rows,
    { tableId: "cynet_health_deal_sheet" },
    { fetchContractIdsForExtensionsFn }
  );

  assert.equal(out.get("1"), "CHC5000");
  // Placement 2 had no prior id: left unresolved rather than freshly allocated.
  assert.equal(out.has("2"), false);
  assert.equal(out.size, 1);
});

test("resolveContractIdsForRunrateMatchedExtensions never allocates a fresh CONTRACT_ID", async () => {
  const rows = [
    { PLACEMENT_ID: 1, CANDIDATE_ID: 111, CLIENT_ID: 55, CANDIDATE_EMAIL: "a@x.com" },
    { PLACEMENT_ID: 2, CANDIDATE_ID: 222, CLIENT_ID: 66, CANDIDATE_EMAIL: "b@x.com" },
  ];
  // Nothing to reuse anywhere.
  const fetchContractIdsForExtensionsFn = async () => new Map();

  let allocateCalled = false;
  const allocateContractIdsFn = async () => {
    allocateCalled = true;
    return ["CHC9999"];
  };

  const out = await resolveContractIdsForRunrateMatchedExtensions(
    rows,
    { tableId: "cynet_health_deal_sheet" },
    { fetchContractIdsForExtensionsFn, allocateContractIdsFn }
  );

  assert.equal(out.size, 0);
  assert.equal(allocateCalled, false, "EXTENSION rows must never mint a CONTRACT_ID");
});

test("resolveContractIdsForRunrateMatchedExtensions returns empty when nothing matches, regardless of table", async () => {
  const rows = [{ PLACEMENT_ID: 1, CANDIDATE_ID: 111, CLIENT_ID: 55 }];
  const fetchContractIdsForExtensionsFn = async () => new Map();

  const out = await resolveContractIdsForRunrateMatchedExtensions(
    rows,
    { tableId: "cynet_locums_deal_sheet" },
    { fetchContractIdsForExtensionsFn }
  );

  assert.equal(out.size, 0);
});

// CONTRACT_ID is inherited from the matched run-rate row alongside SKU_NUMBER (Aug 2026) — both
// describe the same original contract chain. Nothing mints an id for an EXTENSION; a run-rate row
// with no CONTRACT_ID simply leaves the field null.
test("runrate tier inherits CONTRACT_ID together with SKU_NUMBER", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      CONTRACT_ID: null,
      SKU_NUMBER: null,
      CANDIDATE_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
    },
  ];

  const runrateFetchFn = async () =>
    new Map([["999", { CONTRACT_ID: "CHC4242", SKU_NUMBER: "SKU-9", INITIAL_START_DATE: "2022-01-10" }]]);

  const out = await applyExtensionInheritForInsertRows(rows, {}, {
    parentFetchFn: async () => new Map(),
    priorExtensionFetchFn: noPriorExtensionFetch,
    runrateFetchFn,
    resolveContractIdsFn: noContractIdResolution,
  });

  assert.equal(out[0].CONTRACT_ID, "CHC4242");
  assert.equal(out[0].SKU_NUMBER, "SKU-9");
});

test("runrate tier leaves CONTRACT_ID null when the matched row has none", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      CONTRACT_ID: null,
      SKU_NUMBER: null,
      CANDIDATE_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
    },
  ];

  // Sparsely populated run-rate row: SKU present, CONTRACT_ID absent.
  const runrateFetchFn = async () =>
    new Map([["999", { CONTRACT_ID: null, SKU_NUMBER: "SKU-9" }]]);

  const out = await applyExtensionInheritForInsertRows(rows, {}, {
    parentFetchFn: async () => new Map(),
    priorExtensionFetchFn: noPriorExtensionFetch,
    runrateFetchFn,
    resolveContractIdsFn: noContractIdResolution,
  });

  assert.equal(out[0].SKU_NUMBER, "SKU-9");
  assert.equal(out[0].CONTRACT_ID ?? null, null);
});

test("a parent DEAL's CONTRACT_ID outranks the runrate one", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      CONTRACT_ID: null,
      SKU_NUMBER: null,
      CANDIDATE_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
    },
  ];

  const parentFetchFn = async () => new Map([["999", { CONTRACT_ID: "CHC1000", SKU_NUMBER: "SKU-PARENT" }]]);
  const runrateFetchFn = async () =>
    new Map([["999", { CONTRACT_ID: "CHC4242", SKU_NUMBER: "SKU-RUNRATE" }]]);

  const out = await applyExtensionInheritForInsertRows(rows, {}, {
    parentFetchFn,
    priorExtensionFetchFn: noPriorExtensionFetch,
    runrateFetchFn,
    resolveContractIdsFn: noContractIdResolution,
  });

  assert.equal(out[0].CONTRACT_ID, "CHC1000");
  assert.equal(out[0].SKU_NUMBER, "SKU-PARENT");
});

test("an already-set CONTRACT_ID is never overwritten by the runrate tier", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      CONTRACT_ID: "CHC7777",
      CANDIDATE_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
    },
  ];

  const runrateFetchFn = async () => new Map([["999", { CONTRACT_ID: "CHC4242" }]]);

  const out = await applyExtensionInheritForInsertRows(rows, {}, {
    parentFetchFn: async () => new Map(),
    priorExtensionFetchFn: noPriorExtensionFetch,
    runrateFetchFn,
    resolveContractIdsFn: noContractIdResolution,
  });

  assert.equal(out[0].CONTRACT_ID, "CHC7777");
});

// ---------------------------------------------------------------------------
// SKU_NUMBER on DID NOT START / DID NOT ACCEPT extensions
//
// A placement that never became a working assignment must not carry a SKU_NUMBER, whichever inherit
// source supplied it (parent DEAL, prior EXTENSION, or run-rate). CONTRACT_ID still comes across —
// that identifies the contract chain, which the row does belong to.
// ---------------------------------------------------------------------------

function extensionRow(overrides = {}) {
  return {
    DEAL_TYPE: "EXTENSION",
    PLACEMENT_STATUS: "STARTED",
    CONTRACT_ID: null,
    SKU_NUMBER: null,
    CANDIDATE_ID: 111,
    CLIENT_ID: 55,
    PLACEMENT_ID: 999,
    INITIAL_START_DATE: null,
    NEW_HIRE_DATE: null,
    ...overrides,
  };
}

for (const status of ["DID NOT START", "DID NOT ACCEPT", "did not accept"]) {
  test(`applyExtensionInheritForInsertRows: "${status}" extension takes CONTRACT_ID but no SKU_NUMBER`, async () => {
    const out = await applyExtensionInheritForInsertRows(
      [extensionRow({ PLACEMENT_STATUS: status })],
      {},
      {
        parentFetchFn: async () =>
          new Map([["999", { CONTRACT_ID: "CHC21351", SKU_NUMBER: "H14672" }]]),
        priorExtensionFetchFn: noPriorExtensionFetch,
        runrateFetchFn: async () => new Map(),
        resolveContractIdsFn: noContractIdResolution,
      }
    );
    assert.equal(out[0].CONTRACT_ID, "CHC21351");
    assert.equal(out[0].SKU_NUMBER, null);
  });
}

test("applyExtensionInheritForInsertRows: a started extension still inherits SKU_NUMBER", async () => {
  const out = await applyExtensionInheritForInsertRows(
    [extensionRow({ PLACEMENT_STATUS: "STARTED" })],
    {},
    {
      parentFetchFn: async () =>
        new Map([["999", { CONTRACT_ID: "CHC21351", SKU_NUMBER: "H14672" }]]),
      priorExtensionFetchFn: noPriorExtensionFetch,
      runrateFetchFn: async () => new Map(),
      resolveContractIdsFn: noContractIdResolution,
    }
  );
  assert.equal(out[0].SKU_NUMBER, "H14672");
});

test("applyExtensionInheritForInsertRows: run-rate SKU is also blocked on DID NOT START", async () => {
  const out = await applyExtensionInheritForInsertRows(
    [extensionRow({ PLACEMENT_STATUS: "DID NOT START" })],
    {},
    {
      parentFetchFn: async () => new Map(),
      priorExtensionFetchFn: noPriorExtensionFetch,
      runrateFetchFn: async () =>
        new Map([["999", { CONTRACT_ID: "CHC19505", SKU_NUMBER: "H13412" }]]),
      resolveContractIdsFn: noContractIdResolution,
    }
  );
  assert.equal(out[0].CONTRACT_ID, "CHC19505");
  assert.equal(out[0].SKU_NUMBER, null);
});

test("applyExtensionInheritForInsertRows: prior-extension SKU is also blocked on DID NOT ACCEPT", async () => {
  const out = await applyExtensionInheritForInsertRows(
    [extensionRow({ PLACEMENT_STATUS: "DID NOT ACCEPT" })],
    {},
    {
      parentFetchFn: async () => new Map(),
      priorExtensionFetchFn: async () =>
        new Map([["999", { CONTRACT_ID: "CHC21351", SKU_NUMBER: "H14672" }]]),
      runrateFetchFn: async () => new Map(),
      resolveContractIdsFn: noContractIdResolution,
    }
  );
  assert.equal(out[0].CONTRACT_ID, "CHC21351");
  assert.equal(out[0].SKU_NUMBER, null);
});

test("applyExtensionInheritForInsertRows: a SKU already on the row is never cleared", async () => {
  const out = await applyExtensionInheritForInsertRows(
    [extensionRow({ PLACEMENT_STATUS: "DID NOT START", SKU_NUMBER: "H99999" })],
    {},
    {
      parentFetchFn: async () =>
        new Map([["999", { CONTRACT_ID: "CHC21351", SKU_NUMBER: "H14672" }]]),
      priorExtensionFetchFn: noPriorExtensionFetch,
      runrateFetchFn: async () => new Map(),
      resolveContractIdsFn: noContractIdResolution,
    }
  );
  assert.equal(out[0].SKU_NUMBER, "H99999");
});

// The clear only removes a SKU this run inherited — it never touches one already on the row. That is
// what protects the real sequence: a BOOKED row gets SKU H14672, the placement later flips to DID NOT
// START, and the update-append carries H14672 forward. Nulling it there would lose a SKU the
// assignment genuinely earned while it was live.
test("applyExtensionInheritForInsertRows: an update-append keeps a SKU earned while BOOKED", async () => {
  const out = await applyExtensionInheritForInsertRows(
    [extensionRow({
      PLACEMENT_STATUS: "DID NOT START",
      CONTRACT_ID: "CHC21351",
      SKU_NUMBER: "H14672",
      __CARRIED_FORWARD_UPDATE: true,
    })],
    {},
    {
      parentFetchFn: async () => new Map(),
      priorExtensionFetchFn: noPriorExtensionFetch,
      runrateFetchFn: async () => new Map(),
      resolveContractIdsFn: noContractIdResolution,
    }
  );
  assert.equal(out[0].SKU_NUMBER, "H14672");
});

test("applyExtensionInheritForInsertRows: an existing SKU wins over an inherit source offering another", async () => {
  const out = await applyExtensionInheritForInsertRows(
    [extensionRow({ PLACEMENT_STATUS: "DID NOT START", SKU_NUMBER: "H14672" })],
    {},
    {
      parentFetchFn: async () => new Map([["999", { SKU_NUMBER: "H00000" }]]),
      priorExtensionFetchFn: noPriorExtensionFetch,
      runrateFetchFn: async () => new Map(),
      resolveContractIdsFn: noContractIdResolution,
    }
  );
  assert.equal(out[0].SKU_NUMBER, "H14672");
});

test("parent DEAL hierarchy overwrites a stale name Nexus carried over from an earlier contract", async () => {
  // Rabia Rawji (Aug 2026): EXTENSION 5248970 of CHC22062 arrived from Nexus already carrying
  // ASSOCIATE_DELIVERY_DIRECTOR "Aniket Ahuja" — the director of her PREVIOUS contract CHC17277.
  // Its parent DEAL 5205159 (CHC22062) holds the correct "Kapil Chaudhary". Fill-if-empty skipped
  // the field because it was non-empty, so the stale name survived while CONTRACT_ID /
  // INITIAL_START_DATE (both empty) inherited correctly off the very same parent row.
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      CANDIDATE_ID: 25471544,
      CLIENT_ID: 1953556,
      PLACEMENT_ID: 1464468,
      CONTRACT_ID: null,
      INITIAL_START_DATE: null,
      ASSOCIATE_DELIVERY_DIRECTOR: "Aniket Ahuja",
      ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO: "CY2171",
      ASSIGNMENT_RECRUITER: "Varun Khandelwal (R1N)",
      ASSIGNMENT_RECRUITER_EMAIL: "varun.k@cynethealth.com",
    },
  ];

  const parentFetchFn = async () =>
    new Map([
      [
        "1464468",
        {
          CONTRACT_ID: "CHC22062",
          INITIAL_START_DATE: "2026-06-08",
          ASSOCIATE_DELIVERY_DIRECTOR: "Kapil Chaudhary",
          ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO: "CY3650",
        },
      ],
    ]);

  const out = await applyExtensionInheritForInsertRows(rows, {}, {
    parentFetchFn,
    priorExtensionFetchFn: noPriorExtensionFetch,
    runrateFetchFn: async () => new Map(),
    resolveContractIdsFn: noContractIdResolution,
  });

  assert.equal(out[0].ASSOCIATE_DELIVERY_DIRECTOR, "Kapil Chaudhary");
  assert.equal(out[0].ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO, "CY3650");
  // The fields that already worked must keep working.
  assert.equal(out[0].CONTRACT_ID, "CHC22062");
  assert.equal(out[0].INITIAL_START_DATE, "2026-06-08");
  // Non-hierarchy row data is untouched.
  assert.equal(out[0].ASSIGNMENT_RECRUITER, "Varun Khandelwal (R1N)");
});

test("parent DEAL hierarchy overwrite leaves the row alone when the parent has no hierarchy value", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      CANDIDATE_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
      CONTRACT_ID: null,
      ASSOCIATE_DELIVERY_DIRECTOR: "Existing Director",
      ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO: "CY-EXIST",
      ASSIGNMENT_RECRUITER_EMAIL: "current.recruiter@cynetcorp.com",
    },
  ];

  const parentFetchFn = async () =>
    new Map([
      ["999", { CONTRACT_ID: "CHC2002", ASSOCIATE_DELIVERY_DIRECTOR: null }],
    ]);

  const out = await applyExtensionInheritForInsertRows(rows, {}, {
    parentFetchFn,
    priorExtensionFetchFn: noPriorExtensionFetch,
    runrateFetchFn: async () => new Map(),
    resolveContractIdsFn: noContractIdResolution,
  });

  // A null/blank parent value must never blank out what the row already carries.
  assert.equal(out[0].ASSOCIATE_DELIVERY_DIRECTOR, "Existing Director");
  assert.equal(out[0].ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO, "CY-EXIST");
  assert.equal(out[0].CONTRACT_ID, "CHC2002");
});

test("prior-EXTENSION tier stays fill-if-empty and cannot overwrite parent DEAL hierarchy", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      CANDIDATE_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
      CONTRACT_ID: null,
      ASSOCIATE_DELIVERY_DIRECTOR: "Stale From Nexus",
      ASSIGNMENT_RECRUITER_EMAIL: "current.recruiter@cynetcorp.com",
    },
  ];

  const parentFetchFn = async () =>
    new Map([["999", { ASSOCIATE_DELIVERY_DIRECTOR: "Correct Parent Director" }]]);
  const priorExtensionFetchFn = async () =>
    new Map([["999", { ASSOCIATE_DELIVERY_DIRECTOR: "Older Extension Director" }]]);

  const out = await applyExtensionInheritForInsertRows(rows, {}, {
    parentFetchFn,
    priorExtensionFetchFn,
    runrateFetchFn: async () => new Map(),
    resolveContractIdsFn: noContractIdResolution,
  });

  // Parent DEAL wins outright; the prior-extension tier must not overwrite it afterwards.
  assert.equal(out[0].ASSOCIATE_DELIVERY_DIRECTOR, "Correct Parent Director");
});
