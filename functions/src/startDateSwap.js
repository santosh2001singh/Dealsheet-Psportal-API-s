/**
 * START_DATE swap for the Cynet Health deal sheet and its run-rate table (business rule, Nov 2026).
 *
 * STORED format (what sits in BigQuery once the swap is live):
 *   START_DATE           = the contract's original start (INITIAL_START_DATE)
 *   EXTENSION_START_DATE = this placement's own start, i.e. what START_DATE used to hold. Set on
 *                          extensions and on re-booked DEALs (own start later than the original),
 *                          blank on a fresh DEAL.
 *   INITIAL_START_DATE   = unchanged (still the original start).
 *   EXTENSION_DATE       = unchanged (booking date).
 *
 * INTERNAL format (what every line of pipeline logic was written against, and still sees):
 *   START_DATE           = this placement's own start
 *   EXTENSION_START_DATE = START_DATE on extension rows, blank on DEAL rows
 *
 * The pipeline never sees the stored format. Two boundaries convert:
 *   - read:  readableTableSql() wraps the table in a subquery that rebuilds the internal format, so
 *            every SELECT against it (ownership logs, contract id, run-rate matching, baselines for
 *            append-on-change) gets exactly the values it got before the swap.
 *   - write: toStoredStartRow() converts a finished row right before the load job.
 *
 * Both are safe on the OLD format too: on an un-swapped row EXTENSION_START_DATE already equals
 * START_DATE (extension) or is blank (DEAL), so the read shim is a no-op. That is what lets the code
 * deploy before or after the data backfill without a window where logic sees wrong dates.
 *
 * Run-rate rows with no PLACEMENT_ID are the data team's history. There START_DATE is already the
 * original start and EXTENSION_START_DATE is the first extension's start. The shim leaves them
 * exactly as stored.
 *
 * Only cynet_health_deal_sheet and the Health run-rate table are in scope. Canada, Locums and the
 * ended tables keep the old format, and every helper here is a no-op for them.
 */

const config = require("./config");

const HEALTH_DEAL_SHEET_TABLE_ID = "cynet_health_deal_sheet";

function swapTableIds() {
  return new Set([HEALTH_DEAL_SHEET_TABLE_ID, String(config.runrateTableId || "").trim()]);
}

/** True for the two tables whose START_DATE is stored in the swapped format. */
function isStartDateSwapTable(tableId) {
  const key = tableId == null ? "" : String(tableId).trim();
  if (!key) return false;
  return swapTableIds().has(key);
}

/** Write side switch. Reads are always shimmed; the shim is a no-op on old-format rows. */
function isStartDateSwapWriteEnabled() {
  return config.startDateSwapWriteEnabled !== false;
}

function dateOnlyOrNull(value) {
  if (value == null) return null;
  const raw =
    typeof value === "object" && !(value instanceof Date) && "value" in value ? value.value : value;
  if (raw == null) return null;
  const s = (raw instanceof Date ? raw.toISOString() : String(raw)).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function dealTypeKey(row) {
  return row?.DEAL_TYPE == null ? "" : String(row.DEAL_TYPE).trim().toUpperCase();
}

/** EXTENSION and "REBOOKED / EXTENSION" both carry their own start in EXTENSION_START_DATE. */
function isExtensionDealType(row) {
  return dealTypeKey(row).includes("EXTENSION");
}

function hasPlacementId(row) {
  return row?.PLACEMENT_ID != null && String(row.PLACEMENT_ID).trim() !== "";
}

function qualify(alias, col) {
  return alias ? `${alias}.${col}` : col;
}

/**
 * SQL for a row's own placement start, readable on both formats. For queries that read the raw
 * table (UPDATE / MERGE targets) instead of going through readableTableSql().
 */
function placementStartSqlExpr(alias = "") {
  const pid = qualify(alias, "PLACEMENT_ID");
  const start = qualify(alias, "START_DATE");
  const ext = qualify(alias, "EXTENSION_START_DATE");
  return `IF(${pid} IS NULL, ${start}, COALESCE(${ext}, ${start}))`;
}

/**
 * Internal EXTENSION_START_DATE, exactly as the pipeline writes it (applyExtensionStartDateForRow):
 * the placement's own start on DEAL_TYPE = 'EXTENSION' rows, blank on every other deal type.
 * Run-rate rows without a PLACEMENT_ID (data team) keep their stored value.
 */
function internalExtensionStartSqlExpr(alias = "") {
  const pid = qualify(alias, "PLACEMENT_ID");
  const ext = qualify(alias, "EXTENSION_START_DATE");
  const dt = qualify(alias, "DEAL_TYPE");
  return (
    `IF(${pid} IS NULL, ${ext}, ` +
    `IF(UPPER(TRIM(CAST(${dt} AS STRING))) = 'EXTENSION', ${placementStartSqlExpr(alias)}, CAST(NULL AS DATE)))`
  );
}

/**
 * Table reference for a SELECT / JOIN. For a swap table: a subquery that rebuilds the internal format
 * under the same column names. Anything else: the plain backticked table.
 * Never use this as the target of UPDATE / DELETE / MERGE / INSERT.
 */
function readableTableSql(projectId, datasetId, tableId) {
  const plain = `\`${projectId}.${datasetId}.${tableId}\``;
  if (!isStartDateSwapTable(tableId)) return plain;
  return (
    `(SELECT * REPLACE (` +
    `${placementStartSqlExpr()} AS START_DATE, ` +
    `${internalExtensionStartSqlExpr()} AS EXTENSION_START_DATE` +
    `) FROM ${plain})`
  );
}

/**
 * readableTableSql for an already-built `project.dataset.table` reference (with or without backticks).
 * Lets call sites that hold a fully-qualified name keep their shape.
 */
function readableFqnSql(fqn) {
  const bare = String(fqn ?? "").trim().replace(/^`|`$/g, "");
  const parts = bare.split(".");
  if (parts.length !== 3) return fqn;
  return readableTableSql(parts[0], parts[1], parts[2]);
}

/** JS twin of the read shim, for a raw stored row that reached the pipeline without the SQL shim. */
function toInternalStartRow(row) {
  if (!row || typeof row !== "object" || !hasPlacementId(row)) return row;
  const next = { ...row };
  if (dateOnlyOrNull(row.EXTENSION_START_DATE) != null) next.START_DATE = row.EXTENSION_START_DATE;
  next.EXTENSION_START_DATE = dealTypeKey(row) === "EXTENSION" ? next.START_DATE ?? null : null;
  return next;
}

/**
 * Internal row -> stored row. Pure; the caller decides whether the table is in scope.
 *
 *   original start known and not after the placement's own start:
 *     START_DATE           <- INITIAL_START_DATE
 *     EXTENSION_START_DATE <- own start   (extension, or DEAL re-booked after the original)
 *                          <- null        (fresh DEAL: own start IS the original)
 *   otherwise (no INITIAL_START_DATE, or one after the own start, which is bad data): START_DATE
 *   stays the own start, EXTENSION_START_DATE <- own start on extensions, null on DEALs.
 *
 * Either way the read shim (EXTENSION_START_DATE ?? START_DATE) gives back the own start.
 */
function toStoredStartRow(row) {
  if (!row || typeof row !== "object") return row;
  const ownStart = dateOnlyOrNull(row.START_DATE);
  if (ownStart == null) return row;
  const initial = dateOnlyOrNull(row.INITIAL_START_DATE);
  const isExtension = isExtensionDealType(row);
  if (initial != null && initial <= ownStart) {
    return {
      ...row,
      START_DATE: initial,
      EXTENSION_START_DATE: isExtension || initial < ownStart ? ownStart : null,
    };
  }
  return { ...row, EXTENSION_START_DATE: isExtension ? ownStart : null };
}

/** toStoredStartRow over a batch, only when the target table is a swap table and writes are on. */
function toStoredStartRowsForTable(rows, tableId) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  if (!isStartDateSwapTable(tableId) || !isStartDateSwapWriteEnabled()) return rows;
  return rows.map((row) => toStoredStartRow(row));
}

/**
 * START_DATE / EXTENSION_START_DATE for a LOG row (ownership_change_logs, ch_rate_change_logs,
 * ch_additional_cost_logs), from the internal deal row it describes. Log tables always use the stored
 * format, whatever deal sheet the placement lives in, so a log table never mixes the two meanings.
 * With writes switched off it falls back to the old shape (own start, no extension start).
 * @param {object} dealRow - internal-format row: START_DATE, INITIAL_START_DATE, DEAL_TYPE
 * @returns {{START_DATE: string|null, EXTENSION_START_DATE: string|null}}
 */
function storedStartFieldsForLog(dealRow) {
  const ownStart = dateOnlyOrNull(dealRow?.START_DATE);
  if (!isStartDateSwapWriteEnabled()) return { START_DATE: ownStart, EXTENSION_START_DATE: null };
  if (ownStart == null) return { START_DATE: null, EXTENSION_START_DATE: null };
  const stored = toStoredStartRow({
    START_DATE: ownStart,
    INITIAL_START_DATE: dateOnlyOrNull(dealRow?.INITIAL_START_DATE),
    DEAL_TYPE: dealRow?.DEAL_TYPE ?? null,
  });
  return { START_DATE: stored.START_DATE, EXTENSION_START_DATE: stored.EXTENSION_START_DATE ?? null };
}

/**
 * SET clause fragments for a DML UPDATE on a swap table that puts a new original start on rows.
 * `newInitialSql` is evaluated against the row's pre-update values (BigQuery semantics). The row's
 * own placement start is preserved through EXTENSION_START_DATE.
 */
function storedStartSetSqlForNewInitial(newInitialSql, alias = "") {
  const own = placementStartSqlExpr(alias);
  const dt = qualify(alias, "DEAL_TYPE");
  const isExt = `STRPOS(UPPER(IFNULL(CAST(${dt} AS STRING), '')), 'EXTENSION') > 0`;
  const init = `(${newInitialSql})`;
  const ok = `(${init} IS NOT NULL AND ${own} IS NOT NULL AND ${init} <= ${own})`;
  return [
    `START_DATE = IF(${ok}, ${init}, ${own})`,
    `EXTENSION_START_DATE = IF(${isExt} OR (${ok} AND ${init} < ${own}), ${own}, CAST(NULL AS DATE))`,
  ];
}

module.exports = {
  HEALTH_DEAL_SHEET_TABLE_ID,
  isStartDateSwapTable,
  isStartDateSwapWriteEnabled,
  placementStartSqlExpr,
  internalExtensionStartSqlExpr,
  readableTableSql,
  readableFqnSql,
  toInternalStartRow,
  toStoredStartRow,
  toStoredStartRowsForTable,
  storedStartFieldsForLog,
  storedStartSetSqlForNewInitial,
};
