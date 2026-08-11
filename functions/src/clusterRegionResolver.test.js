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
// gap to be filled from the recruiter's current alignment. APC-2 ends in a digit, ENT-3 too, but
// LOC-*/EXC-*/SPC-* could end in a letter, so the family prefix decides, not the final character.
test("legacy cluster codes carry no specialty", () => {
  for (const code of ["LOC-4", "LOC-12", "ENT-3", "APC-2", "EXC-1", "SPC-2", "Gov Region 1", "Gov School"]) {
    assert.equal(recruiterSpecialtyFromCode(code), null, `${code} has no specialty`);
  }
});

test("a blank or missing code has no specialty", () => {
  for (const code of [null, undefined, "", "   "]) {
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
  // "Governor's ..." style names must not trip the prefix test.
  assert.equal(isGovernmentClient("Target", "GOVERNORS-1"), false);
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

test("the resolved SQL implements the Step 1 date rule for both deal types", () => {
  const sql = buildClusterRegionResolvedSql("cynet_health_deal_sheet", SQL_OPTS);
  // EXTENSION -> EXTENSION_DATE then START_DATE; anything else -> SUBMISSION_DATE then START_DATE.
  assert.match(sql, /COALESCE\(DATE\(EXTENSION_DATE\), START_DATE\)/);
  assert.match(sql, /COALESCE\(DATE\(SUBMISSION_DATE\), START_DATE\)/);
});

test("the recruiter side reads NEW_CLUSTER on/before and OLD_CLUSTER as the fallback", () => {
  const sql = buildClusterRegionResolvedSql("cynet_health_deal_sheet", SQL_OPTS);
  assert.match(sql, /r\.EFFECTIVE_DATE <= b\.as_of_date/, "latest change on or before the placement");
  assert.match(sql, /EFFECTIVE_DATE DESC/, "latest wins for the on/before tier");
  assert.match(sql, /EFFECTIVE_DATE ASC/, "earliest row supplies the OLD_CLUSTER fallback");
  assert.ok(sql.includes(RECRUITER_CODE_SOURCE.OLD_CLUSTER));
  assert.ok(sql.includes(RECRUITER_CODE_SOURCE.NOT_IN_LOG));
});

test("the client side matches MSP case-insensitively and treats State as a /-delimited list", () => {
  const sql = buildClusterRegionResolvedSql("cynet_health_deal_sheet", SQL_OPTS);
  assert.match(sql, /LOWER\(TRIM\(IFNULL\(n\.MSP_Name, ''\)\)\)\s*= b\.msp_key/);
  assert.match(sql, /IN UNNEST\(SPLIT\(UPPER\(TRIM\(IFNULL\(n\.State, ''\)\)\), '\/'\)\)/);
  assert.match(sql, /n\.Date <= b\.as_of_date/, "3a is effective-dated");
});

test("the health_system_cluster fallback accepts State='ALL' and is labelled not effective-dated", () => {
  const sql = buildClusterRegionResolvedSql("cynet_health_deal_sheet", SQL_OPTS);
  assert.match(sql, /UPPER\(TRIM\(IFNULL\(h\.State, ''\)\)\) = 'ALL'/);
  // That table has no date column, so the label has to say so — a reader must not mistake it for history.
  assert.equal(CLIENT_CODE_SOURCE.HEALTH_SYSTEM_CLUSTER, "health_system_cluster (not effective-dated)");
  assert.ok(sql.includes(CLIENT_CODE_SOURCE.HEALTH_SYSTEM_CLUSTER));
  assert.ok(!/h\.Date/.test(sql), "no date filter is applied to the fallback table");
});

test("WHY_BLANK distinguishes the three client-side failure modes", () => {
  const sql = buildClusterRegionResolvedSql("cynet_health_deal_sheet", SQL_OPTS);
  for (const reason of [
    WHY_BLANK.CLIENT_ABSENT,
    WHY_BLANK.MSP_MISMATCH,
    WHY_BLANK.STATE_NOT_COVERED,
    WHY_BLANK.RECRUITER_NOT_IN_LOG,
  ]) {
    assert.ok(sql.includes(reason), `${reason} is reported`);
  }
});

// MSP spellings are deliberately not aliased: a mismatch is surfaced as a data gap, not guessed at.
test("no MSP alias table is applied", () => {
  const sql = buildClusterRegionResolvedSql("cynet_health_deal_sheet", SQL_OPTS);
  assert.ok(!/healthtrust workforce/i.test(sql), "no hand-rolled MSP aliasing");
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
  assert.ok(!sql.includes("ended"), "the ended table lacks the three columns");
  assert.ok(!sql.includes("canada"), "canada is out of scope");
  assert.ok(!sql.includes("locums"), "locums is out of scope");
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
