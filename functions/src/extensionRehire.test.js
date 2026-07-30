const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EXTENSION_REHIRE_COLUMN,
  EXTENSION_REHIRE_VALUES,
  EXTENSION_REHIRE_TABLE_IDS,
  EXTENSION_REHIRE_RULES,
  isStartedPlacementStatus,
  classifyExtensionRehire,
  buildExtensionRehireCaseSql,
  buildExtensionRehireSql,
  filterExistingTableIds,
  backfillExtensionRehire,
} = require("./extensionRehire");

const V = EXTENSION_REHIRE_VALUES;

/** Facts for a unit; every field defaults to "nothing known yet". */
function facts(overrides = {}) {
  return {
    dealType: "DEAL",
    extensionRank: 0,
    everStarted: false,
    generationExtensionCount: 0,
    hasPriorOtherClient: false,
    ...overrides,
  };
}

test("column name has no slash (BigQuery identifier) but values do", () => {
  assert.equal(EXTENSION_REHIRE_COLUMN, "EXTENSION_REHIRE");
  assert.ok(!EXTENSION_REHIRE_COLUMN.includes("/"));
  assert.equal(V.REBOOKED_EXTENSION, "REBOOKED/EXTENSION");
});

test("all 6 domain deal sheet tables (active + ended) are covered", () => {
  assert.deepEqual(EXTENSION_REHIRE_TABLE_IDS, [
    "cynet_health_deal_sheet",
    "cynet_health_canada_deal_sheet",
    "cynet_locums_deal_sheet",
    "cynet_health_ended_deal_sheet",
    "cynet_health_canada_ended_deal_sheet",
    "cynet_locums_ended_deal_sheet",
  ]);
});

test("isStartedPlacementStatus: STARTED/ACTIVE/ENDED count as started, BOOKED/DNS do not", () => {
  assert.equal(isStartedPlacementStatus("STARTED"), true);
  assert.equal(isStartedPlacementStatus(" started "), true);
  assert.equal(isStartedPlacementStatus("Active"), true);
  assert.equal(isStartedPlacementStatus("ENDED"), true);
  assert.equal(isStartedPlacementStatus("ENDED<30"), true);
  assert.equal(isStartedPlacementStatus("BOOKED"), false);
  assert.equal(isStartedPlacementStatus("OFFERED"), false);
  assert.equal(isStartedPlacementStatus("DID NOT START"), false);
  assert.equal(isStartedPlacementStatus("DID NOT ACCEPT"), false);
  assert.equal(isStartedPlacementStatus(null), false);
});

// ---------------------------------------------------------------------------
// DEAL rows
// ---------------------------------------------------------------------------

test("first DEAL with nothing after it stays blank", () => {
  assert.equal(classifyExtensionRehire(facts()), null);
});

test("DEAL becomes EXTENSION once the same client extends it", () => {
  assert.equal(
    classifyExtensionRehire(facts({ generationExtensionCount: 1 })),
    V.EXTENSION
  );
  assert.equal(
    classifyExtensionRehire(facts({ generationExtensionCount: 3 })),
    V.EXTENSION
  );
});

test("DEAL at a different client for an existing candidate is REHIRED", () => {
  assert.equal(
    classifyExtensionRehire(facts({ hasPriorOtherClient: true })),
    V.REHIRED
  );
});

test("a rehired DEAL flips to EXTENSION once the new client extends it", () => {
  assert.equal(
    classifyExtensionRehire(facts({ hasPriorOtherClient: true, generationExtensionCount: 1 })),
    V.EXTENSION
  );
});

test("DEAL placement status never affects the value", () => {
  for (const everStarted of [true, false]) {
    assert.equal(classifyExtensionRehire(facts({ everStarted })), null);
    assert.equal(
      classifyExtensionRehire(facts({ everStarted, generationExtensionCount: 1 })),
      V.EXTENSION
    );
  }
});

// ---------------------------------------------------------------------------
// EXTENSION rows — 1st extension of the deal
// ---------------------------------------------------------------------------

test("1st extension still BOOKED is REOFFERED", () => {
  assert.equal(
    classifyExtensionRehire(facts({ dealType: "EXTENSION", extensionRank: 1, everStarted: false })),
    V.REOFFERED
  );
});

test("1st extension that STARTED is REBOOKED", () => {
  assert.equal(
    classifyExtensionRehire(facts({ dealType: "EXTENSION", extensionRank: 1, everStarted: true })),
    V.REBOOKED
  );
});

test("1st extension that started and then ENDED stays REBOOKED (ever-started is sticky)", () => {
  // ENDED is in STARTED_PLACEMENT_STATUSES, so the unit's everStarted stays true.
  assert.equal(isStartedPlacementStatus("ENDED"), true);
  assert.equal(
    classifyExtensionRehire(facts({ dealType: "EXTENSION", extensionRank: 1, everStarted: true })),
    V.REBOOKED
  );
});

test("BOOKED -> DID NOT START extension stays REOFFERED", () => {
  assert.equal(isStartedPlacementStatus("DID NOT START"), false);
  assert.equal(
    classifyExtensionRehire(facts({ dealType: "EXTENSION", extensionRank: 1, everStarted: false })),
    V.REOFFERED
  );
});

// ---------------------------------------------------------------------------
// EXTENSION rows — extension on extension
// ---------------------------------------------------------------------------

test("2nd+ extension is REBOOKED/EXTENSION whatever its placement status", () => {
  for (const rank of [2, 3, 7]) {
    for (const everStarted of [true, false]) {
      assert.equal(
        classifyExtensionRehire(facts({ dealType: "EXTENSION", extensionRank: rank, everStarted })),
        V.REBOOKED_EXTENSION
      );
    }
  }
});

test("run-rate-only chain: the first extension we hold is still REOFFERED/REBOOKED (generation 0)", () => {
  // No parent DEAL row in the deal sheet -> generation 0, but rank still starts at 1.
  assert.equal(
    classifyExtensionRehire(facts({ dealType: "EXTENSION", extensionRank: 1, everStarted: false })),
    V.REOFFERED
  );
  assert.equal(
    classifyExtensionRehire(facts({ dealType: "EXTENSION", extensionRank: 1, everStarted: true })),
    V.REBOOKED
  );
});

test("an EXTENSION is never REHIRED even when the candidate worked elsewhere", () => {
  assert.equal(
    classifyExtensionRehire(
      facts({ dealType: "EXTENSION", extensionRank: 1, everStarted: true, hasPriorOtherClient: true })
    ),
    V.REBOOKED
  );
});

test("unknown / blank DEAL_TYPE stays blank", () => {
  assert.equal(classifyExtensionRehire(facts({ dealType: "" })), null);
  assert.equal(classifyExtensionRehire(facts({ dealType: null })), null);
  assert.equal(
    classifyExtensionRehire(facts({ dealType: "PERM", generationExtensionCount: 2 })),
    null
  );
});

test("classifier is case/space insensitive on DEAL_TYPE", () => {
  assert.equal(
    classifyExtensionRehire(facts({ dealType: " extension ", extensionRank: 1, everStarted: true })),
    V.REBOOKED
  );
});

// ---------------------------------------------------------------------------
// SQL generation — same rules, same order
// ---------------------------------------------------------------------------

test("generated CASE mirrors the rule list order and values", () => {
  const caseSql = buildExtensionRehireCaseSql();
  const branchOrder = [...caseSql.matchAll(/THEN '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(branchOrder, EXTENSION_REHIRE_RULES.map((r) => r.value));
  assert.ok(caseSql.includes("extension_rank >= 2"));
  assert.ok(caseSql.includes("generation_extension_count > 0"));
  assert.ok(caseSql.includes("has_prior_other_client"));
});

test("buildExtensionRehireSql reads + updates every deal sheet table", () => {
  const { sql, tableIds } = buildExtensionRehireSql({
    projectId: "proj",
    datasetId: "ds",
    runrateTableIds: ["all_CH_data_runrate"],
  });
  assert.deepEqual(tableIds, [...EXTENSION_REHIRE_TABLE_IDS]);
  for (const tableId of EXTENSION_REHIRE_TABLE_IDS) {
    assert.ok(sql.includes(`FROM \`proj.ds.${tableId}\``), `reads ${tableId}`);
    assert.ok(sql.includes(`UPDATE \`proj.ds.${tableId}\` t`), `updates ${tableId}`);
  }
  // One UPDATE per table, each guarded so a settled table writes nothing.
  assert.equal((sql.match(/^UPDATE /gm) || []).length, EXTENSION_REHIRE_TABLE_IDS.length);
  assert.equal(
    (sql.match(/EXTENSION_REHIRE IS DISTINCT FROM v\.value/g) || []).length,
    EXTENSION_REHIRE_TABLE_IDS.length
  );
});

test("buildExtensionRehireSql groups by candidate + client and counts generations", () => {
  const { sql } = buildExtensionRehireSql({ projectId: "proj", datasetId: "ds" });
  assert.ok(sql.includes("CONCAT(latest.candidate_key, '|', latest.client_key)"));
  assert.ok(sql.includes("COUNTIF(deal_type = 'DEAL') OVER ("));
  assert.ok(sql.includes("PARTITION BY chain_key, deal_generation, deal_type"));
  // A unit is a deal/extension event: DEAL_SHEET_ID, or PLACEMENT_ID when that is null.
  assert.ok(sql.includes("CONCAT('ds:', CAST(DEAL_SHEET_ID AS STRING))"));
  assert.ok(sql.includes("CONCAT('pl:', CAST(PLACEMENT_ID AS STRING))"));
  assert.ok(sql.includes("CONCAT('ds:', CAST(t.DEAL_SHEET_ID AS STRING))"));
});

test("buildExtensionRehireSql includes run-rate history only for the tables it is given", () => {
  const withRunrate = buildExtensionRehireSql({
    projectId: "proj",
    datasetId: "ds",
    runrateTableIds: ["all_CH_data_runrate", "all_Health_Canada_data_Runrate"],
  }).sql;
  assert.ok(withRunrate.includes("FROM `proj.ds.all_CH_data_runrate`"));
  assert.ok(withRunrate.includes("FROM `proj.ds.all_Health_Canada_data_Runrate`"));

  const withoutRunrate = buildExtensionRehireSql({ projectId: "proj", datasetId: "ds" }).sql;
  assert.ok(!withoutRunrate.includes("all_CH_data_runrate"));
  // Deal-sheet history alone still drives REHIRED.
  assert.ok(withoutRunrate.includes("candidate_history AS ("));
});

test("REHIRED lookup only considers strictly earlier history at a different parent client", () => {
  const { sql } = buildExtensionRehireSql({ projectId: "proj", datasetId: "ds" });
  assert.ok(sql.includes("h.parent_client_key != u.parent_client_key"));
  assert.ok(sql.includes("(u.start_key IS NULL OR h.hist_start < u.start_key)"));
  assert.ok(sql.includes("WHERE u.deal_type = 'DEAL'"));
});

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

test("filterExistingTableIds drops tables missing from the dataset", async () => {
  const seen = [];
  const existing = await filterExistingTableIds(
    ["all_CH_data_runrate", "all_Locums_data_Runrate"],
    { projectId: "proj", datasetId: "ds" },
    {
      queryFn: async (sql) => {
        seen.push(sql);
        return [{ table_name: "all_CH_data_runrate" }];
      },
    }
  );
  assert.deepEqual(existing, ["all_CH_data_runrate"]);
  assert.ok(seen[0].includes("INFORMATION_SCHEMA.TABLES"));
});

test("backfillExtensionRehire skips a missing run-rate table and totals per-table counts", async () => {
  const queries = [];
  const result = await backfillExtensionRehire(
    { projectId: "proj", datasetId: "ds" },
    {
      queryFn: async (sql) => {
        queries.push(sql);
        if (sql.includes("INFORMATION_SCHEMA.TABLES")) {
          return [{ table_name: "all_CH_data_runrate" }];
        }
        return [
          { table_id: "cynet_health_deal_sheet", changed_rows: 12 },
          { table_id: "cynet_locums_ended_deal_sheet", changed_rows: 3 },
        ];
      },
    }
  );

  assert.equal(result.updated, 15);
  assert.equal(result.byTable.cynet_health_deal_sheet, 12);
  assert.equal(result.byTable.cynet_locums_ended_deal_sheet, 3);
  // Tables with nothing to change still report 0 rather than going missing.
  assert.equal(result.byTable.cynet_health_canada_deal_sheet, 0);
  assert.deepEqual(result.runrateTableIds, ["all_CH_data_runrate"]);

  const scriptSql = queries[1];
  assert.ok(scriptSql.includes("FROM `proj.ds.all_CH_data_runrate`"));
  assert.ok(!scriptSql.includes("all_Locums_data_Runrate"));
});

test("backfillExtensionRehire reports 0 when nothing changed (idempotent steady state)", async () => {
  const result = await backfillExtensionRehire(
    { projectId: "proj", datasetId: "ds", runrateTableIds: [] },
    {
      // ext_rehire_pending always yields one row per table, 0 when nothing changed.
      queryFn: async () =>
        EXTENSION_REHIRE_TABLE_IDS.map((table_id) => ({ table_id, changed_rows: 0 })),
    }
  );
  assert.equal(result.updated, 0);
  for (const tableId of EXTENSION_REHIRE_TABLE_IDS) {
    assert.equal(result.byTable[tableId], 0);
  }
});

test("counts are reported as unknown (not 0) when the job returns no rows", async () => {
  const result = await backfillExtensionRehire(
    { projectId: "proj", datasetId: "ds", runrateTableIds: [] },
    { queryFn: async () => [] }
  );
  // The UPDATEs still ran; claiming 0 changed rows would be a false "nothing to do".
  assert.equal(result.updated, null);
  assert.deepEqual(result.byTable, {});
});

test("pending counts are computed before the updates and cover every table", () => {
  const { sql } = buildExtensionRehireSql({ projectId: "proj", datasetId: "ds" });
  const pendingAt = sql.indexOf("CREATE TEMP TABLE ext_rehire_pending");
  const firstUpdateAt = sql.indexOf("UPDATE `proj.ds.");
  assert.ok(pendingAt > 0 && firstUpdateAt > pendingAt, "counts snapshot precedes the UPDATEs");
  for (const tableId of EXTENSION_REHIRE_TABLE_IDS) {
    assert.ok(sql.includes(`'${tableId}'`), `${tableId} listed in the pending-count UNNEST`);
  }
  assert.ok(sql.includes("IFNULL(c.changed_rows, 0) AS changed_rows"));
});

// ---------------------------------------------------------------------------
// End-to-end scenarios
//
// `computeValues` is a JS model of the generations / ranked CTEs in buildExtensionRehireSql (unit
// grouping, sticky ever-started, deal generations, extension rank, prior-other-client history). It
// exists so the SCENARIOS below exercise the whole rule composition, not just the final CASE.
// ---------------------------------------------------------------------------

function computeValues(rows, runrateHistory = []) {
  const units = new Map();
  for (const row of rows) {
    const unitKey = `ds:${row.dealSheetId}`;
    if (!units.has(unitKey)) units.set(unitKey, { unitKey, rows: [] });
    units.get(unitKey).rows.push(row);
  }

  const flat = [...units.values()].map((unit) => {
    const ordered = [...unit.rows].sort((a, b) => (a.at || 0) - (b.at || 0));
    const latest = ordered[ordered.length - 1];
    return {
      unitKey: unit.unitKey,
      dealType: String(latest.dealType || "").toUpperCase(),
      everStarted: unit.rows.some((r) => isStartedPlacementStatus(r.placementStatus)),
      candidateKey: `nx:${latest.candidateNexusId}`,
      clientKey: `cid:${latest.clientId}`,
      parentClientKey: String(latest.parentClientName || "").toLowerCase() || null,
      startKey: latest.startDate ?? null,
    };
  });
  for (const u of flat) u.chainKey = `${u.candidateKey}|${u.clientKey}`;

  // generations: order by start date, DEAL before EXTENSION on a tie, then unit key.
  const byChain = new Map();
  for (const u of flat) {
    if (!byChain.has(u.chainKey)) byChain.set(u.chainKey, []);
    byChain.get(u.chainKey).push(u);
  }
  for (const chain of byChain.values()) {
    chain.sort(
      (a, b) =>
        String(a.startKey ?? "").localeCompare(String(b.startKey ?? "")) ||
        (a.dealType === "DEAL" ? 0 : 1) - (b.dealType === "DEAL" ? 0 : 1) ||
        a.unitKey.localeCompare(b.unitKey)
    );
    let generation = 0;
    for (const u of chain) {
      if (u.dealType === "DEAL") generation++;
      u.generation = generation;
    }
    for (const u of chain) {
      const sameGen = chain.filter((o) => o.generation === u.generation);
      u.extensionRank =
        sameGen.filter((o) => o.dealType === u.dealType).indexOf(u) + 1;
      u.generationExtensionCount = sameGen.filter((o) => o.dealType === "EXTENSION").length;
    }
  }

  const history = [
    ...flat.map((u) => ({
      candidateKey: u.candidateKey,
      parentClientKey: u.parentClientKey,
      histStart: u.startKey,
    })),
    ...runrateHistory.map((h) => ({
      candidateKey: `nx:${h.candidateNexusId}`,
      parentClientKey: String(h.parentClientName || "").toLowerCase() || null,
      histStart: h.startDate ?? null,
    })),
  ];

  const out = {};
  for (const u of flat) {
    u.hasPriorOtherClient = history.some(
      (h) =>
        h.candidateKey === u.candidateKey &&
        h.parentClientKey != null &&
        u.parentClientKey != null &&
        h.parentClientKey !== u.parentClientKey &&
        h.histStart != null &&
        (u.startKey == null || h.histStart < u.startKey)
    );
    out[u.unitKey] = classifyExtensionRehire(u);
  }
  return out;
}

/** One appended deal sheet row. `at` is DATE_AND_TIME order within the unit. */
function row(overrides) {
  return {
    candidateNexusId: 501,
    clientId: 90,
    parentClientName: "Mercy Health",
    at: 1,
    ...overrides,
  };
}

test("scenario: DEAL with no extension yet stays blank", () => {
  const values = computeValues([
    row({ dealSheetId: 1, dealType: "DEAL", placementStatus: "STARTED", startDate: "2026-01-05" }),
  ]);
  assert.equal(values["ds:1"], null);
});

test("scenario: BOOKED extension -> DEAL becomes EXTENSION, extension is REOFFERED", () => {
  const values = computeValues([
    row({ dealSheetId: 1, dealType: "DEAL", placementStatus: "STARTED", startDate: "2026-01-05" }),
    row({ dealSheetId: 2, dealType: "EXTENSION", placementStatus: "BOOKED", startDate: "2026-04-06" }),
  ]);
  assert.equal(values["ds:1"], V.EXTENSION);
  assert.equal(values["ds:2"], V.REOFFERED);
});

test("scenario: extension moves BOOKED -> STARTED -> REBOOKED, and stays REBOOKED on ENDED", () => {
  const started = computeValues([
    row({ dealSheetId: 1, dealType: "DEAL", placementStatus: "STARTED", startDate: "2026-01-05" }),
    row({ dealSheetId: 2, dealType: "EXTENSION", placementStatus: "BOOKED", startDate: "2026-04-06", at: 1 }),
    row({ dealSheetId: 2, dealType: "EXTENSION", placementStatus: "STARTED", startDate: "2026-04-06", at: 2 }),
  ]);
  assert.equal(started["ds:2"], V.REBOOKED);

  const ended = computeValues([
    row({ dealSheetId: 1, dealType: "DEAL", placementStatus: "STARTED", startDate: "2026-01-05" }),
    row({ dealSheetId: 2, dealType: "EXTENSION", placementStatus: "BOOKED", startDate: "2026-04-06", at: 1 }),
    row({ dealSheetId: 2, dealType: "EXTENSION", placementStatus: "STARTED", startDate: "2026-04-06", at: 2 }),
    row({ dealSheetId: 2, dealType: "EXTENSION", placementStatus: "ENDED", startDate: "2026-04-06", at: 3 }),
  ]);
  assert.equal(ended["ds:2"], V.REBOOKED);
});

test("scenario: BOOKED extension that ends up DID NOT START stays REOFFERED", () => {
  const values = computeValues([
    row({ dealSheetId: 1, dealType: "DEAL", placementStatus: "STARTED", startDate: "2026-01-05" }),
    row({ dealSheetId: 2, dealType: "EXTENSION", placementStatus: "BOOKED", startDate: "2026-04-06", at: 1 }),
    row({ dealSheetId: 2, dealType: "EXTENSION", placementStatus: "DID NOT START", startDate: "2026-04-06", at: 2 }),
  ]);
  assert.equal(values["ds:1"], V.EXTENSION);
  assert.equal(values["ds:2"], V.REOFFERED);
});

test("scenario: extension on extension -> 3rd unit is REBOOKED/EXTENSION at any status", () => {
  const booked = computeValues([
    row({ dealSheetId: 1, dealType: "DEAL", placementStatus: "STARTED", startDate: "2026-01-05" }),
    row({ dealSheetId: 2, dealType: "EXTENSION", placementStatus: "STARTED", startDate: "2026-04-06" }),
    row({ dealSheetId: 3, dealType: "EXTENSION", placementStatus: "BOOKED", startDate: "2026-07-06" }),
  ]);
  assert.equal(booked["ds:1"], V.EXTENSION);
  assert.equal(booked["ds:2"], V.REBOOKED);
  assert.equal(booked["ds:3"], V.REBOOKED_EXTENSION);

  const startedThird = computeValues([
    row({ dealSheetId: 1, dealType: "DEAL", placementStatus: "STARTED", startDate: "2026-01-05" }),
    row({ dealSheetId: 2, dealType: "EXTENSION", placementStatus: "STARTED", startDate: "2026-04-06" }),
    row({ dealSheetId: 3, dealType: "EXTENSION", placementStatus: "STARTED", startDate: "2026-07-06" }),
  ]);
  assert.equal(startedThird["ds:3"], V.REBOOKED_EXTENSION);
});

test("scenario: a different client is a different chain, so its extensions restart at REOFFERED", () => {
  const values = computeValues([
    row({ dealSheetId: 1, dealType: "DEAL", placementStatus: "STARTED", startDate: "2026-01-05" }),
    row({ dealSheetId: 2, dealType: "EXTENSION", placementStatus: "STARTED", startDate: "2026-04-06" }),
    row({
      dealSheetId: 3,
      dealType: "EXTENSION",
      placementStatus: "BOOKED",
      startDate: "2026-07-06",
      clientId: 91,
      parentClientName: "Sutter Health",
    }),
  ]);
  assert.equal(values["ds:2"], V.REBOOKED);
  // Same candidate, other client -> not an extension-on-extension.
  assert.equal(values["ds:3"], V.REOFFERED);
});

test("scenario: run-rate-only placement — extension with no parent DEAL row here", () => {
  const runrate = [{ candidateNexusId: 501, parentClientName: "Mercy Health", startDate: "2025-09-01" }];

  const booked = computeValues(
    [row({ dealSheetId: 2, dealType: "EXTENSION", placementStatus: "BOOKED", startDate: "2026-04-06" })],
    runrate
  );
  assert.equal(booked["ds:2"], V.REOFFERED);

  const started = computeValues(
    [row({ dealSheetId: 2, dealType: "EXTENSION", placementStatus: "STARTED", startDate: "2026-04-06" })],
    runrate
  );
  assert.equal(started["ds:2"], V.REBOOKED);
});

test("scenario: candidate returns at a different parent client -> REHIRED", () => {
  const values = computeValues([
    row({ dealSheetId: 1, dealType: "DEAL", placementStatus: "ENDED", startDate: "2025-02-01" }),
    row({
      dealSheetId: 2,
      dealType: "DEAL",
      placementStatus: "BOOKED",
      startDate: "2026-06-01",
      clientId: 91,
      parentClientName: "Sutter Health",
    }),
  ]);
  assert.equal(values["ds:1"], null); // first client, never extended
  assert.equal(values["ds:2"], V.REHIRED);
});

test("scenario: REHIRED from run-rate history alone (candidate not in the deal sheet before)", () => {
  const values = computeValues(
    [row({ dealSheetId: 2, dealType: "DEAL", placementStatus: "BOOKED", startDate: "2026-06-01" })],
    [{ candidateNexusId: 501, parentClientName: "Sutter Health", startDate: "2024-03-01" }]
  );
  assert.equal(values["ds:2"], V.REHIRED);
});

test("scenario: same parent client in run-rate history is NOT a rehire", () => {
  const values = computeValues(
    [row({ dealSheetId: 2, dealType: "DEAL", placementStatus: "BOOKED", startDate: "2026-06-01" })],
    [{ candidateNexusId: 501, parentClientName: "Mercy Health", startDate: "2024-03-01" }]
  );
  assert.equal(values["ds:2"], null);
});

test("scenario: a REHIRED deal flips to EXTENSION once its new client extends", () => {
  const values = computeValues([
    row({ dealSheetId: 1, dealType: "DEAL", placementStatus: "ENDED", startDate: "2025-02-01" }),
    row({
      dealSheetId: 2,
      dealType: "DEAL",
      placementStatus: "STARTED",
      startDate: "2026-06-01",
      clientId: 91,
      parentClientName: "Sutter Health",
    }),
    row({
      dealSheetId: 3,
      dealType: "EXTENSION",
      placementStatus: "BOOKED",
      startDate: "2026-09-01",
      clientId: 91,
      parentClientName: "Sutter Health",
    }),
  ]);
  assert.equal(values["ds:2"], V.EXTENSION);
  assert.equal(values["ds:3"], V.REOFFERED);
});

test("scenario: later history at another client does not retro-flag the earlier deal", () => {
  const values = computeValues([
    row({ dealSheetId: 1, dealType: "DEAL", placementStatus: "ENDED", startDate: "2025-02-01" }),
    row({
      dealSheetId: 2,
      dealType: "DEAL",
      placementStatus: "BOOKED",
      startDate: "2026-06-01",
      clientId: 91,
      parentClientName: "Sutter Health",
    }),
  ]);
  // Only the LATER deal is the rehire — REHIRED needs strictly earlier other-client history.
  assert.equal(values["ds:1"], null);
  assert.equal(values["ds:2"], V.REHIRED);
});

test("EXTENSION_REHIRE is carried forward on update-append (MANUAL_COLUMNS) and not API-owned", () => {
  const { MANUAL_COLUMNS, API_OWNED_COLUMNS } = require("./columnMappings");
  // Carried forward so an append keeps the last computed value instead of blanking the row...
  assert.ok(MANUAL_COLUMNS.has(EXTENSION_REHIRE_COLUMN));
  // ...and never part of the change-detection gate, so it can't trigger a 0-diff append on its own.
  assert.ok(!API_OWNED_COLUMNS.has(EXTENSION_REHIRE_COLUMN));
});
