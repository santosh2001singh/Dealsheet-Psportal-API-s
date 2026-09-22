const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EXTENSION_PARENT_BACKFILL_TABLE_IDS,
  EXTRA_PARENT_BACKFILL_COLUMNS,
  GATE_COLUMNS,
  DATE_LIKE_COLUMNS,
  parentBackfillColumns,
  buildExtensionParentBackfillSql,
  backfillExtensionParentInherit,
} = require("./extensionParentBackfill");

const OPTS = { projectId: "p", datasetId: "d" };

test("scope is the cynet health active table", () => {
  assert.deepEqual([...EXTENSION_PARENT_BACKFILL_TABLE_IDS], ["cynet_health_deal_sheet"]);
});

test("all 64 inherited columns are filled, contract identity included", () => {
  const cols = parentBackfillColumns();
  assert.equal(cols.length, 64);
  for (const expected of [
    "CONTRACT_ID",
    "SKU_NUMBER",
    "INITIAL_START_DATE",
    "NEW_HIRE_DATE",
    "VP",
    "VP_EMP_NO",
    "ACCOUNT_MANAGER",
    "RM",
    "ATL",
    "TEAM_LEAD",
    "DELIVERY_DIRECTOR",
    "CREDENTIALING_LEAD",
    "PRIMARY_SALES_PERSON",
    "CLIENT_PAYMENT_TERMS",
    "ENTITY",
    "ST_DT_PUSHBACK_REASON",
    "CLIENT_NAME_IN_CONREP",
  ]) {
    assert.ok(cols.includes(expected), `${expected} is filled`);
  }
});

test("the column list has no duplicates", () => {
  const cols = parentBackfillColumns();
  assert.equal(new Set(cols).size, cols.length);
});

test("the extra columns extend the insert path's list rather than replacing it", () => {
  const cols = parentBackfillColumns();
  for (const col of EXTRA_PARENT_BACKFILL_COLUMNS) assert.ok(cols.includes(col));
  // These come from EXTENSION_PARENT_DEAL_INHERIT_COLUMNS, which the insert path owns.
  assert.ok(cols.includes("CONTRACT_ID"));
  assert.ok(cols.includes("ACC_DIR_OR_VERT_HEAD"));
});

// --- fill-if-empty is the whole safety argument -----------------------------------------------------

test("every column is fill-if-empty, so a populated value is never overwritten", () => {
  const { sql } = buildExtensionParentBackfillSql(OPTS);
  for (const col of parentBackfillColumns()) {
    if (DATE_LIKE_COLUMNS.has(col)) {
      // Existing value is IFNULL's first argument => it always wins.
      assert.match(sql, new RegExp(`${col} = IFNULL\\(d\\.${col}, s\\.${col}\\)`), col);
    } else {
      assert.match(
        sql,
        new RegExp(`${col} = IFNULL\\(NULLIF\\(TRIM\\(IFNULL\\(d\\.${col}`),
        col
      );
    }
  }
});

// Measured on a full clone of the live table: 0 CONTRACT_ID / 0 SKU_NUMBER changed, 18 / 75 newly
// filled. The 58 rows whose extension CONTRACT_ID differs from their parent's stay untouched.
test("CONTRACT_ID cannot be rewritten when the row already has one", () => {
  const { sql } = buildExtensionParentBackfillSql(OPTS);
  assert.match(sql, /CONTRACT_ID = IFNULL\(NULLIF\(TRIM\(IFNULL\(d\.CONTRACT_ID, ''\)\), ''\), s\.CONTRACT_ID\)/);
});

test("date-like columns are compared with IS NULL, never TRIM()ed", () => {
  const { sql } = buildExtensionParentBackfillSql(OPTS);
  for (const col of ["NEW_HIRE_DATE", "INITIAL_START_DATE", "FIFTYTWO_TENURE_RTO_LASTDATE"]) {
    assert.ok(DATE_LIKE_COLUMNS.has(col), `${col} is treated as a date`);
    assert.ok(!sql.includes(`TRIM(IFNULL(d.${col}`), `${col} is not TRIM()ed`);
  }
});

test("it only updates EXTENSION rows, and only when the parent can supply something", () => {
  const { sql } = buildExtensionParentBackfillSql(OPTS);
  assert.match(sql, /UPPER\(TRIM\(IFNULL\(d\.DEAL_TYPE, ''\)\)\) = 'EXTENSION'/);
  for (const col of GATE_COLUMNS) {
    assert.ok(sql.includes(`AND s.${col} IS NOT NULL`), `${col} gates on the parent having a value`);
  }
});

// --- parent identity -------------------------------------------------------------------------------

test("the parent match is the same 4-field identity the insert path uses", () => {
  const { sql } = buildExtensionParentBackfillSql(OPTS);
  assert.match(sql, /d\.CANDIDATE_ID = e\.CANDIDATE_ID/);
  assert.match(sql, /d\.em = e\.em/);
  assert.match(sql, /d\.ph = e\.ph/);
  assert.match(sql, /d\.CLIENT_ID = e\.CLIENT_ID/);
});

// Without this guard a LATER deal is picked as "parent": a live extension starting 2026-04-01 matched
// a deal starting 2026-07-01. The insert path lacks this condition; the backfill adds it.
test("the parent must start on or before the extension", () => {
  const { sql } = buildExtensionParentBackfillSql(OPTS);
  assert.match(sql, /d\.START_DATE <= e\.START_DATE/);
});

// DESC, matching fetchExtensionParentDealInheritByPlacementId. This pass ordered ASC, so on every
// run it handed a candidate's FIRST-EVER deal to an extension of a much later contract — the exact
// "earliest-wins" bug the insert path had already fixed. It is also what decides the parent while an
// extension has no CONTRACT_ID for the guard below to compare.
test("the latest qualifying parent wins, as on the insert path", () => {
  const { sql } = buildExtensionParentBackfillSql(OPTS);
  assert.match(sql, /ORDER BY d\.START_DATE DESC NULLS LAST/);
  assert.ok(
    !/ORDER BY d\.START_DATE ASC/.test(sql),
    "earliest-wins ordering must not come back"
  );
});

// The START_DATE guard only rejects LATER deals. A candidate's PREVIOUS, already-ended contract
// predates the extension and sails through it, and the 4-field identity cannot tell the two apart
// because successive contracts at one client share all four. Live case (CANDIDATE_ID 21472994):
// CHC22011's extensions inherited ended contract CHC18361's INITIAL_START_DATE,
// BACKOUT_OR_TERMINATION, COMMENTS and ST_DT_PUSHBACK_REASON.
test("the parent must belong to the same contract", () => {
  const { sql } = buildExtensionParentBackfillSql(OPTS);
  assert.match(
    sql,
    /AND \(e\.ext_contract_id IS NULL OR d\.parent_contract_id = e\.ext_contract_id\)/
  );
});

// Both sides alias CONTRACT_ID: the parent's is already projected by the inherit column list, and a
// second bare mention makes BigQuery reject the whole script with "Name CONTRACT_ID is ambiguous
// inside d" — the failure ACC_DIR_OR_VERT_HEAD caused on the insert path in Aug 2026.
test("the contract guard reads aliased columns, never a bare duplicate CONTRACT_ID", () => {
  const { sql } = buildExtensionParentBackfillSql(OPTS);
  assert.match(sql, /NULLIF\(TRIM\(IFNULL\(CONTRACT_ID, ''\)\), ''\) AS ext_contract_id/);
  assert.match(sql, /NULLIF\(TRIM\(IFNULL\(CONTRACT_ID, ''\)\), ''\) AS parent_contract_id/);
  // The alias is projected only to be compared, so it must not reach the temp table / SET list.
  assert.match(sql, /EXCEPT\(CANDIDATE_ID, CLIENT_ID, START_DATE, LAST_UPDATED, em, ph, parent_contract_id\)/);
});

// The deal sheet is append-only: without one-row-per-id the UPDATE dies with "UPDATE/MERGE must match
// at most one source row for each target row".
test("both sides are deduped to one row per DEAL_SHEET_ID", () => {
  const { sql } = buildExtensionParentBackfillSql(OPTS);
  assert.match(sql, /PARTITION BY DEAL_SHEET_ID/);
  assert.match(sql, /LAST_UPDATED DESC NULLS LAST/);
});

test("it is UPDATE-only — an INSERT would append a duplicate row every run", () => {
  const { sql } = buildExtensionParentBackfillSql(OPTS);
  assert.match(sql, /^UPDATE /m);
  assert.ok(!/INSERT\s+INTO/i.test(sql), "no INSERT");
});

// `SET x = @@row_count` is itself a statement, so it reports the SET's row count (0), not the UPDATE's.
test("the count is taken before the UPDATE, not from @@row_count", () => {
  const { sql } = buildExtensionParentBackfillSql(OPTS);
  // Only the explanatory comment may mention it; no real statement may assign the counter from it.
  assert.ok(
    !/SET\s+filled_\d+_rows\s*=\s*@@row_count/.test(sql),
    "the counter is never assigned from @@row_count"
  );
  assert.match(sql, /SET filled_0_rows = \([\s\S]*?SELECT COUNT\(\*\)/);
});

test("explicit tableIds override the default", () => {
  const { tableIds } = buildExtensionParentBackfillSql({ ...OPTS, tableIds: ["other_table"] });
  assert.deepEqual(tableIds, ["other_table"]);
});

// --- orchestration ---------------------------------------------------------------------------------

test("backfillExtensionParentInherit reports per-table counts", async () => {
  const result = await backfillExtensionParentInherit(OPTS, {
    queryFn: async () => [{ table_id: "cynet_health_deal_sheet", filled_rows: 79 }],
  });
  assert.equal(result.updated, 79);
  assert.equal(result.byTable["cynet_health_deal_sheet"], 79);
});

test("an unreadable count reports null rather than a wrong zero", async () => {
  const result = await backfillExtensionParentInherit(OPTS, { queryFn: async () => [] });
  assert.equal(result.updated, null, "the UPDATEs ran; only the counts could not be read back");
});

test("it requires a queryFn", async () => {
  await assert.rejects(() => backfillExtensionParentInherit(OPTS, {}), /requires deps\.queryFn/);
});
