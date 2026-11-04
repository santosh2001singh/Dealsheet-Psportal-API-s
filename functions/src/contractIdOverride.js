/**
 * CONTRACT_IDs a person assigned when approving a deal, and the rule that the sync never undoes them.
 *
 * The matcher can put a new booking on an older contract of the same candidate + client (same start
 * date, same facility) — e.g. Jerry Jean-Baptiste, Oct 2026: DEAL 1470787 took CHC23675 from the
 * DID NOT START deal 1469058 because both start 2026-10-26. No automatic rule tells a re-book of the
 * same contract from a new one, so the approver decides: approving with "new contract" mints a fresh
 * id for THIS placement. The other deal keeps the id it has.
 *
 * One source for the id: the same Firestore counter the sync mints from (contractIdSequence.js),
 * through claimContractId, which writes the counter and the override record
 *   workspaces/run-rate-tool/contractIdOverrides/{tableId}__{DEAL_SHEET_ID}__{PLACEMENT_ID}
 * in one transaction. A repeated request (double click, retry, two approvers) reads the record back
 * and gets the same id instead of minting a second one.
 *
 * The record is also what makes the decision stick. The sync may be mid-run when the approve
 * rewrites the stored rows; a version it appends from the baseline it read before the rewrite still
 * carries the old id. The insert pipeline therefore treats the override as the baseline's id and
 * re-appends any placement whose latest row disagrees with it, so a race heals on the next run.
 */

const config = require("./config");
const { getWorkspaceSubcollectionRef } = require("./firestoreWorkspace");
const { claimContractId } = require("./contractIdSequence");
const { buildSequenceOptionsForTable, normalizeContractIdOrNull } = require("./contractIdFormat");
const { ACTIVE_DEAL_SHEET_TABLE_IDS } = require("./recruiterDomainTables");
const { logDetail } = require("./logger");

function getOverrideCollectionRef(firestore) {
  return getWorkspaceSubcollectionRef(config.contractIdOverride.collection, firestore);
}

function idPart(value) {
  return value == null ? "" : String(value).trim();
}

function overrideDocId(tableId, dealSheetId, placementId) {
  return `${tableId}__${dealSheetId}__${placementId}`;
}

/** Key the overrides map is read by — same shape as buildDealSheetPlacementCompositeKey. */
function overrideKey(dealSheetId, placementId) {
  return `${idPart(dealSheetId)}|${idPart(placementId)}`;
}

/**
 * Every override for one deal sheet table, keyed DEAL_SHEET_ID|PLACEMENT_ID.
 *
 * Read whole rather than per row: the collection only grows by hand-approved re-keys, so it stays
 * small, and one query per insert batch is cheaper than one read per row.
 *
 * @param {string} tableId
 * @param {object} [deps] - { firestore }
 * @returns {Promise<Map<string, string>>}
 */
async function fetchContractIdOverridesForTable(tableId, deps = {}) {
  const out = new Map();
  const tid = idPart(tableId);
  if (!tid) return out;
  const snap = await getOverrideCollectionRef(deps.firestore).where("tableId", "==", tid).get();
  snap.forEach((doc) => {
    const data = doc.data() || {};
    const contractId = normalizeContractIdOrNull(data.contractId);
    if (contractId == null) return;
    out.set(overrideKey(data.dealSheetId, data.placementId), contractId);
  });
  return out;
}

/**
 * The override for one placement, or null.
 * @returns {Promise<string|null>}
 */
async function fetchContractIdOverride(tableId, dealSheetId, placementId, deps = {}) {
  const tid = idPart(tableId);
  const dsid = idPart(dealSheetId);
  const pid = idPart(placementId);
  if (!tid || !dsid || !pid) return null;
  const snap = await getOverrideCollectionRef(deps.firestore).doc(overrideDocId(tid, dsid, pid)).get();
  return snap.exists ? normalizeContractIdOrNull(snap.data()?.contractId) : null;
}

/** @returns {string|null} */
function contractIdOverrideForRow(row, overrides) {
  if (!overrides || overrides.size === 0 || !row) return null;
  return overrides.get(overrideKey(row.DEAL_SHEET_ID, row.PLACEMENT_ID)) ?? null;
}

/**
 * Log tables that store a placement's CONTRACT_ID. Each is re-keyed by PLACEMENT_ID + the old id, so
 * a row is touched only when it belongs to THIS placement AND still carries the id being replaced.
 * Data team ownership rows carry no PLACEMENT_ID and are never matched (they are never rewritten).
 */
function contractIdLogTables() {
  return [
    { datasetId: config.rateChangeLogDatasetId, tableId: config.rateChangeLogTableId },
    { datasetId: config.terminationReasonLogDatasetId, tableId: config.terminationReasonLogTableId },
    { datasetId: config.additionalCostLogDatasetId, tableId: config.additionalCostLogTableId },
    { datasetId: config.inorganicHierarchyLogDatasetId, tableId: config.inorganicHierarchyLogTableId },
    { datasetId: config.ownershipChangeLogDatasetId, tableId: config.ownershipChangeLogTableId },
  ];
}

/**
 * Move this placement's log rows from the old CONTRACT_ID(s) to the new one.
 *
 * A table is skipped (not failed) when it lacks PLACEMENT_ID or CONTRACT_ID. Each table is its own
 * statement and a failure is reported rather than thrown: by the time this runs the deal sheet
 * already holds the new id, and one stuck log table must not hide that the rest went through.
 *
 * @returns {Promise<Array<{table: string, updatedRows?: number, skipped?: string, error?: string}>>}
 */
async function rekeyContractIdLogsForPlacement(params, deps = {}) {
  const { escapeSqlString, queryObjects, runDml } = require("./bigQueryClient");
  const queryFn = deps.queryObjectsFn ?? queryObjects;
  const dmlFn = deps.runDmlFn ?? runDml;

  const pid = idPart(params.placementId);
  const newId = normalizeContractIdOrNull(params.newContractId);
  const oldIds = (params.previousContractIds || [])
    .map((id) => normalizeContractIdOrNull(id))
    .filter((id) => id != null && id !== newId);
  if (!pid || newId == null || oldIds.length === 0) return [];

  const results = [];
  for (const { datasetId, tableId } of contractIdLogTables()) {
    const fqn = `\`${config.projectId}.${datasetId}.${tableId}\``;
    try {
      const cols = await queryFn(
        `SELECT column_name FROM \`${config.projectId}.${datasetId}.INFORMATION_SCHEMA.COLUMNS\`
         WHERE table_name = '${escapeSqlString(tableId)}'
           AND column_name IN ('PLACEMENT_ID', 'CONTRACT_ID')`
      );
      const names = new Set((cols || []).map((c) => String(c.column_name || "").toUpperCase()));
      if (!names.has("PLACEMENT_ID") || !names.has("CONTRACT_ID")) {
        results.push({ table: tableId, skipped: "no PLACEMENT_ID/CONTRACT_ID column" });
        continue;
      }
      const oldList = oldIds.map((id) => `'${escapeSqlString(id)}'`).join(", ");
      const updatedRows = await dmlFn(`
        UPDATE ${fqn}
        SET CONTRACT_ID = '${escapeSqlString(newId)}'
        WHERE CAST(PLACEMENT_ID AS STRING) = '${escapeSqlString(pid)}'
          AND UPPER(TRIM(CAST(CONTRACT_ID AS STRING))) IN (${oldList})
      `);
      results.push({ table: tableId, updatedRows });
    } catch (err) {
      const message = String(err?.message || err).slice(0, 300);
      logDetail(`[contractIdOverride] log re-key failed table=${tableId} placement=${pid}: ${message}`);
      results.push({ table: tableId, error: message });
    }
  }
  return results;
}

class ContractIdOverrideError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ContractIdOverrideError";
    this.code = code;
  }
}

/**
 * Give one DEAL placement a brand-new CONTRACT_ID and move its stored rows and logs onto it.
 *
 * Idempotent: a placement that already has an override keeps that id, and the row/log rewrites are
 * re-run, which finishes an earlier attempt that died half-way and changes nothing otherwise.
 *
 * DEAL rows only — an EXTENSION never owns a contract id (it inherits its parent DEAL's).
 *
 * @param {object} params
 * @param {string} params.tableId active deal sheet table
 * @param {string|number} params.dealSheetId
 * @param {string|number} params.placementId
 * @param {string} [params.requestedBy] approver email, stored on the override record
 * @param {string} [params.datasetId]
 * @param {object} [deps] - { firestore, queryObjectsFn, runDmlFn, repairFn, claimFn, fetchMaxFn }
 */
async function assignNewContractIdForPlacement(params = {}, deps = {}) {
  const bq = require("./bigQueryClient");
  const queryFn = deps.queryObjectsFn ?? bq.queryObjects;
  const repairFn = deps.repairFn ?? bq.repairStoredContractIdForPlacement;
  const fetchMaxFn = deps.fetchMaxFn ?? bq.fetchMaxContractIdSeqForTable;
  const claimFn = deps.claimFn ?? claimContractId;

  const tableId = idPart(params.tableId);
  const dealSheetId = idPart(params.dealSheetId);
  const placementId = idPart(params.placementId);
  const datasetId = idPart(params.datasetId) || config.datasetId;
  if (!ACTIVE_DEAL_SHEET_TABLE_IDS.includes(tableId)) {
    throw new ContractIdOverrideError("BAD_REQUEST", `Unknown deal sheet table: ${tableId || "(blank)"}`);
  }
  if (!/^\d+$/.test(dealSheetId) || !/^\d+$/.test(placementId)) {
    throw new ContractIdOverrideError("BAD_REQUEST", "deal_sheet_id and placement_id must be numeric");
  }

  const rows = await queryFn(`
    SELECT DISTINCT
      UPPER(TRIM(CAST(CONTRACT_ID AS STRING))) AS contract_id,
      UPPER(TRIM(CAST(DEAL_TYPE AS STRING))) AS deal_type
    FROM \`${config.projectId}.${datasetId}.${tableId}\`
    WHERE CAST(DEAL_SHEET_ID AS STRING) = '${dealSheetId}'
      AND CAST(PLACEMENT_ID AS STRING) = '${placementId}'
  `);
  if (!rows || rows.length === 0) {
    throw new ContractIdOverrideError(
      "NOT_FOUND",
      `No rows for deal sheet ${dealSheetId} / placement ${placementId} in ${tableId}`
    );
  }
  if (rows.some((r) => r.deal_type !== "DEAL")) {
    throw new ContractIdOverrideError("NOT_A_DEAL", "Only a DEAL can be given a new contract id");
  }
  const previousContractIds = [
    ...new Set(rows.map((r) => normalizeContractIdOrNull(r.contract_id)).filter((id) => id != null)),
  ];

  const sequenceOptions = buildSequenceOptionsForTable(tableId);
  if (!sequenceOptions) {
    throw new ContractIdOverrideError("BAD_REQUEST", `No contract id sequence for ${tableId}`);
  }
  const claimRef = getOverrideCollectionRef(deps.firestore).doc(
    overrideDocId(tableId, dealSheetId, placementId)
  );
  const claim = await claimFn(
    claimRef,
    () => ({
      tableId,
      dealSheetId,
      placementId,
      previousContractIds,
      requestedBy: idPart(params.requestedBy) || null,
      createdAt: new Date().toISOString(),
    }),
    {
      ...sequenceOptions,
      firestore: deps.firestore,
      minNextValueFn: async () => {
        const max = await fetchMaxFn(tableId, { datasetId });
        return max == null ? null : max + 1;
      },
    }
  );
  const contractId = normalizeContractIdOrNull(claim?.contractId);
  if (contractId == null) {
    throw new ContractIdOverrideError("MINT_FAILED", "Could not mint a contract id");
  }

  // Every version of this placement, so the history never shows the old id beside the new one.
  // No inherited columns are cleared here (unlike the run-rate revalidation repair): the approver is
  // looking at this row and may have filled them in. INITIAL_START_DATE resets to START_DATE, which
  // is correct for a DEAL that now starts its own contract.
  const repaired = await repairFn(
    { dealSheetId, placementId, newContractId: contractId, clearColumns: [] },
    { datasetId, tableId }
  );
  const logs = await rekeyContractIdLogsForPlacement(
    { placementId, previousContractIds, newContractId: contractId },
    deps
  );

  logDetail(
    `[contractIdOverride] table=${tableId} dealSheet=${dealSheetId} placement=${placementId} ` +
      `${previousContractIds.join(",") || "(none)"} -> ${contractId} created=${claim.created} ` +
      `dealSheetRows=${repaired?.updatedRows ?? "n/a"} by=${idPart(params.requestedBy) || "?"}`
  );

  return {
    contractId,
    previousContractIds,
    created: Boolean(claim.created),
    dealSheetRowsUpdated: repaired?.updatedRows ?? null,
    logs,
  };
}

module.exports = {
  ContractIdOverrideError,
  assignNewContractIdForPlacement,
  fetchContractIdOverridesForTable,
  fetchContractIdOverride,
  contractIdOverrideForRow,
  rekeyContractIdLogsForPlacement,
  overrideDocId,
  overrideKey,
};
