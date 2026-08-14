/**
 * Post-sync repair for EXTENSION rows whose parent DEAL arrived AFTER them.
 *
 * applyExtensionInheritForInsertRows runs at INSERT time only: it looks for the parent DEAL in the
 * destination table and copies the contract identity + hierarchy + ops fields off it. When the
 * extension is synced BEFORE its parent DEAL — which happens routinely, because the two are separate
 * Nexus records that can be created months apart and no sync orders them (398 live rows had an
 * extension whose LAST_UPDATED predates its parent's) — that lookup finds nothing and the row is
 * written with every inherited field null. Nothing goes back to fix it afterwards.
 *
 * This is that missing pass. Same idea as the EXT_OR_REHIRE_BY_RMG recompute, which exists for the
 * same class of problem ("a new extension has to flip its PARENT DEAL row, which insert-time rules
 * cannot do") — except that one only ever fixed a single column.
 *
 * Parent identity is the SAME 4-field match the insert path uses
 * (fetchExtensionParentDealInheritByPlacementId): CANDIDATE_ID + CANDIDATE_EMAIL + CELL_PHONE +
 * CLIENT_ID, taking the earliest matching DEAL. One condition is ADDED here that the insert path does
 * not have: the parent must start on or before the extension (`d.START_DATE <= e.START_DATE`).
 * Without it a LATER deal for the same candidate is picked as "parent" — e.g. an extension starting
 * 2026-04-01 was matched to a deal starting 2026-07-01, which is not its parent at all.
 *
 * SAFETY (why this cannot corrupt a CONTRACT_ID):
 *   - FILL-IF-EMPTY only. Every assignment is `IFNULL(existing, parent)`, so a populated column is
 *     rewritten to its own value. Measured on a full clone of the live table: 0 CONTRACT_ID and 0
 *     SKU_NUMBER changed, 18 CONTRACT_ID and 75 SKU_NUMBER newly filled. The 58 rows whose extension
 *     CONTRACT_ID legitimately differs from their parent's are untouched, because they are not blank.
 *   - UPDATE only, never INSERT — the deal sheet is append-only, so an insert here would add a
 *     duplicate row on every run.
 *   - Idempotent: a settled table updates 0 rows.
 *
 * Scope is the cynet health active table. The ended table is excluded for the same reason as the
 * cluster/region fill: its live schema predates several of these columns.
 */

const config = require("./config");
const { EXTENSION_PARENT_DEAL_INHERIT_COLUMNS } = require("./bigQueryClient");

/** Tables this pass repairs. */
const EXTENSION_PARENT_BACKFILL_TABLE_IDS = Object.freeze(["cynet_health_deal_sheet"]);

/**
 * Columns filled from the parent DEAL, on top of EXTENSION_PARENT_DEAL_INHERIT_COLUMNS (which the
 * insert path already defines and which already covers CONTRACT_ID / SKU_NUMBER / hierarchy / ops).
 *
 * INITIAL_START_DATE is handled separately (the parent supplies
 * COALESCE(INITIAL_START_DATE, START_DATE), not the raw column), so it is not listed here.
 *
 * Now EMPTY: every column that used to live here moved into
 * EXTENSION_PARENT_DEAL_INHERIT_COLUMNS so the insert path and this repair pass read one list and
 * cannot drift. parentBackfillColumns() de-duplicates, so leaving entries here would be harmless —
 * but a second list is exactly how the two sides fell out of step before. Add new parent-inheritable
 * columns to EXTENSION_PARENT_DEAL_INHERIT_COLUMNS instead.
 */
const EXTRA_PARENT_BACKFILL_COLUMNS = Object.freeze([]);

/** DATE/TIMESTAMP columns: compared with a plain IS NULL, never TRIM()ed. */
const DATE_LIKE_COLUMNS = new Set([
  "NEW_HIRE_DATE",
  "INITIAL_START_DATE",
  "FIFTYTWO_TENURE_RTO_LASTDATE",
]);

/**
 * Columns whose blankness gates the UPDATE. Deliberately a SUBSET of the filled columns: the WHERE
 * clause only has to prove the row needs *something*, and a short list keeps the SQL readable. Every
 * column in the SET list is still filled once the row qualifies.
 */
const GATE_COLUMNS = Object.freeze([
  "CONTRACT_ID",
  "SKU_NUMBER",
  "ENTITY",
  "VP",
  "ACCOUNT_MANAGER",
  "RM",
  "CREDENTIALING_LEAD",
  "PRIMARY_SALES_PERSON",
  "NEW_HIRE_DATE",
  "INITIAL_START_DATE",
  // Null on every existing row of the table, so without them in the gate a row whose ONLY missing
  // columns are these two never qualifies and the pass skips it.
  "BACKOUT_OR_TERMINATION",
  "COMMENTS",
]);

/** Every column this pass writes, in a stable order. */
function parentBackfillColumns() {
  const seen = new Set();
  const out = [];
  for (const col of [
    ...EXTENSION_PARENT_DEAL_INHERIT_COLUMNS,
    ...EXTRA_PARENT_BACKFILL_COLUMNS,
    "INITIAL_START_DATE",
  ]) {
    if (seen.has(col)) continue;
    seen.add(col);
    out.push(col);
  }
  return out;
}

/** `col IS NULL`-style emptiness test that treats whitespace as empty for STRING columns. */
function isBlankSql(alias, col) {
  return DATE_LIKE_COLUMNS.has(col)
    ? `${alias}.${col} IS NULL`
    : `NULLIF(TRIM(IFNULL(${alias}.${col}, '')), '') IS NULL`;
}

/** Fill-if-empty assignment: the existing value always wins. */
function fillIfEmptySql(col) {
  return DATE_LIKE_COLUMNS.has(col)
    ? `  ${col} = IFNULL(d.${col}, s.${col})`
    : `  ${col} = IFNULL(NULLIF(TRIM(IFNULL(d.${col}, '')), ''), s.${col})`;
}

/** OR-ed predicate: at least one gate column is blank AND the parent can supply it. */
function buildEligibilityPredicate() {
  return GATE_COLUMNS.map((col) => `    (${isBlankSql("d", col)} AND s.${col} IS NOT NULL)`).join(
    "\n    OR "
  );
}

/**
 * Multi-statement SQL for one table: build the parent source, count the eligible rows, update them.
 * @param {string} tableId
 * @param {object} [options] - { projectId, datasetId }
 * @returns {string}
 */
function buildExtensionParentBackfillSqlForTable(tableId, options = {}) {
  const projectId = String(options.projectId || config.projectId || "").trim();
  const datasetId = String(options.datasetId || config.datasetId || "").trim();
  const dealFqn = `\`${projectId}.${datasetId}.${tableId}\``;

  const cols = parentBackfillColumns();
  // INITIAL_START_DATE comes from the parent's COALESCE, so it is projected under its own name.
  const parentSelect = cols
    .map((col) =>
      col === "INITIAL_START_DATE"
        ? `         COALESCE(INITIAL_START_DATE, START_DATE) AS INITIAL_START_DATE`
        : `         ${col}`
    )
    .join(",\n");
  const setClause = cols.map(fillIfEmptySql).join(",\n");
  const eligible = buildEligibilityPredicate();

  return `
CREATE TEMP TABLE parent_src AS
WITH latest AS (
  -- Append-only table: one row per DEAL_SHEET_ID (the newest), or a placement with several rows
  -- would both be counted twice and break the UPDATE's one-source-row-per-target requirement.
  SELECT * EXCEPT(rn) FROM (
    SELECT *, ROW_NUMBER() OVER (
      PARTITION BY DEAL_SHEET_ID
      ORDER BY LAST_UPDATED DESC NULLS LAST, EDIT_DATE DESC NULLS LAST
    ) AS rn
    FROM ${dealFqn}
    WHERE DEAL_SHEET_ID IS NOT NULL
  ) WHERE rn = 1
),
ext AS (
  SELECT DEAL_SHEET_ID, CANDIDATE_ID, CLIENT_ID, START_DATE,
         LOWER(TRIM(IFNULL(CANDIDATE_EMAIL, ''))) AS em,
         TRIM(IFNULL(CELL_PHONE, ''))             AS ph
  FROM latest
  WHERE UPPER(TRIM(IFNULL(DEAL_TYPE, ''))) = 'EXTENSION'
),
deal AS (
  SELECT CANDIDATE_ID, CLIENT_ID, START_DATE, LAST_UPDATED,
         LOWER(TRIM(IFNULL(CANDIDATE_EMAIL, ''))) AS em,
         TRIM(IFNULL(CELL_PHONE, ''))             AS ph,
${parentSelect}
  FROM latest
  WHERE UPPER(TRIM(IFNULL(DEAL_TYPE, ''))) = 'DEAL'
)
SELECT * EXCEPT(rn) FROM (
  SELECT
    e.DEAL_SHEET_ID,
    d.* EXCEPT(CANDIDATE_ID, CLIENT_ID, START_DATE, LAST_UPDATED, em, ph),
    ROW_NUMBER() OVER (
      PARTITION BY e.DEAL_SHEET_ID
      ORDER BY d.START_DATE ASC NULLS LAST, d.LAST_UPDATED DESC NULLS LAST
    ) AS rn
  FROM ext e
  JOIN deal d
    ON d.CANDIDATE_ID = e.CANDIDATE_ID
   AND d.em = e.em
   AND d.ph = e.ph
   AND d.CLIENT_ID = e.CLIENT_ID
   -- The parent must PREDATE the extension. Without this a later deal for the same candidate is
   -- picked as "parent" (an extension starting 2026-04-01 matched a deal starting 2026-07-01).
   AND d.START_DATE <= e.START_DATE
) WHERE rn = 1;

-- Counted BEFORE the UPDATE: \`SET x = @@row_count\` is itself a statement, so it would report the
-- SET's own row count (0) rather than the UPDATE's.
SET filled_rows = (
  SELECT COUNT(*)
  FROM ${dealFqn} d
  JOIN parent_src s ON d.DEAL_SHEET_ID = s.DEAL_SHEET_ID
  WHERE UPPER(TRIM(IFNULL(d.DEAL_TYPE, ''))) = 'EXTENSION'
  AND (
${eligible}
  )
);

UPDATE ${dealFqn} d
SET
${setClause}
FROM parent_src s
WHERE d.DEAL_SHEET_ID = s.DEAL_SHEET_ID
  AND UPPER(TRIM(IFNULL(d.DEAL_TYPE, ''))) = 'EXTENSION'
  AND (
${eligible}
  );`;
}

/**
 * @param {object} [options] - { projectId, datasetId, tableIds }
 * @returns {{sql: string, tableIds: string[]}}
 */
function buildExtensionParentBackfillSql(options = {}) {
  const tableIds =
    Array.isArray(options.tableIds) && options.tableIds.length > 0
      ? [...new Set(options.tableIds.map((t) => String(t).trim()).filter(Boolean))]
      : [...EXTENSION_PARENT_BACKFILL_TABLE_IDS];

  // One table per statement block; each needs its own temp table name and counter.
  const blocks = [];
  const selects = [];
  tableIds.forEach((tableId, i) => {
    const block = buildExtensionParentBackfillSqlForTable(tableId, options)
      .replace(/parent_src/g, `parent_src_${i}`)
      .replace(/filled_rows/g, `filled_${i}_rows`);
    blocks.push(block);
    selects.push(`SELECT '${tableId}' AS table_id, filled_${i}_rows AS filled_rows`);
  });

  const declares = tableIds
    .map((_, i) => `DECLARE filled_${i}_rows INT64 DEFAULT 0;`)
    .join("\n");
  const sql = `${declares}\n${blocks.join("\n")}\n\n${selects.join("\nUNION ALL\n")};`;
  return { sql, tableIds };
}

/**
 * Fill inherited fields on EXTENSION rows whose parent DEAL landed after them. Idempotent.
 * @param {object} [options] - { projectId, datasetId, tableIds }
 * @param {object} deps - { queryFn(sql): Promise<object[]> }
 * @returns {Promise<{updated:number|null, byTable:Object<string,number>}>}
 */
async function backfillExtensionParentInherit(options = {}, deps = {}) {
  const queryFn = deps.queryFn;
  if (typeof queryFn !== "function") {
    throw new Error("backfillExtensionParentInherit requires deps.queryFn");
  }

  const { sql, tableIds } = buildExtensionParentBackfillSql(options);
  const rows = (await queryFn(sql)) || [];

  const byTable = {};
  for (const tableId of tableIds) byTable[tableId] = 0;
  // The UPDATEs already ran; an empty result only means the counts could not be read back.
  let updated = rows.length === 0 ? null : 0;
  for (const row of rows) {
    const tableId = row?.table_id == null ? "" : String(row.table_id).trim();
    const count = Number(row?.filled_rows ?? 0);
    if (!tableId || !Number.isFinite(count)) continue;
    byTable[tableId] = count;
    updated = (updated ?? 0) + count;
  }

  return { updated, byTable };
}

module.exports = {
  EXTENSION_PARENT_BACKFILL_TABLE_IDS,
  EXTRA_PARENT_BACKFILL_COLUMNS,
  GATE_COLUMNS,
  DATE_LIKE_COLUMNS,
  parentBackfillColumns,
  buildExtensionParentBackfillSql,
  buildExtensionParentBackfillSqlForTable,
  backfillExtensionParentInherit,
};
