const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CLUSTER_REGION_TABLE_IDS,
  CLUSTER_TRACE_TABLE_ID,
  REGIONAL_PROGRAMME_START_DATE,
  PROGRAMME,
  CLIENT_CODE_SOURCE,
  RECRUITER_CODE_SOURCE,
  WHY_BLANK,
  isGovernmentClient,
  recruiterSpecialtyFromCode,
  resolveProgramme,
  buildClusterRegionResolvedSql,
  buildClusterRegionFillSql,
  buildClusterRegionTraceSql,
  backfillClusterRegions,
} = require("./clusterRegionResolver");

const SQL_OPTS = { projectId: "p", datasetId: "d" };

// The live ended table predates all three columns (181 vs 199 columns; it still has the older
// RECRUITER_CLUSTER and no CLIENT_CLUSTER_REGION / CLUSTER_TYPE) even though its DDL declares them,
// so referencing it fails with "Unrecognized name: RECRUITER_CLUSTER_REGION".
test("scope is the cynet health ACTIVE table only", () => {
  assert.deepEqual([...CLUSTER_REGION_TABLE_IDS], ["cynet_health_deal_sheet"]);
});

test("the regional cutover date is 2026-06-01", () => {
  assert.equal(REGIONAL_PROGRAMME_START_DATE, "2026-06-01");
});

// --- Step 2: specialty rides the last letter of a REGIONAL code only -------------------------------

test("regional codes carry specialty in their last letter", () => {
  assert.equal(recruiterSpecialtyFromCode("R1N"), "Nursing");
  assert.equal(recruiterSpecialtyFromCode("R3N"), "Nursing");
  assert.equal(recruiterSpecialtyFromCode("SPOT-N"), "Nursing");
  assert.equal(recruiterSpecialtyFromCode("R2A"), "Allied");
  assert.equal(recruiterSpecialtyFromCode("R3A"), "Allied");
  assert.equal(recruiterSpecialtyFromCode("SPOT-A"), "Allied");
});

// Legacy families predate the regional programme, so a blank specialty is the correct answer — not a
// gap to be filled from the recruiter's current alignment. LOC-*/EXC-*/SPC-* could end in a letter,
// so the family prefix decides, not the final character.
test("legacy cluster codes carry no specialty", () => {
  for (const code of ["LOC-4", "LOC-12", "ENT-3", "EXC-1", "SPC-2", "Gov Region 1", "Gov School"]) {
    assert.equal(recruiterSpecialtyFromCode(code), null, `${code} has no specialty`);
  }
});

// The report: an APC cluster IS the Allied specialty, though its last character is a digit.
test("an APC cluster is Allied", () => {
  assert.equal(recruiterSpecialtyFromCode("APC-2"), "Allied");
});

test("a blank, missing or NA code has no specialty", () => {
  for (const code of [null, undefined, "", "   ", "NA"]) {
    assert.equal(recruiterSpecialtyFromCode(code), null);
  }
});

// --- Step 4: government wins over the date --------------------------------------------------------

test("government is detected from the cluster type or the code shape", () => {
  assert.equal(isGovernmentClient("Government", "LOC-2"), true);
  assert.equal(isGovernmentClient("government", null), true);
  assert.equal(isGovernmentClient("Target", "Gov Region 1"), true);
  assert.equal(isGovernmentClient(null, "Gov School"), true);
  assert.equal(isGovernmentClient("Territory", "SLED 3"), true);
});

test("a non-government client is not mistaken for one", () => {
  assert.equal(isGovernmentClient("Target", "LOC-1"), false);
  assert.equal(isGovernmentClient("Territory", "R1N"), false);
  assert.equal(isGovernmentClient(null, null), false);
  // getClusterType checks LOC / ENT / APC before GOV.
  assert.equal(isGovernmentClient(null, "LOC-GOV"), false);
});

test("programme follows the cutover date for non-government clients", () => {
  assert.equal(resolveProgramme("2026-07-20", "Target", "R1N"), PROGRAMME.REGIONAL);
  assert.equal(resolveProgramme("2026-06-01", "Target", "R1N"), PROGRAMME.REGIONAL, "on the day itself");
  assert.equal(resolveProgramme("2026-05-31", "Target", "LOC-1"), PROGRAMME.CLUSTER, "the day before");
  assert.equal(resolveProgramme("2026-05-07", "Target", "LOC-5"), PROGRAMME.CLUSTER);
});

// Spec example H: an NCDAC placement submitted 2026-06-08 whose recruiter moved LOC-2 -> R1A on
// 2026-06-01 stays on Government rules. The client decides the programme, not the recruiter.
test("a government client stays on cluster rules after the cutover", () => {
  assert.equal(resolveProgramme("2026-06-08", "Government", "Gov Region 1"), PROGRAMME.GOVERNMENT);
  assert.equal(resolveProgramme("2026-12-31", "Government", "Gov School"), PROGRAMME.GOVERNMENT);
});

test("an unresolvable date falls back to cluster rules rather than claiming Regional", () => {
  for (const bad of [null, undefined, "", "not-a-date"]) {
    assert.equal(resolveProgramme(bad, "Target", "LOC-1"), PROGRAMME.CLUSTER);
  }
});

// --- SQL shape -------------------------------------------------------------------------------------

// resolveAlignmentAsOfDate: deals split on the start date at the cutover, extensions past it read
// the submission, and a Government client always reads the submission.
test("the recruiter as-of date follows the report's cutover splits", () => {
  const sql = buildClusterRegionResolvedSql("cynet_health_deal_sheet", SQL_OPTS);
  assert.match(sql, /AND b\.sub IS NOT NULL THEN b\.sub/, "government client -> submission");
  assert.match(sql, /WHEN b\.is_ext AND b\.post_june_ext THEN COALESCE\(b\.sub, b\.ost, b\.st\)/);
  assert.match(sql, /WHEN b\.st >= DATE '2026-06-01' THEN b\.st/, "deal starting after the cutover -> start");
});

// Only an extension of a contract started before the cutover leaves the Regional programme, and a
// contract started after it reads every extension's recruiter region on its original start.
test("an extension of a contract started after the cutover stays Regional on its start-date region", () => {
  const sql = buildClusterRegionResolvedSql("cynet_health_deal_sheet", SQL_OPTS);
  assert.match(sql, /INITIAL_START_DATE    AS ost/);
  assert.match(
    sql,
    /b\.is_ext AND NOT IFNULL\(b\.ost >= DATE '2026-06-01', FALSE\) AND IFNULL\(b\.ext >= DATE '2026-06-01', FALSE\) AS post_june_ext/
  );
  assert.match(sql, /WHEN b\.is_ext AND b\.ost >= DATE '2026-06-01' THEN b\.ost/);
});

test("the client cluster is looked up as of submission, then extension date, then start", () => {
  const sql = buildClusterRegionResolvedSql("cynet_health_deal_sheet", SQL_OPTS);
  assert.match(sql, /COALESCE\(b\.sub, IF\(b\.is_ext, b\.ext, NULL\), b\.st\) AS client_lookup_date/);
});

// A blank NEW_CLUSTER is a removal, pre-2025 work reads 2025-10-31, and OLD_CLUSTER is never used.
test("the recruiter log keeps removals, uses the pre-log reference and never OLD_CLUSTER", () => {
  const sql = buildClusterRegionResolvedSql("cynet_health_deal_sheet", SQL_OPTS);
  assert.match(sql, /TRIM\(IFNULL\(NEW_CLUSTER, ''\)\) AS new_code/);
  assert.ok(!/OLD_CLUSTER/.test(sql.replace(/client_logs_new/g, "")), "OLD_CLUSTER is not read");
  assert.match(sql, /l\.eff <= DATE '2025-10-31'/);
  assert.ok(sql.includes(RECRUITER_CODE_SOURCE.REMOVED));
  assert.ok(sql.includes(RECRUITER_CODE_SOURCE.BEFORE_LOG));
  assert.ok(sql.includes("Cluster_Data.rec_cluster`"), "rec_cluster answers for a recruiter absent from the log");
});

// buildRecruiterRegionHistoryMap: Recruiter Region Logs is the history, the old table only while it is empty.
test("the recruiter history is Recruiter Region Logs, converted to the report's change log", () => {
  const sql = buildClusterRegionResolvedSql("cynet_health_deal_sheet", SQL_OPTS);
  assert.ok(sql.includes("`p.d.Recruiter_Region_logs`"));
  assert.match(sql, /IFNULL\(IS_DELETED, FALSE\) = FALSE/, "archived rows are skipped");
  assert.match(sql, /IN \('', 'NA'\), 'NA', TRIM\(NEW_REGION_CODE\)\)/, "blank region is NA");
  assert.match(sql, /DATE_ADD\(r\.end_d, INTERVAL 1 DAY\) >= DATE '2026-06-01'/, "removals only from 6/1/2026");
  assert.match(sql, /AND NOT EXISTS \(SELECT 1 FROM rrl_rows\)/, "old table only while the new one is empty");
  assert.match(sql, /ORDER BY l\.eff DESC, IF\(l\.new_code = 'NA', 1, 0\), l\.new_code/, "region beats NA on a date");
});

test("the client side matches state as a /-delimited list or ALL, MSP only narrowing", () => {
  const sql = buildClusterRegionResolvedSql("cynet_health_deal_sheet", SQL_OPTS);
  assert.match(sql, /n\.state_up = 'ALL' OR r\.state_key IN UNNEST\(n\.state_list\)/);
  assert.match(sql, /n_in_force_msp = 0 OR msp_hit/, "MSP narrows only when it matches");
  assert.match(sql, /NOT n\.is_region_row/, "APC region rows are not client rows");
  assert.match(sql, /r\.apc_ok OR NOT n\.is_apc/, "APC rows only when permitted");
});

test("health_system_cluster is the Cluster_Data copy, for Jan-May 2025 submissions only", () => {
  const sql = buildClusterRegionResolvedSql("cynet_health_deal_sheet", SQL_OPTS);
  assert.ok(sql.includes("`p.Cluster_Data.health_system_cluster`"));
  assert.match(sql, /b\.sub BETWEEN DATE '2025-01-01' AND DATE '2025-05-31'/);
  assert.match(sql, /WHEN 'NCDAC' THEN 'State of NC'/);
});

test("Regional rows read client_alignment and client_logs_new and show the Regional type", () => {
  const sql = buildClusterRegionResolvedSql("cynet_health_deal_sheet", SQL_OPTS);
  assert.ok(sql.includes("`p.Cluster_Data.client_alignment`"));
  assert.ok(sql.includes("`p.Cluster_Data.client_logs_new`"));
  assert.match(sql, /c\.division_up = b\.offering_up/, "the block must match the placement's speciality");
  assert.match(sql, /IF\(p\.is_regional, 'Regional', p\.client_cluster_model_type\)/);
});

test("retired EXC codes display as Gov Region", () => {
  const sql = buildClusterRegionResolvedSql("cynet_health_deal_sheet", SQL_OPTS);
  assert.match(sql, /CONCAT\('Gov Region ', REGEXP_EXTRACT/);
});

test("WHY_BLANK names the failing side", () => {
  const sql = buildClusterRegionResolvedSql("cynet_health_deal_sheet", SQL_OPTS);
  for (const reason of [
    WHY_BLANK.CLIENT_ABSENT,
    WHY_BLANK.CLIENT_DATA_ENDED,
    WHY_BLANK.CLIENT_ADDED_LATER,
    WHY_BLANK.RECRUITER_REMOVED,
    WHY_BLANK.REGION_NOT_ALIGNED,
  ]) {
    assert.ok(sql.includes(reason), `${reason} is reported`);
  }
});

test("no value in the generated SQL breaks a string literal", () => {
  for (const reason of Object.values(WHY_BLANK)) assert.ok(!reason.includes("'"), reason);
  for (const src of Object.values(CLIENT_CODE_SOURCE)) assert.ok(!src.includes("'"), src);
  for (const src of Object.values(RECRUITER_CODE_SOURCE)) assert.ok(!src.includes("'"), src);
});

// --- fill-if-empty ---------------------------------------------------------------------------------

test("the fill is fill-if-empty on all three columns", () => {
  const { sql, tableIds } = buildClusterRegionFillSql(SQL_OPTS);
  assert.deepEqual(tableIds, [...CLUSTER_REGION_TABLE_IDS]);
  for (const col of ["RECRUITER_CLUSTER_REGION", "CLIENT_CLUSTER_REGION", "CLUSTER_TYPE"]) {
    // Existing value first inside IFNULL => a populated column keeps whatever it already had.
    assert.match(
      sql,
      new RegExp(`${col} = IFNULL\\(\\s*NULLIF\\(TRIM\\(IFNULL\\(d\\.${col}`),
      `${col} keeps a hand-edited value`
    );
  }
});

test("the fill only touches rows where a blank column actually resolved to something", () => {
  const { sql } = buildClusterRegionFillSql(SQL_OPTS);
  assert.match(sql, /AND s\.recruiter_code IS NOT NULL/);
  assert.match(sql, /AND s\.client_code IS NOT NULL/);
  assert.match(sql, /AND s\.client_cluster_type IS NOT NULL/);
});

test("overwrite replaces differing values but never erases one with a blank resolution", () => {
  const { sql } = buildClusterRegionFillSql({ ...SQL_OPTS, overwrite: true });
  for (const [col, src] of [
    ["RECRUITER_CLUSTER_REGION", "recruiter_code"],
    ["CLIENT_CLUSTER_REGION", "client_code"],
    ["CLUSTER_TYPE", "client_cluster_type"],
  ]) {
    assert.ok(sql.includes(`${col} = IFNULL(s.${src}, d.${col})`), `${col} keeps its value on a blank`);
    assert.ok(sql.includes(`s.${src} IS NOT NULL AND IFNULL(TRIM(d.${col}), '') != s.${src}`));
  }
});

// The deal sheet is append-only: one placement owns several rows (4,686 rows over 4,410 ids when this
// was found). Without a one-row-per-id guard the UPDATE dies with "UPDATE/MERGE must match at most one
// source row for each target row" — and it only passed earlier because the table transiently had no
// duplicates.
test("the resolved set is deduped to one row per DEAL_SHEET_ID", () => {
  const sql = buildClusterRegionResolvedSql("cynet_health_deal_sheet", SQL_OPTS);
  assert.match(sql, /PARTITION BY DEAL_SHEET_ID/, "one row per id");
  assert.match(sql, /LAST_UPDATED DESC NULLS LAST/, "the newest row wins");
  assert.match(sql, /WHERE rn = 1/);
});

test("the fill covers the cynet health active table and no others", () => {
  const { sql } = buildClusterRegionFillSql(SQL_OPTS);
  assert.ok(sql.includes("cynet_health_deal_sheet"));
  assert.ok(!sql.includes("ended_deal_sheet"), "the ended table lacks the three columns");
  assert.ok(!sql.includes("canada_deal_sheet"), "canada is out of scope");
  assert.ok(!sql.includes("locums_deal_sheet"), "locums is out of scope");
});

test("explicit tableIds override the default pair", () => {
  const { tableIds } = buildClusterRegionFillSql({ ...SQL_OPTS, tableIds: ["cynet_health_deal_sheet"] });
  assert.deepEqual(tableIds, ["cynet_health_deal_sheet"]);
});

// --- trace table -----------------------------------------------------------------------------------

test("the trace table carries the full reasoning the deal sheet has no room for", () => {
  const { sql, traceTableId } = buildClusterRegionTraceSql(SQL_OPTS);
  assert.equal(traceTableId, CLUSTER_TRACE_TABLE_ID);
  for (const col of [
    "AS_OF_DATE",
    "AS_OF_DATE_SOURCE",
    "RECRUITER_CODE",
    "RECRUITER_CODE_SOURCE",
    "RECRUITER_SPECIALTY",
    "CLIENT_CODE",
    "CLIENT_CODE_SOURCE",
    "CLIENT_CLUSTER_TYPE",
    "PROGRAMME",
    "WHY_BLANK",
  ]) {
    assert.ok(sql.includes(col), `${col} is in the trace table`);
  }
  assert.match(sql, /CREATE OR REPLACE TABLE/, "rebuilt from scratch, so it is idempotent");
  assert.match(sql, /SOURCE_TABLE/, "active and ended rows stay distinguishable");
});

// --- orchestration ---------------------------------------------------------------------------------

test("backfillClusterRegions reports per-table counts and rebuilds the trace", async () => {
  const seen = [];
  const result = await backfillClusterRegions(SQL_OPTS, {
    queryFn: async (sql) => {
      seen.push(sql);
      if (/CREATE OR REPLACE TABLE/.test(sql)) return [];
      return [{ table_id: "cynet_health_deal_sheet", changed_rows: 900 }];
    },
  });
  assert.equal(result.updated, 900);
  assert.equal(result.byTable["cynet_health_deal_sheet"], 900);
  assert.equal(result.traceTableId, CLUSTER_TRACE_TABLE_ID);
  assert.equal(seen.length, 2, "one fill job, one trace rebuild");
});

test("skipTrace runs the fill without rebuilding the trace table", async () => {
  let calls = 0;
  const result = await backfillClusterRegions(
    { ...SQL_OPTS, skipTrace: true },
    { queryFn: async () => { calls++; return [{ table_id: "cynet_health_deal_sheet", changed_rows: 5 }]; } }
  );
  assert.equal(calls, 1);
  assert.equal(result.traceTableId, null);
  assert.equal(result.updated, 5);
});

test("an unreadable count result reports null rather than a wrong zero", async () => {
  const result = await backfillClusterRegions(
    { ...SQL_OPTS, skipTrace: true },
    { queryFn: async () => [] }
  );
  assert.equal(result.updated, null, "the UPDATEs ran; only the counts could not be read back");
});

test("backfillClusterRegions requires a queryFn", async () => {
  await assert.rejects(() => backfillClusterRegions(SQL_OPTS, {}), /requires deps\.queryFn/);
});
