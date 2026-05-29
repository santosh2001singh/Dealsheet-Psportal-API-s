/**
 * Map assignment recruiter email domain to active / ended deal sheet BigQuery table ids.
 */

const TABLE_CYNET_HEALTH = "cynet_health_deal_sheet";
const TABLE_CYNET_HEALTH_CANADA = "cynet_health_canada_deal_sheet";
const TABLE_CYNET_LOCUMS = "cynet_locums_deal_sheet";

/** All active domain-routed deal sheet tables (same schema). */
const ACTIVE_DEAL_SHEET_TABLE_IDS = [TABLE_CYNET_HEALTH, TABLE_CYNET_HEALTH_CANADA, TABLE_CYNET_LOCUMS];

const SUFFIX_TO_TABLE = [
  ["@cynethealth.ca", TABLE_CYNET_HEALTH_CANADA],
  ["@cynethealth.com", TABLE_CYNET_HEALTH],
  ["@cynetlocums.com", TABLE_CYNET_LOCUMS],
];

/**
 * @param {unknown} email
 * @returns {string} BigQuery table id for rr_project_data
 */
function resolveActiveDealSheetTableId(email) {
  const norm = String(email ?? "")
    .trim()
    .toLowerCase();
  if (!norm) return TABLE_CYNET_HEALTH;
  for (const [suffix, tableId] of SUFFIX_TO_TABLE) {
    if (norm.endsWith(suffix)) return tableId;
  }
  return TABLE_CYNET_HEALTH;
}

/** Checkpoint / log label when writes fan out to domain tables (not a real table name). */
function buildActiveDealSheetRoutingSentinel(projectId, datasetId) {
  const p = String(projectId || "").trim() || "unknown_project";
  const d = String(datasetId || "").trim() || "unknown_dataset";
  return `${p}.${d}:ACTIVE_DOMAIN_ROUTED`;
}

const TABLE_ENDED_CYNET_HEALTH = "cynet_health_ended_deal_sheet";
const TABLE_ENDED_CYNET_HEALTH_CANADA = "cynet_health_canada_ended_deal_sheet";
const TABLE_ENDED_CYNET_LOCUMS = "cynet_locums_ended_deal_sheet";

const ENDED_DEAL_SHEET_TABLE_IDS = [
  TABLE_ENDED_CYNET_HEALTH,
  TABLE_ENDED_CYNET_HEALTH_CANADA,
  TABLE_ENDED_CYNET_LOCUMS,
];

const SUFFIX_TO_ENDED_TABLE = [
  ["@cynethealth.ca", TABLE_ENDED_CYNET_HEALTH_CANADA],
  ["@cynethealth.com", TABLE_ENDED_CYNET_HEALTH],
  ["@cynetlocums.com", TABLE_ENDED_CYNET_LOCUMS],
];

/**
 * @param {unknown} email
 * @returns {string} BigQuery ended deal sheet table id
 */
function resolveEndedDealSheetTableId(email) {
  const norm = String(email ?? "")
    .trim()
    .toLowerCase();
  if (!norm) return TABLE_ENDED_CYNET_HEALTH;
  for (const [suffix, tableId] of SUFFIX_TO_ENDED_TABLE) {
    if (norm.endsWith(suffix)) return tableId;
  }
  return TABLE_ENDED_CYNET_HEALTH;
}

function buildEndedDealSheetRoutingSentinel(projectId, datasetId) {
  const p = String(projectId || "").trim() || "unknown_project";
  const d = String(datasetId || "").trim() || "unknown_dataset";
  return `${p}.${d}:ENDED_DOMAIN_ROUTED`;
}

module.exports = {
  ACTIVE_DEAL_SHEET_TABLE_IDS,
  resolveActiveDealSheetTableId,
  buildActiveDealSheetRoutingSentinel,
  TABLE_CYNET_HEALTH,
  TABLE_CYNET_HEALTH_CANADA,
  TABLE_CYNET_LOCUMS,
  ENDED_DEAL_SHEET_TABLE_IDS,
  resolveEndedDealSheetTableId,
  buildEndedDealSheetRoutingSentinel,
  TABLE_ENDED_CYNET_HEALTH,
  TABLE_ENDED_CYNET_HEALTH_CANADA,
  TABLE_ENDED_CYNET_LOCUMS,
};
