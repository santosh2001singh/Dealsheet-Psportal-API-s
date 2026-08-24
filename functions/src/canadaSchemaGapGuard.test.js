const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DEAL_SHEET_MISSING_COLUMNS_BY_TABLE,
  ACTIVE_CHANGE_SCAN_MISSING_COLUMNS_BY_TABLE,
  PARENT_DEAL_INHERIT_MISSING_COLUMNS_BY_TABLE,
  buildActiveChangeScanColumnList,
  buildActiveChangeScanUnionParts,
  resolveExtensionParentDealInheritColumns,
  resolveDealSheetMissingColumns,
  buildActiveDealSheetsUnionSql,
  legacyDealManualColumns,
  resolveExtensionRunrateHierarchyColumns,
  DELIVERY_POC_PRIORITY,
} = require("./bigQueryClient");
const {
  DEAL_RECRUITER_HIERARCHY_TARGETS,
} = require("./recruiterHierarchyDesignations");

const CANADA = "cynet_health_canada_deal_sheet";
const CANADA_ENDED = "cynet_health_canada_ended_deal_sheet";
const HEALTH = "cynet_health_deal_sheet";
const LOCUMS = "cynet_locums_deal_sheet";

/** Every column the canada deal sheet tables no longer have. */
const CANADA_DROPPED = [
  "AVP",
  "AVP_EMP_NO",
  "FIFTYTWO_TENURE_RTO_LASTDATE",
  "FIFTYTWO_TENURE_CANDIDATE_STATUS",
  "CLIENT_NAME_IN_CONREP",
];

// --------------------------------------------------------------------------
// One source of truth
// --------------------------------------------------------------------------

test("the canada schema gap is declared once and reused", () => {
  // Three separate maps drifting apart is exactly how AVP kept resurfacing in a new query.
  assert.equal(ACTIVE_CHANGE_SCAN_MISSING_COLUMNS_BY_TABLE, DEAL_SHEET_MISSING_COLUMNS_BY_TABLE);
  assert.equal(PARENT_DEAL_INHERIT_MISSING_COLUMNS_BY_TABLE, DEAL_SHEET_MISSING_COLUMNS_BY_TABLE);
});

test("both canada tables declare the same dropped columns", () => {
  for (const t of [CANADA, CANADA_ENDED]) {
    const missing = DEAL_SHEET_MISSING_COLUMNS_BY_TABLE.get(t);
    assert.ok(missing, `${t} must be registered`);
    assert.deepEqual([...missing].sort(), [...CANADA_DROPPED].sort(), t);
  }
});

test("health and locums declare no missing columns", () => {
  assert.equal(DEAL_SHEET_MISSING_COLUMNS_BY_TABLE.get(HEALTH), undefined);
  assert.equal(DEAL_SHEET_MISSING_COLUMNS_BY_TABLE.get(LOCUMS), undefined);
});

// --------------------------------------------------------------------------
// DELIVERY_POC backfill — the query that broke on 2026-08-24
// --------------------------------------------------------------------------

/** Rebuilds the per-table column set backfillDeliveryPocForActive now derives. */
function pocColumnsForTable(tableId) {
  const missing = DEAL_SHEET_MISSING_COLUMNS_BY_TABLE.get(tableId) ?? new Set();
  const cols = [];
  for (const slot of DELIVERY_POC_PRIORITY) {
    if (missing.has(slot.nameCol)) continue;
    cols.push(slot.nameCol, slot.empCol);
  }
  return cols;
}

test("the delivery-POC backfill never names AVP against canada", () => {
  const cols = pocColumnsForTable(CANADA);
  assert.ok(!cols.includes("AVP"), "AVP must not be selected");
  assert.ok(!cols.includes("AVP_EMP_NO"), "AVP_EMP_NO must not be selected");
  // Everything else in the priority chain survives.
  assert.ok(cols.includes("VP"));
  assert.ok(cols.includes("DELIVERY_DIRECTOR"));
  assert.ok(cols.includes("ACCOUNT_MANAGER"));
});

test("the delivery-POC backfill still names AVP against health and locums", () => {
  for (const t of [HEALTH, LOCUMS]) {
    const cols = pocColumnsForTable(t);
    assert.ok(cols.includes("AVP"), `${t} must keep AVP`);
    assert.ok(cols.includes("AVP_EMP_NO"), `${t} must keep AVP_EMP_NO`);
  }
});

test("the delivery-POC WHERE clause drops AVP only for canada", () => {
  const src = fs.readFileSync(path.join(__dirname, "bigQueryClient.js"), "utf8");
  assert.ok(
    src.includes('if (!missing.has("AVP")) whereParts.push(available("AVP"));'),
    "the WHERE must be built per table, not hardcoded"
  );
  assert.ok(
    !src.includes('WHERE ${available("AVP")} OR ${available("DELIVERY_DIRECTOR")}'),
    "the old hardcoded WHERE must be gone"
  );
});

// --------------------------------------------------------------------------
// The other query paths stay correct under the unified map
// --------------------------------------------------------------------------

test("change-scan union branches all have the same width", () => {
  const parts = buildActiveChangeScanUnionParts("rr_project_data");
  const widths = parts.map((p) => p.slice("SELECT ".length, p.indexOf(" FROM ")).split(",").length);
  assert.equal(new Set(widths).size, 1, `branch widths differ: ${widths.join(" / ")}`);
});

test("change-scan nulls AVP for canada and nothing for health", () => {
  const canada = buildActiveChangeScanColumnList(CANADA);
  assert.ok(canada.includes("CAST(NULL AS STRING) AS AVP"));
  assert.ok(canada.includes("CAST(NULL AS STRING) AS AVP_EMP_NO"));
  assert.ok(!buildActiveChangeScanColumnList(HEALTH).includes("CAST(NULL"));
});

test("parent-DEAL inherit drops exactly three columns for canada", () => {
  const health = resolveExtensionParentDealInheritColumns(HEALTH);
  const canada = resolveExtensionParentDealInheritColumns(CANADA);
  assert.equal(health.length - canada.length, 3);
  for (const c of ["FIFTYTWO_TENURE_RTO_LASTDATE", "FIFTYTWO_TENURE_CANDIDATE_STATUS", "CLIENT_NAME_IN_CONREP"]) {
    assert.ok(!canada.includes(c), c);
    assert.ok(health.includes(c), `health keeps ${c}`);
  }
});

// --------------------------------------------------------------------------
// Regression guard: no NEW hardcoded SQL may name a dropped column.
//
// This is the check that would have caught the AVP bug three times over. It scans the source for
// SQL string literals that name a canada-dropped column outside of a per-table guard.
// --------------------------------------------------------------------------

test("no SQL template literal hardcodes a canada-dropped column", () => {
  const src = fs.readFileSync(path.join(__dirname, "bigQueryClient.js"), "utf8");
  const offenders = [];
  src.split("\n").forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
    // Only lines that build SQL text.
    if (!/`\s*SELECT|FROM \$\{|WHERE |SELECT \$\{/.test(line)) return;
    for (const col of CANADA_DROPPED) {
      // A bare mention inside SQL text, not routed through a missing-columns check.
      if (new RegExp(`["'\`\\s(]${col}\\b`).test(line) && !/missing\.has|MISSING_COLUMNS/.test(line)) {
        offenders.push(`line ${i + 1}: ${trimmed.slice(0, 100)}`);
      }
    }
  });
  assert.deepEqual(
    offenders,
    [],
    `SQL hardcodes canada-dropped column(s):\n  ${offenders.join("\n  ")}`
  );
});

// --------------------------------------------------------------------------
// The prior-EXTENSION inherit query (broke 2026-08-24, revision -00016)
//
// It selects DEAL_RECRUITER_HIERARCHY_FIELDS from the DEAL SHEET table. That list names AVP and
// AVP_EMP_NO, which the canada tables do not have — so the query failed with
// "Unrecognized name: AVP" at line 77 of the generated SQL.
// --------------------------------------------------------------------------

const HIERARCHY_FIELDS = DEAL_RECRUITER_HIERARCHY_TARGETS.flatMap(
  ({ column, empNoColumn }) => [column, empNoColumn]
);

test("the hierarchy field list itself still names AVP", () => {
  // If this ever stops being true the filtering below is pointless — health needs these columns.
  assert.ok(HIERARCHY_FIELDS.includes("AVP"));
  assert.ok(HIERARCHY_FIELDS.includes("AVP_EMP_NO"));
});

test("hierarchy fields are filtered to what each table has", () => {
  const forTable = (t) => HIERARCHY_FIELDS.filter((c) => !resolveDealSheetMissingColumns(t).has(c));

  // Canada: AVP pair removed, everything else intact.
  const canada = forTable(CANADA);
  assert.ok(!canada.includes("AVP"));
  assert.ok(!canada.includes("AVP_EMP_NO"));
  assert.equal(canada.length, HIERARCHY_FIELDS.length - 2);
  assert.ok(canada.includes("VP"));
  assert.ok(canada.includes("TEAM_LEAD"));

  // Health and locums: untouched.
  for (const t of [HEALTH, LOCUMS]) {
    assert.deepEqual(forTable(t), HIERARCHY_FIELDS, t);
  }
});

test("a cross-table run drops columns missing from any table", () => {
  const missing = resolveDealSheetMissingColumns(undefined);
  for (const c of CANADA_DROPPED) assert.ok(missing.has(c), c);
});

test("resolveDealSheetMissingColumns is empty for tables with no gap", () => {
  assert.equal(resolveDealSheetMissingColumns(HEALTH).size, 0);
  assert.equal(resolveDealSheetMissingColumns(LOCUMS).size, 0);
  assert.equal(resolveDealSheetMissingColumns("unknown_table").size, 0);
});

test("the prior-extension query filters its column list", () => {
  const src = fs.readFileSync(path.join(__dirname, "bigQueryClient.js"), "utf8");
  assert.ok(
    /const priorLatestFields = \[\.\.\.DEAL_RECRUITER_HIERARCHY_FIELDS, \.\.\.priorManualExtraColumns\]\.filter\(/.test(src),
    "priorLatestFields must be filtered by the table's missing columns"
  );
  assert.ok(
    src.includes("].filter((col) => !parentMissingColumns.has(col));"),
    "the merge-side priorExtensionFields must be filtered the same way"
  );
});

// --------------------------------------------------------------------------
// Sweep: EVERY column list that reaches a Canada SELECT must be gap-filtered.
//
// This is the check that would have caught all three recurrences (AVP twice, then the
// FIFTYTWO_TENURE_* / CLIENT_NAME_IN_CONREP trio). Each entry below mirrors one real query's
// column set; all eight were dry-run against BigQuery and pass.
// --------------------------------------------------------------------------

const CANADA_RUNRATE_TABLE = "all_Health_Canada_data_Runrate";

test("no canada query path names a column its table lacks", () => {
  const dealSheetGap = [...resolveDealSheetMissingColumns(CANADA)];
  // Verified against the live all_Health_Canada_data_Runrate schema: it lacks the AVP pair and the
  // same three tenure/Conrep columns the deal sheet lacks.
  const runrateGap = [
    "AVP",
    "AVP_EMP_NO",
    "FIFTYTWO_TENURE_RTO_LASTDATE",
    "FIFTYTWO_TENURE_CANDIDATE_STATUS",
    "CLIENT_NAME_IN_CONREP",
  ];

  const paths = {
    "parent-DEAL inherit": [resolveExtensionParentDealInheritColumns(CANADA), dealSheetGap],
    "parent-DEAL inherit (ended)": [
      resolveExtensionParentDealInheritColumns(CANADA_ENDED),
      [...resolveDealSheetMissingColumns(CANADA_ENDED)],
    ],
    "prior-EXTENSION hierarchy": [
      HIERARCHY_FIELDS.filter((c) => !resolveDealSheetMissingColumns(CANADA).has(c)),
      dealSheetGap,
    ],
    "delivery-POC backfill": [pocColumnsForTable(CANADA), dealSheetGap],
    "run-rate manual columns": [legacyDealManualColumns(CANADA_RUNRATE_TABLE), runrateGap],
    "run-rate hierarchy": [
      resolveExtensionRunrateHierarchyColumns(CANADA_RUNRATE_TABLE).flatMap((c) => [c, `${c}_EMP_NO`]),
      runrateGap,
    ],
  };

  const failures = [];
  for (const [name, [cols, gap]] of Object.entries(paths)) {
    const leaked = cols.filter((c) => gap.includes(c));
    if (leaked.length) failures.push(`${name}: ${leaked.join(", ")}`);
  }
  assert.deepEqual(failures, [], `canada query paths name missing column(s):\n  ${failures.join("\n  ")}`);
});

test("the run-rate SELECT builds its manual list per table", () => {
  const src = fs.readFileSync(path.join(__dirname, "bigQueryClient.js"), "utf8");
  // The raw list must not be spread straight into the run-rate SELECT — that is exactly the bug
  // that produced "Unrecognized name: FIFTYTWO_TENURE_RTO_LASTDATE".
  assert.ok(
    src.includes("...legacyDealManualColumns(runrateTableId),"),
    "runrateSelectColumns must use the per-table manual list"
  );
  assert.ok(
    !/const runrateSelectColumns = \[\s*\.\.\.runrateHierarchyAndEmpNoColumns,\s*\.\.\.EXTENSION_RUNRATE_MANUAL_COLUMNS,/.test(src),
    "the raw manual list must not be spread into the run-rate SELECT"
  );
});

test("the run-rate merge reads exactly what the SELECT projected", () => {
  const src = fs.readFileSync(path.join(__dirname, "bigQueryClient.js"), "utf8");
  assert.ok(
    src.includes("for (const col of legacyDealManualColumns(runrateTableId)) {"),
    "the manual merge loop must use the per-table list"
  );
  assert.ok(
    src.includes("for (const col of runrateHierarchyColumns) {"),
    "the hierarchy merge loop must use the resolved list"
  );
});

// --------------------------------------------------------------------------
// A query may only ORDER BY / reference columns its inner union actually projects.
//
// fetchContractIdsByDealSheetIds ranked by LAST_UPDATED but built its union with only the base
// column set, which does not include it — "Unrecognized name: LAST_UPDATED". This is not a Canada
// gap: it failed for every domain, Canada just surfaced it.
// --------------------------------------------------------------------------

test("the base union column set does not silently contain LAST_UPDATED", () => {
  // If it is ever added to the base list this test documents why the explicit request exists.
  const base = buildActiveDealSheetsUnionSql("rr_project_data");
  const firstBranch = base.split(" UNION ALL ")[0];
  assert.ok(
    !firstBranch.includes("LAST_UPDATED"),
    "base union must stay lean; callers request extras explicitly"
  );
});

test("requesting LAST_UPDATED projects it on every union branch", () => {
  const withCol = buildActiveDealSheetsUnionSql("rr_project_data", undefined, ["LAST_UPDATED"]);
  const branches = withCol.split(" UNION ALL ");
  assert.equal(branches.length, 3, "all three active tables");
  for (const b of branches) {
    assert.ok(b.includes("LAST_UPDATED"), `branch missing LAST_UPDATED: ${b.slice(0, 80)}`);
  }
});

test("fetchContractIdsByDealSheetIds requests LAST_UPDATED for its ranking", () => {
  const src = fs.readFileSync(path.join(__dirname, "bigQueryClient.js"), "utf8");
  assert.ok(
    src.includes('buildActiveDealSheetsUnionSql(datasetId, undefined, ["LAST_UPDATED"]);'),
    "the CONTRACT_ID lookup ranks by LAST_UPDATED, so it must project it"
  );
});
