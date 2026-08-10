const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EXT_OR_REHIRE_COLUMN,
  EXT_OR_REHIRE_VALUES,
  EXT_OR_REHIRE_TABLE_IDS,
  EXT_OR_REHIRE_RULES,
  isStartedPlacementStatus,
  classifyExtensionRehire,
  buildExtensionRehireCaseSql,
  buildExtensionRehireSql,
  filterExistingTableIds,
  backfillExtensionRehire,
} = require("./extensionRehire");

const V = EXT_OR_REHIRE_VALUES;

/** Facts for a unit; every field defaults to "nothing known yet". */
function facts(overrides = {}) {
  return {
    dealType: "DEAL",
    everStarted: false,
    isRepeatDeal: false,
    parentIsRepeatDeal: false,
    ...overrides,
  };
}

test("column name has no slash (BigQuery identifier) but values do", () => {
  assert.equal(EXT_OR_REHIRE_COLUMN, "EXT_OR_REHIRE_BY_RMG");
  assert.ok(!EXT_OR_REHIRE_COLUMN.includes("/"));
  assert.equal(V.REBOOKED_EXTENSION, "REBOOKED/EXTENSION");
});

test("all 6 domain deal sheet tables (active + ended) are covered", () => {
  assert.deepEqual(EXT_OR_REHIRE_TABLE_IDS, [
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

test("the candidate's FIRST deal stays blank", () => {
  assert.equal(classifyExtensionRehire(facts()), null);
});

test("the first deal stays blank even after it is extended", () => {
  // The EXTENSION label now lives on the extension rows, never on the deal itself.
  assert.equal(classifyExtensionRehire(facts({ everStarted: true })), null);
});

test("a repeat DEAL still BOOKED is REOFFERED", () => {
  assert.equal(classifyExtensionRehire(facts({ isRepeatDeal: true })), V.REOFFERED);
});

test("a repeat DEAL that STARTED is REBOOKED", () => {
  assert.equal(
    classifyExtensionRehire(facts({ isRepeatDeal: true, everStarted: true })),
    V.REBOOKED
  );
});

test("a repeat DEAL that started then ENDED stays REBOOKED (ever-started is sticky)", () => {
  assert.equal(isStartedPlacementStatus("ENDED"), true);
  assert.equal(
    classifyExtensionRehire(facts({ isRepeatDeal: true, everStarted: true })),
    V.REBOOKED
  );
});

test("repeat is candidate-level, not client-level — the same client counts too", () => {
  // isRepeatDeal is set by ANY earlier placement; the classifier has no client input at all.
  assert.equal(classifyExtensionRehire(facts({ isRepeatDeal: true })), V.REOFFERED);
});

// ---------------------------------------------------------------------------
// EXTENSION rows — value comes from the parent deal, never from rank or status
// ---------------------------------------------------------------------------

test("extension of the FIRST deal is EXTENSION at any placement status", () => {
  for (const everStarted of [true, false]) {
    assert.equal(
      classifyExtensionRehire(facts({ dealType: "EXTENSION", everStarted })),
      V.EXTENSION
    );
  }
});

test("extension of a REPEAT deal is REBOOKED/EXTENSION at any placement status", () => {
  for (const everStarted of [true, false]) {
    assert.equal(
      classifyExtensionRehire(
        facts({ dealType: "EXTENSION", parentIsRepeatDeal: true, everStarted })
      ),
      V.REBOOKED_EXTENSION
    );
  }
});

test("every extension in a run carries the same value — rank is not a factor", () => {
  // 1st, 2nd, 5th extension of the same deal are indistinguishable to the classifier.
  const first = classifyExtensionRehire(facts({ dealType: "EXTENSION" }));
  const later = classifyExtensionRehire(facts({ dealType: "EXTENSION" }));
  assert.equal(first, V.EXTENSION);
  assert.equal(later, V.EXTENSION);
  assert.equal(
    classifyExtensionRehire(facts({ dealType: "EXTENSION", parentIsRepeatDeal: true })),
    V.REBOOKED_EXTENSION
  );
});

test("a DNS extension keeps its parent-derived value", () => {
  assert.equal(isStartedPlacementStatus("DID NOT START"), false);
  assert.equal(
    classifyExtensionRehire(
      facts({ dealType: "EXTENSION", parentIsRepeatDeal: true, everStarted: false })
    ),
    V.REBOOKED_EXTENSION
  );
});

test("an extension is never REOFFERED/REBOOKED — those are DEAL-only values now", () => {
  for (const parentIsRepeatDeal of [true, false]) {
    const value = classifyExtensionRehire(
      facts({ dealType: "EXTENSION", parentIsRepeatDeal, everStarted: true, isRepeatDeal: true })
    );
    assert.ok(value === V.EXTENSION || value === V.REBOOKED_EXTENSION);
  }
});

test("run-rate-only chain: an extension with no parent DEAL here reads EXTENSION", () => {
  // parentIsRepeatDeal stays false when the deal is not in the deal sheet at all.
  assert.equal(
    classifyExtensionRehire(facts({ dealType: "EXTENSION", parentIsRepeatDeal: false })),
    V.EXTENSION
  );
});

test("unknown / blank DEAL_TYPE stays blank", () => {
  assert.equal(classifyExtensionRehire(facts({ dealType: "" })), null);
  assert.equal(classifyExtensionRehire(facts({ dealType: null })), null);
  assert.equal(
    classifyExtensionRehire(facts({ dealType: "PERM", isRepeatDeal: true, everStarted: true })),
    null
  );
});

test("classifier is case/space insensitive on DEAL_TYPE", () => {
  assert.equal(
    classifyExtensionRehire(facts({ dealType: " extension ", parentIsRepeatDeal: true })),
    V.REBOOKED_EXTENSION
  );
  assert.equal(
    classifyExtensionRehire(facts({ dealType: " deal ", isRepeatDeal: true, everStarted: true })),
    V.REBOOKED
  );
});

// ---------------------------------------------------------------------------
// SQL generation — same rules, same order
// ---------------------------------------------------------------------------

test("generated CASE mirrors the rule list order and values", () => {
  const caseSql = buildExtensionRehireCaseSql();
  const branchOrder = [...caseSql.matchAll(/THEN '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(branchOrder, EXT_OR_REHIRE_RULES.map((r) => r.value));
  assert.ok(caseSql.includes("parent_is_repeat_deal"));
  assert.ok(caseSql.includes("is_repeat_deal AND ever_started"));
  // Rank no longer participates in the classification.
  assert.ok(!caseSql.includes("extension_rank"));
  assert.ok(!caseSql.includes("generation_extension_count"));
});

test("buildExtensionRehireSql reads + updates every deal sheet table", () => {
  const { sql, tableIds } = buildExtensionRehireSql({
    projectId: "proj",
    datasetId: "ds",
    runrateTableIds: ["all_CH_data_runrate"],
  });
  assert.deepEqual(tableIds, [...EXT_OR_REHIRE_TABLE_IDS]);
  for (const tableId of EXT_OR_REHIRE_TABLE_IDS) {
    assert.ok(sql.includes(`FROM \`proj.ds.${tableId}\``), `reads ${tableId}`);
    assert.ok(sql.includes(`UPDATE \`proj.ds.${tableId}\` t`), `updates ${tableId}`);
  }
  // One UPDATE per table, each guarded so a settled table writes nothing.
  assert.equal((sql.match(/^UPDATE /gm) || []).length, EXT_OR_REHIRE_TABLE_IDS.length);
  assert.equal(
    (sql.match(/EXT_OR_REHIRE_BY_RMG IS DISTINCT FROM v\.value/g) || []).length,
    EXT_OR_REHIRE_TABLE_IDS.length
  );
});

test("buildExtensionRehireSql chains on candidate + client + VMS job", () => {
  const { sql } = buildExtensionRehireSql({ projectId: "proj", datasetId: "ds" });
  assert.ok(sql.includes("latest.candidate_key, '|', latest.client_key"));
  assert.ok(sql.includes("CONCAT('|vms:', latest.vms_job_key)"));
  assert.ok(sql.includes("NULLIF(TRIM(CAST(VMS_JOB_ID AS STRING)), '')"));
  // Extensions inherit their parent deal instead of being ranked within a generation.
  assert.ok(sql.includes("extension_parents AS ("));
  assert.ok(sql.includes("repeat_deals AS ("));
  assert.ok(!sql.includes("deal_generation"));
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
  // Deal-sheet history alone still drives the repeat-deal rule.
  assert.ok(withoutRunrate.includes("candidate_history AS ("));
});

test("repeat-deal lookup is client-agnostic and needs strictly earlier history", () => {
  const { sql } = buildExtensionRehireSql({ projectId: "proj", datasetId: "ds" });
  // No client comparison at all — a return to the SAME client is still a repeat.
  assert.ok(!sql.includes("h.parent_client_key != u.parent_client_key"));
  assert.ok(sql.includes("h.hist_start < u.start_key"));
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
        EXT_OR_REHIRE_TABLE_IDS.map((table_id) => ({ table_id, changed_rows: 0 })),
    }
  );
  assert.equal(result.updated, 0);
  for (const tableId of EXT_OR_REHIRE_TABLE_IDS) {
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
  for (const tableId of EXT_OR_REHIRE_TABLE_IDS) {
    assert.ok(sql.includes(`'${tableId}'`), `${tableId} listed in the pending-count UNNEST`);
  }
  assert.ok(sql.includes("IFNULL(c.changed_rows, 0) AS changed_rows"));
});

// ---------------------------------------------------------------------------
// End-to-end scenarios
//
// `computeValues` is a JS model of the CTEs in buildExtensionRehireSql (unit grouping, sticky
// ever-started, candidate+client+VMS chain, repeat-deal history, extension->parent-deal
// inheritance). It exists so the SCENARIOS below exercise the whole rule composition, not just the
// final CASE.
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
    const vmsKey = latest.vmsJobId == null ? null : String(latest.vmsJobId).trim() || null;
    return {
      unitKey: unit.unitKey,
      dealType: String(latest.dealType || "").toUpperCase(),
      everStarted: unit.rows.some((r) => isStartedPlacementStatus(r.placementStatus)),
      candidateKey: `nx:${latest.candidateNexusId}`,
      clientKey: `cid:${latest.clientId}`,
      vmsJobKey: vmsKey,
      parentClientKey: String(latest.parentClientName || "").toLowerCase() || null,
      startKey: latest.startDate ?? null,
    };
  });
  // chain = candidate + client (+ VMS job when present)
  for (const u of flat) {
    u.chainKey = `${u.candidateKey}|${u.clientKey}${u.vmsJobKey ? `|vms:${u.vmsJobKey}` : ""}`;
  }

  // candidate history: ANY earlier placement, client-agnostic.
  const history = [
    ...flat.map((u) => ({ candidateKey: u.candidateKey, histStart: u.startKey })),
    ...runrateHistory.map((h) => ({
      candidateKey: `nx:${h.candidateNexusId}`,
      histStart: h.startDate ?? null,
    })),
  ];

  for (const u of flat) {
    u.isRepeatDeal =
      u.dealType === "DEAL" &&
      history.some(
        (h) =>
          h.candidateKey === u.candidateKey &&
          h.histStart != null &&
          u.startKey != null &&
          h.histStart < u.startKey
      );
  }

  // Each extension inherits the newest DEAL of its chain starting at or before it.
  for (const u of flat) {
    if (u.dealType !== "EXTENSION") {
      u.parentIsRepeatDeal = false;
      continue;
    }
    const candidates = flat
      .filter(
        (d) =>
          d.dealType === "DEAL" &&
          d.chainKey === u.chainKey &&
          (u.startKey == null || d.startKey == null || d.startKey <= u.startKey)
      )
      .sort(
        (a, b) =>
          String(b.startKey ?? "").localeCompare(String(a.startKey ?? "")) ||
          b.unitKey.localeCompare(a.unitKey)
      );
    u.parentIsRepeatDeal = candidates.length > 0 ? candidates[0].isRepeatDeal === true : false;
  }

  const out = {};
  for (const u of flat) out[u.unitKey] = classifyExtensionRehire(u);
  return out;
}

/** One appended deal sheet row. `at` is LAST_UPDATED order within the unit. */
function row(overrides) {
  return {
    candidateNexusId: 501,
    clientId: 90,
    parentClientName: "Mercy Health",
    at: 1,
    ...overrides,
  };
}

test("scenario: the candidate's first DEAL stays blank", () => {
  const values = computeValues([
    row({ dealSheetId: 1, dealType: "DEAL", placementStatus: "STARTED", startDate: "2026-01-05" }),
  ]);
  assert.equal(values["ds:1"], null);
});

test("scenario: first deal stays blank when extended; the extension reads EXTENSION", () => {
  const values = computeValues([
    row({ dealSheetId: 1, dealType: "DEAL", placementStatus: "STARTED", startDate: "2026-01-05" }),
    row({ dealSheetId: 2, dealType: "EXTENSION", placementStatus: "BOOKED", startDate: "2026-04-06" }),
  ]);
  assert.equal(values["ds:1"], null);
  assert.equal(values["ds:2"], V.EXTENSION);
});

test("scenario: every extension of the first deal reads EXTENSION, whatever the status", () => {
  const values = computeValues([
    row({ dealSheetId: 1, dealType: "DEAL", placementStatus: "STARTED", startDate: "2026-01-05" }),
    row({ dealSheetId: 2, dealType: "EXTENSION", placementStatus: "STARTED", startDate: "2026-04-06" }),
    row({ dealSheetId: 3, dealType: "EXTENSION", placementStatus: "ENDED", startDate: "2026-07-06" }),
    row({ dealSheetId: 4, dealType: "EXTENSION", placementStatus: "DID NOT START", startDate: "2026-10-06" }),
  ]);
  assert.equal(values["ds:1"], null);
  assert.equal(values["ds:2"], V.EXTENSION);
  assert.equal(values["ds:3"], V.EXTENSION);
  assert.equal(values["ds:4"], V.EXTENSION);
});

test("scenario: repeat deal moves REOFFERED -> REBOOKED and stays REBOOKED on ENDED", () => {
  const base = [
    row({ dealSheetId: 1, dealType: "DEAL", placementStatus: "ENDED", startDate: "2025-02-01" }),
  ];
  const newDeal = (status, at) =>
    row({
      dealSheetId: 2,
      dealType: "DEAL",
      placementStatus: status,
      startDate: "2026-06-01",
      clientId: 91,
      parentClientName: "Sutter Health",
      at,
    });

  assert.equal(computeValues([...base, newDeal("BOOKED", 1)])["ds:2"], V.REOFFERED);
  assert.equal(
    computeValues([...base, newDeal("BOOKED", 1), newDeal("STARTED", 2)])["ds:2"],
    V.REBOOKED
  );
  assert.equal(
    computeValues([...base, newDeal("BOOKED", 1), newDeal("STARTED", 2), newDeal("ENDED", 3)])["ds:2"],
    V.REBOOKED
  );
});

test("scenario: extensions of a repeat deal are REBOOKED/EXTENSION at any status", () => {
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
      startDate: "2026-08-26",
      clientId: 91,
      parentClientName: "Sutter Health",
    }),
    row({
      dealSheetId: 4,
      dealType: "EXTENSION",
      placementStatus: "DID NOT START",
      startDate: "2026-10-12",
      clientId: 91,
      parentClientName: "Sutter Health",
    }),
  ]);
  assert.equal(values["ds:1"], null);
  assert.equal(values["ds:2"], V.REBOOKED);
  assert.equal(values["ds:3"], V.REBOOKED_EXTENSION);
  assert.equal(values["ds:4"], V.REBOOKED_EXTENSION);
});

test("scenario: returning to the SAME client is still a repeat deal", () => {
  // Client-agnostic: the second deal at Mercy Health is a repeat just like a move elsewhere.
  const values = computeValues([
    row({ dealSheetId: 1, dealType: "DEAL", placementStatus: "ENDED", startDate: "2025-02-01" }),
    row({ dealSheetId: 2, dealType: "DEAL", placementStatus: "BOOKED", startDate: "2026-06-01" }),
  ]);
  assert.equal(values["ds:1"], null);
  assert.equal(values["ds:2"], V.REOFFERED);
});

test("scenario: repeat deal from run-rate history alone (candidate not in the deal sheet before)", () => {
  const values = computeValues(
    [row({ dealSheetId: 2, dealType: "DEAL", placementStatus: "BOOKED", startDate: "2026-06-01" })],
    [{ candidateNexusId: 501, parentClientName: "Sutter Health", startDate: "2024-03-01" }]
  );
  assert.equal(values["ds:2"], V.REOFFERED);
});

test("scenario: later history does not retro-flag the earlier deal", () => {
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
  // Only the LATER deal is the repeat — it needs strictly earlier history.
  assert.equal(values["ds:1"], null);
  assert.equal(values["ds:2"], V.REOFFERED);
});

test("scenario: run-rate-only chain — extension with no parent DEAL row here reads EXTENSION", () => {
  const values = computeValues(
    [row({ dealSheetId: 2, dealType: "EXTENSION", placementStatus: "BOOKED", startDate: "2026-04-06" })],
    [{ candidateNexusId: 501, parentClientName: "Mercy Health", startDate: "2025-09-01" }]
  );
  assert.equal(values["ds:2"], V.EXTENSION);
});

test("scenario: a different VMS job at the same client is a separate chain", () => {
  const values = computeValues([
    row({ dealSheetId: 1, dealType: "DEAL", placementStatus: "ENDED", startDate: "2025-02-01", vmsJobId: "J1" }),
    row({ dealSheetId: 2, dealType: "DEAL", placementStatus: "STARTED", startDate: "2026-06-01", vmsJobId: "J2" }),
    row({ dealSheetId: 3, dealType: "EXTENSION", placementStatus: "BOOKED", startDate: "2026-09-01", vmsJobId: "J2" }),
  ]);
  assert.equal(values["ds:1"], null);
  assert.equal(values["ds:2"], V.REBOOKED); // repeat candidate
  // ds:3 hangs off the J2 deal (a repeat), not the J1 one.
  assert.equal(values["ds:3"], V.REBOOKED_EXTENSION);
});

test("scenario: full walkthrough — XYZ then PQR then ABC", () => {
  // Mirrors the reference sheet: first client blank + EXTENSION, later clients REOFFERED/REBOOKED
  // + REBOOKED/EXTENSION.
  const values = computeValues([
    row({ dealSheetId: 1, dealType: "DEAL", placementStatus: "BOOKED", startDate: "2025-12-22", clientId: 10, parentClientName: "XYZ" }),
    row({ dealSheetId: 2, dealType: "EXTENSION", placementStatus: "STARTED", startDate: "2026-03-24", clientId: 10, parentClientName: "XYZ" }),
    row({ dealSheetId: 3, dealType: "EXTENSION", placementStatus: "ENDED", startDate: "2026-04-28", clientId: 10, parentClientName: "XYZ" }),
    row({ dealSheetId: 4, dealType: "DEAL", placementStatus: "ENDED", startDate: "2026-06-26", clientId: 20, parentClientName: "PQR" }),
    row({ dealSheetId: 5, dealType: "EXTENSION", placementStatus: "BOOKED", startDate: "2026-08-26", clientId: 20, parentClientName: "PQR" }),
    row({ dealSheetId: 6, dealType: "EXTENSION", placementStatus: "DID NOT START", startDate: "2026-10-12", clientId: 20, parentClientName: "PQR" }),
    row({ dealSheetId: 7, dealType: "DEAL", placementStatus: "BOOKED", startDate: "2027-01-01", clientId: 30, parentClientName: "ABC" }),
    row({ dealSheetId: 8, dealType: "EXTENSION", placementStatus: "STARTED", startDate: "2027-02-01", clientId: 30, parentClientName: "ABC" }),
  ]);
  assert.equal(values["ds:1"], null);
  assert.equal(values["ds:2"], V.EXTENSION);
  assert.equal(values["ds:3"], V.EXTENSION);
  assert.equal(values["ds:4"], V.REBOOKED);
  assert.equal(values["ds:5"], V.REBOOKED_EXTENSION);
  assert.equal(values["ds:6"], V.REBOOKED_EXTENSION);
  assert.equal(values["ds:7"], V.REOFFERED);
  assert.equal(values["ds:8"], V.REBOOKED_EXTENSION);
});

test("EXT_OR_REHIRE_BY_RMG is carried forward on update-append (MANUAL_COLUMNS) and not API-owned", () => {
  const { MANUAL_COLUMNS, API_OWNED_COLUMNS } = require("./columnMappings");
  // Carried forward so an append keeps the last computed value instead of blanking the row...
  assert.ok(MANUAL_COLUMNS.has(EXT_OR_REHIRE_COLUMN));
  // ...and never part of the change-detection gate, so it can't trigger a 0-diff append on its own.
  assert.ok(!API_OWNED_COLUMNS.has(EXT_OR_REHIRE_COLUMN));
});
