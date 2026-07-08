const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EXTENSION_RUNRATE_HIERARCHY_COLUMNS,
  EXTENSION_RUNRATE_ELIGIBLE_PLACEMENT_STATUSES,
  isExtensionRunrateEligiblePlacementStatus,
  buildRunrateEligiblePlacementStatusSqlPredicate,
  EXTENSION_PARENT_DEAL_INHERIT_COLUMNS,
  rowNeedsExtensionInsertBackfill,
  rowNeedsExtensionRunrateBackfill,
  applyExtensionInheritForInsertRows,
  applyExtensionRunrateBackfillForInsertRows,
  resolveContractIdsForRunrateMatchedExtensions,
} = require("./bigQueryClient");

const noContractIdResolution = async () => new Map();
const noParentFetch = async () => new Map();
const noPriorExtensionFetch = async () => new Map();

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

test("EXTENSION_RUNRATE_HIERARCHY_COLUMNS excludes recruiter identity fields", () => {
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

test("EXTENSION_PARENT_DEAL_INHERIT_COLUMNS includes hierarchy and *_EMP_NO but not recruiter identity", () => {
  assert.equal(EXTENSION_PARENT_DEAL_INHERIT_COLUMNS.includes("TEAM_LEAD_EMP_NO"), true);
  assert.equal(EXTENSION_PARENT_DEAL_INHERIT_COLUMNS.includes("NEW_HIRE_DATE"), true);
  assert.equal(EXTENSION_PARENT_DEAL_INHERIT_COLUMNS.includes("ASSIGNMENT_RECRUITER"), false);
  assert.equal(EXTENSION_PARENT_DEAL_INHERIT_COLUMNS.includes("RECRUITER_ID"), false);
});

test("rowNeedsExtensionInsertBackfill: EXTENSION rows with PLACEMENT_ID qualify even when CONTRACT_ID is set", () => {
  const base = {
    DEAL_TYPE: "EXTENSION",
    CONTRACT_ID: "CHC1001",
    CANDIDATE_NEXUS_ID: 123,
    PLACEMENT_ID: 456,
  };
  assert.equal(rowNeedsExtensionInsertBackfill(base), true);
  assert.equal(rowNeedsExtensionRunrateBackfill(base), true);
  assert.equal(rowNeedsExtensionInsertBackfill({ ...base, DEAL_TYPE: "DEAL" }), false);
  assert.equal(rowNeedsExtensionInsertBackfill({ ...base, CANDIDATE_NEXUS_ID: null }), false);
  assert.equal(rowNeedsExtensionInsertBackfill({ ...base, PLACEMENT_ID: null }), false);
  assert.equal(rowNeedsExtensionInsertBackfill(null), false);
});

test("rowNeedsExtensionInsertBackfill: carried-forward update-append is never re-backfilled — protects a MOVE-vacated hierarchy field from flapping", () => {
  const base = {
    DEAL_TYPE: "EXTENSION",
    CANDIDATE_NEXUS_ID: 123,
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
      CANDIDATE_NEXUS_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
      ORIGINAL_START_DATE: null,
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
          ORIGINAL_START_DATE: "2025-05-27",
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
  assert.equal(out[0].ORIGINAL_START_DATE, "2025-05-27");
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
      CANDIDATE_NEXUS_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
      ORIGINAL_START_DATE: null,
      NEW_HIRE_DATE: null,
      TEAM_LEAD: null,
    },
  ];

  const parentFetchFn = async () =>
    new Map([["999", { ORIGINAL_START_DATE: "2025-05-27", NEW_HIRE_DATE: "2025-04-16T00:00:00.000Z" }]]);
  const runrateFetchFn = async () =>
    new Map([
      [
        "999",
        {
          ORIGINAL_START_DATE: "2022-01-10",
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

  assert.equal(out[0].ORIGINAL_START_DATE, "2025-05-27");
  assert.equal(out[0].NEW_HIRE_DATE, "2025-04-16T00:00:00.000Z");
  assert.equal(out[0].TEAM_LEAD, "Runrate Lead");
});

test("applyExtensionInheritForInsertRows: prior-extension tier wins over runrate when no parent DEAL exists (dates/SKU/CONTRACT_ID from prior extension, not runrate)", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      CONTRACT_ID: null,
      CANDIDATE_NEXUS_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
      ORIGINAL_START_DATE: null,
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
          ORIGINAL_START_DATE: "2022-03-01",
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
          ORIGINAL_START_DATE: "1999-01-01",
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
  assert.equal(out[0].ORIGINAL_START_DATE, "2022-03-01");
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
      CANDIDATE_NEXUS_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
      ORIGINAL_START_DATE: null,
      TEAM_LEAD: null,
    },
  ];

  const parentFetchFn = async () =>
    new Map([["999", { ORIGINAL_START_DATE: "2025-05-27", TEAM_LEAD: "Parent Deal Lead" }]]);
  const priorExtensionFetchFn = async () =>
    new Map([["999", { ORIGINAL_START_DATE: "2022-03-01", TEAM_LEAD: "Prior Extension Lead" }]]);

  const out = await applyExtensionInheritForInsertRows(rows, {}, {
    parentFetchFn,
    priorExtensionFetchFn,
    runrateFetchFn: noParentFetch,
    resolveContractIdsFn: noContractIdResolution,
  });

  assert.equal(out[0].ORIGINAL_START_DATE, "2025-05-27");
  assert.equal(out[0].TEAM_LEAD, "Parent Deal Lead");
});

test("applyExtensionInheritForInsertRows: prior-extension tier never overwrites an already-set value", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      CONTRACT_ID: "CHC-ALREADY-SET",
      CANDIDATE_NEXUS_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
      ORIGINAL_START_DATE: "2020-01-01",
      SKU_NUMBER: null,
    },
  ];

  const priorExtensionFetchFn = async () =>
    new Map([
      [
        "999",
        {
          CONTRACT_ID: "CHC1235",
          ORIGINAL_START_DATE: "2022-03-01",
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
  assert.equal(out[0].ORIGINAL_START_DATE, "2020-01-01");
  assert.equal(out[0].SKU_NUMBER, "SKU-FROM-PRIOR-EXT");
});

test("applyExtensionInheritForInsertRows fills empty date/hierarchy fields from the matched runrate row", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      CONTRACT_ID: null,
      CANDIDATE_NEXUS_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
      ORIGINAL_START_DATE: null,
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
          ORIGINAL_START_DATE: "2022-01-10",
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
  assert.equal(out[0].ORIGINAL_START_DATE, "2022-01-10");
  assert.equal(out[0].NEW_HIRE_DATE, "2022-01-10T00:00:00.000Z");
  assert.equal(out[0].TEAM_LEAD, "Jane Doe");
  assert.equal(out[0].ATL, "John Smith");
  assert.equal(out[0].ASSIGNMENT_RECRUITER, "Current Recruiter");
  assert.equal(out[0].ASSIGNMENT_RECRUITER_EMAIL, "current.recruiter@cynetcorp.com");
});

test("applyExtensionInheritForInsertRows also merges runrate-matched hierarchy *_EMP_NO fields (read straight from the run-rate table's own *_EMP_NO columns)", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      CONTRACT_ID: null,
      CANDIDATE_NEXUS_ID: 111,
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
    { DEAL_TYPE: "EXTENSION", CONTRACT_ID: null, CANDIDATE_NEXUS_ID: 1, CLIENT_ID: 5, PLACEMENT_ID: 111, SKU_NUMBER: null },
    // no parent match -> runrate SKU used
    { DEAL_TYPE: "EXTENSION", CONTRACT_ID: null, CANDIDATE_NEXUS_ID: 2, CLIENT_ID: 6, PLACEMENT_ID: 222, SKU_NUMBER: null },
    // already set -> untouched
    { DEAL_TYPE: "EXTENSION", CONTRACT_ID: null, CANDIDATE_NEXUS_ID: 3, CLIENT_ID: 7, PLACEMENT_ID: 333, SKU_NUMBER: "SKU-EXISTING" },
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
      CANDIDATE_NEXUS_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
      ORIGINAL_START_DATE: "2019-06-01",
      NEW_HIRE_DATE: null,
      TEAM_LEAD: "Already Manually Set",
    },
  ];

  const runrateFetchFn = async () =>
    new Map([
      [
        "999",
        {
          ORIGINAL_START_DATE: "2022-01-10",
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
  assert.equal(out[0].ORIGINAL_START_DATE, "2019-06-01");
  assert.equal(out[0].TEAM_LEAD, "Already Manually Set");
  assert.equal(out[0].NEW_HIRE_DATE, "2022-01-10T00:00:00.000Z");
});

test("applyExtensionInheritForInsertRows skips non-EXTENSION rows", async () => {
  const rows = [
    { DEAL_TYPE: "DEAL", CONTRACT_ID: null, CANDIDATE_NEXUS_ID: 1, PLACEMENT_ID: 1, ORIGINAL_START_DATE: null },
    { DEAL_TYPE: "EXTENSION", CONTRACT_ID: "CHC1001", CANDIDATE_NEXUS_ID: 2, CLIENT_ID: 9, PLACEMENT_ID: 2, ORIGINAL_START_DATE: null },
  ];
  let parentFetchCalled = false;
  let runrateFetchCalled = false;
  const parentFetchFn = async (eligible) => {
    parentFetchCalled = true;
    assert.equal(eligible.length, 1);
    assert.equal(eligible[0].PLACEMENT_ID, 2);
    return new Map([["2", { ORIGINAL_START_DATE: "2024-01-01" }]]);
  };
  const runrateFetchFn = async () => {
    runrateFetchCalled = true;
    return new Map();
  };
  const out = await applyExtensionInheritForInsertRows(rows, {}, { parentFetchFn, runrateFetchFn, priorExtensionFetchFn: noPriorExtensionFetch });
  assert.equal(parentFetchCalled, true);
  assert.equal(runrateFetchCalled, true);
  assert.equal(out[0].ORIGINAL_START_DATE, null);
  assert.equal(out[1].ORIGINAL_START_DATE, "2024-01-01");
});

test("applyExtensionInheritForInsertRows is a no-op when nothing matches (resolveContractIdsFn never called)", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      CONTRACT_ID: null,
      CANDIDATE_NEXUS_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
      ORIGINAL_START_DATE: null,
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
  assert.equal(out[0].ORIGINAL_START_DATE, null);
  assert.equal(resolveCalled, false);
});

test("applyExtensionInheritForInsertRows fills CONTRACT_ID from resolveContractIdsFn only for matched rows", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      CONTRACT_ID: null,
      CANDIDATE_NEXUS_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
      ORIGINAL_START_DATE: null,
    },
    {
      DEAL_TYPE: "EXTENSION",
      CONTRACT_ID: null,
      CANDIDATE_NEXUS_ID: 222,
      CLIENT_ID: 66,
      PLACEMENT_ID: 888,
      ORIGINAL_START_DATE: null,
    },
  ];

  const runrateFetchFn = async () => new Map([["999", { ORIGINAL_START_DATE: "2022-01-10" }]]);
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
      CANDIDATE_NEXUS_ID: 111,
      CLIENT_ID: 55,
      PLACEMENT_ID: 999,
      ORIGINAL_START_DATE: null,
    },
  ];
  const parentFetchFn = async () => new Map([["999", { ORIGINAL_START_DATE: "2025-05-27" }]]);
  const out = await applyExtensionRunrateBackfillForInsertRows(rows, {}, {
    parentFetchFn,
    priorExtensionFetchFn: noPriorExtensionFetch,
    runrateFetchFn: noParentFetch,
    resolveContractIdsFn: noContractIdResolution,
  });
  assert.equal(out[0].ORIGINAL_START_DATE, "2025-05-27");
});

test("resolveContractIdsForRunrateMatchedExtensions reuses an existing CONTRACT_ID before allocating a fresh one", async () => {
  const rows = [
    { PLACEMENT_ID: 1, CANDIDATE_NEXUS_ID: 111, CLIENT_ID: 55, CANDIDATE_EMAIL: "a@x.com", START_DATE: "2024-01-01" },
    { PLACEMENT_ID: 2, CANDIDATE_NEXUS_ID: 222, CLIENT_ID: 66, CANDIDATE_EMAIL: "b@x.com", START_DATE: "2024-02-01" },
  ];

  let allocateCalled = 0;
  const fetchContractIdsForExtensionsFn = async (lookupInput, opts) => {
    assert.equal(opts.includeExtensionSource, true);
    assert.equal(lookupInput.length, 2);
    return new Map([["1", "CHC5000"]]);
  };
  const allocateContractIdsFn = async (count) => {
    allocateCalled++;
    return Array.from({ length: count }, (_, i) => `CHC${6000 + i}`);
  };
  const buildSequenceOptionsForTableFn = () => ({ docId: "cynet_health_deal_sheet", prefix: "CHC", startValue: 1000 });

  const out = await resolveContractIdsForRunrateMatchedExtensions(
    rows,
    { tableId: "cynet_health_deal_sheet" },
    { fetchContractIdsForExtensionsFn, allocateContractIdsFn, buildSequenceOptionsForTableFn }
  );

  assert.equal(out.get("1"), "CHC5000");
  assert.equal(out.get("2"), "CHC6000");
  assert.equal(allocateCalled, 1);
});

test("resolveContractIdsForRunrateMatchedExtensions skips allocation when the table has no sequence config", async () => {
  const rows = [{ PLACEMENT_ID: 1, CANDIDATE_NEXUS_ID: 111, CLIENT_ID: 55 }];
  const fetchContractIdsForExtensionsFn = async () => new Map();
  let allocateCalled = false;
  const allocateContractIdsFn = async () => {
    allocateCalled = true;
    return [];
  };
  const buildSequenceOptionsForTableFn = () => null;

  const out = await resolveContractIdsForRunrateMatchedExtensions(
    rows,
    { tableId: "cynet_locums_deal_sheet" },
    { fetchContractIdsForExtensionsFn, allocateContractIdsFn, buildSequenceOptionsForTableFn }
  );

  assert.equal(out.size, 0);
  assert.equal(allocateCalled, false);
});
