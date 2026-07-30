/**
 * One-time backfill: set EXTENSION_DATE from earliest BOOKED job-submittal-note
 * (same source as enrich resolveExtensionDateForExtensionRow). Does not wipe tables
 * or touch inorganic/ownership logs — only UPDATEs EXTENSION_DATE on latest EXTENSION rows.
 *
 * dry_run=true (default): report proposed changes only.
 * apply=true: write BigQuery UPDATEs.
 */
const config = require("./config");
const { getNexusAccessToken, nexusGetJsonWithRetry, buildUrl, normalizePagedResponse } = require("./nexusClient");
const { resolveExtensionDateForExtensionRow } = require("./columnMappings");
const { ACTIVE_DEAL_SHEET_TABLE_IDS } = require("./recruiterDomainTables");
const { logLine, logDetail } = require("./logger");

/** Lazy require avoids circular init with bigQueryClient. */
function getBigQueryHelpers() {
  return require("./bigQueryClient");
}

async function fetchAllJobSubmittalNotesForPlacement(placementId, accessToken) {
  const items = [];
  let requestUrl = buildUrl(`${config.nexus.baseUrl}/api/job-submittal-notes/`, {
    job_submittal_id: placementId,
  });
  while (requestUrl) {
    const page = await nexusGetJsonWithRetry(requestUrl, accessToken);
    const normalized = normalizePagedResponse(page);
    if (normalized.items?.length) items.push(...normalized.items);
    requestUrl = normalized.next || null;
  }
  return items;
}

function normalizeTsForCompare(value) {
  if (value == null || String(value).trim() === "") return "";
  const raw =
    typeof value === "object" && value !== null && "value" in value ? value.value : value;
  if (raw == null || String(raw).trim() === "") return "";
  const ms = Date.parse(String(raw).trim());
  if (!Number.isFinite(ms)) return String(raw).trim();
  return new Date(ms).toISOString();
}

/**
 * Latest EXTENSION row per DEAL_SHEET_ID (placement fallback when deal sheet null) with
 * PLACEMENT_ID set, from one active table.
 */
async function fetchLatestExtensionTargetsForTable(datasetId, tableId, maxRows) {
  const { queryObjects, escapeSqlString } = getBigQueryHelpers();
  const limit = Number.isFinite(maxRows) && maxRows > 0 ? Math.floor(maxRows) : 5000;
  const fqn = `\`${config.projectId}.${escapeSqlString(datasetId)}.${escapeSqlString(tableId)}\``;
  const sql = `
    SELECT
      CAST(ID AS STRING) AS id,
      CAST(DEAL_SHEET_ID AS STRING) AS deal_sheet_id,
      CAST(PLACEMENT_ID AS STRING) AS placement_id,
      CAST(EXTENSION_DATE AS STRING) AS extension_date
    FROM (
      SELECT
        ID,
        DEAL_SHEET_ID,
        PLACEMENT_ID,
        EXTENSION_DATE,
        ROW_NUMBER() OVER (
          PARTITION BY
            CASE
              WHEN DEAL_SHEET_ID IS NOT NULL THEN CONCAT('ds:', CAST(DEAL_SHEET_ID AS STRING))
              ELSE CONCAT('pid:', CAST(PLACEMENT_ID AS STRING))
            END
          ORDER BY DATE_AND_TIME DESC NULLS LAST
        ) AS rn
      FROM ${fqn}
      WHERE UPPER(TRIM(IFNULL(DEAL_TYPE, ''))) = 'EXTENSION'
        AND PLACEMENT_ID IS NOT NULL
    )
    WHERE rn = 1
    LIMIT ${limit}
  `;
  return queryObjects(sql, limit);
}

async function updateExtensionDateById(datasetId, tableId, rowId, extensionDateIso) {
  const { runDml, escapeSqlString } = getBigQueryHelpers();
  const fqn = `\`${config.projectId}.${escapeSqlString(datasetId)}.${escapeSqlString(tableId)}\``;
  const idLit = escapeSqlString(String(rowId).trim());
  const tsLit =
    extensionDateIso == null || String(extensionDateIso).trim() === ""
      ? "CAST(NULL AS TIMESTAMP)"
      : `TIMESTAMP('${escapeSqlString(normalizeTsForCompare(extensionDateIso) || String(extensionDateIso).trim())}')`;
  const sql = `
    UPDATE ${fqn}
    SET EXTENSION_DATE = ${tsLit}
    WHERE CAST(ID AS STRING) = '${idLit}'
  `;
  return runDml(sql);
}

/**
 * @param {object} [params]
 * @param {string} [params.bq_dataset]
 * @param {boolean} [params.apply] - when true, write UPDATEs (default false = dry_run)
 * @param {number} [params.max_rows_per_table]
 * @param {number} [params.concurrency]
 * @returns {Promise<object>}
 */
async function backfillExtensionDateFromBookedNotes(params = {}) {
  const startMs = Date.now();
  const datasetId =
    typeof params.bq_dataset === "string" && params.bq_dataset.trim() !== ""
      ? params.bq_dataset.trim()
      : config.datasetId;
  const apply = params.apply === true || params.apply === "true";
  const maxRowsPerTable = Number.isFinite(Number(params.max_rows_per_table))
    ? Math.max(1, Math.floor(Number(params.max_rows_per_table)))
    : 5000;
  const concurrency = Number.isFinite(Number(params.concurrency))
    ? Math.min(10, Math.max(1, Math.floor(Number(params.concurrency))))
    : 4;

  logLine(
    `[extension-date backfill] START dataset=${datasetId} apply=${apply ? "yes" : "dry_run"} maxRowsPerTable=${maxRowsPerTable} concurrency=${concurrency}`
  );

  const accessToken = await getNexusAccessToken();
  const notesCache = new Map();
  const tableResults = [];
  let checked = 0;
  let wouldUpdate = 0;
  let updated = 0;
  let unchanged = 0;
  let noBookedNote = 0;
  let errors = 0;

  async function notesForPlacement(placementId) {
    const key = String(placementId).trim();
    if (notesCache.has(key)) return notesCache.get(key);
    const notes = await fetchAllJobSubmittalNotesForPlacement(key, accessToken);
    notesCache.set(key, notes);
    return notes;
  }

  for (const tableId of ACTIVE_DEAL_SHEET_TABLE_IDS) {
    const targets = await fetchLatestExtensionTargetsForTable(datasetId, tableId, maxRowsPerTable);
    logDetail(`[extension-date backfill] table=${tableId} latestExtensionRows=${targets.length}`);

    let tableUpdated = 0;
    let tableWould = 0;
    let tableUnchanged = 0;
    let tableNoNote = 0;
    let tableErrors = 0;

    for (let i = 0; i < targets.length; i += concurrency) {
      const chunk = targets.slice(i, i + concurrency);
      await Promise.all(
        chunk.map(async (row) => {
          checked++;
          const placementId = row?.placement_id == null ? "" : String(row.placement_id).trim();
          const rowId = row?.id == null ? "" : String(row.id).trim();
          if (!placementId || !rowId) {
            tableErrors++;
            errors++;
            return;
          }
          try {
            const notes = await notesForPlacement(placementId);
            const fromNotes = resolveExtensionDateForExtensionRow("EXTENSION", notes);
            if (fromNotes == null || String(fromNotes).trim() === "") {
              tableNoNote++;
              noBookedNote++;
              return;
            }
            const nextIso = normalizeTsForCompare(fromNotes);
            const prevIso = normalizeTsForCompare(row.extension_date);
            if (nextIso === prevIso) {
              tableUnchanged++;
              unchanged++;
              return;
            }
            tableWould++;
            wouldUpdate++;
            if (!apply) return;
            const n = await updateExtensionDateById(datasetId, tableId, rowId, nextIso || fromNotes);
            if (n > 0) {
              tableUpdated++;
              updated++;
            } else {
              tableErrors++;
              errors++;
            }
          } catch (e) {
            tableErrors++;
            errors++;
            logLine(
              `[extension-date backfill] ERROR table=${tableId} placement_id=${placementId}: ${String(e && e.message ? e.message : e).slice(0, 200)}`
            );
          }
        })
      );
    }

    tableResults.push({
      tableId,
      targets: targets.length,
      wouldUpdate: tableWould,
      updated: tableUpdated,
      unchanged: tableUnchanged,
      noBookedNote: tableNoNote,
      errors: tableErrors,
    });
  }

  const elapsedMs = Date.now() - startMs;
  const result = {
    success: true,
    apply,
    dry_run: !apply,
    datasetId,
    checked,
    wouldUpdate,
    updated,
    unchanged,
    noBookedNote,
    errors,
    tables: tableResults,
    elapsedMs,
  };
  logLine(
    `[extension-date backfill] DONE apply=${apply ? "yes" : "dry_run"} checked=${checked} wouldUpdate=${wouldUpdate} updated=${updated} unchanged=${unchanged} noBookedNote=${noBookedNote} errors=${errors} elapsedMs=${elapsedMs}`
  );
  return result;
}

module.exports = {
  backfillExtensionDateFromBookedNotes,
  normalizeTsForCompare,
  fetchAllJobSubmittalNotesForPlacement,
};
