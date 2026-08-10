/**
 * Map assignment recruiter email domain to active / ended deal sheet BigQuery table ids.
 */

const config = require("./config");

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

const ENDED_TO_ACTIVE_TABLE = new Map([
  [TABLE_ENDED_CYNET_HEALTH, TABLE_CYNET_HEALTH],
  [TABLE_ENDED_CYNET_HEALTH_CANADA, TABLE_CYNET_HEALTH_CANADA],
  [TABLE_ENDED_CYNET_LOCUMS, TABLE_CYNET_LOCUMS],
]);

/**
 * @param {unknown} endedTableId
 * @returns {string|null} paired active table id, or null if not an ended table
 */
function resolvePairedActiveTableId(endedTableId) {
  const key = endedTableId == null ? "" : String(endedTableId).trim();
  if (!key) return null;
  return ENDED_TO_ACTIVE_TABLE.get(key) ?? null;
}

/**
 * Domain-specific all_CH_data_runrate-equivalent table id for a given deal sheet table
 * (active or ended — ended is normalized to its paired active domain first).
 * @param {unknown} tableId - any of the 6 domain deal sheet table ids
 * @returns {string}
 */
function resolveRunrateTableIdForDealSheetTable(tableId) {
  const key = tableId == null ? "" : String(tableId).trim();
  const activeKey = resolvePairedActiveTableId(key) ?? key;
  if (activeKey === TABLE_CYNET_HEALTH_CANADA) return config.runrateCanadaTableId;
  if (activeKey === TABLE_CYNET_LOCUMS) return config.runrateLocumsTableId;
  return config.runrateTableId;
}

/**
 * Sync domains. Each scheduled trigger runs exactly one of these, so cynet health can stay live and
 * untouched while canada / locums are being worked on: a domain's run only ever reads and writes its
 * own table, and keeps its own checkpoint. Domain is decided by ASSIGNMENT_RECRUITER_EMAIL, the same
 * signal resolveActiveDealSheetTableId already routes on, so a filtered run and an unfiltered one
 * land the same rows in the same table.
 */
const SYNC_DOMAINS = ["health", "canada", "locums"];

const DOMAIN_TO_ACTIVE_TABLE = new Map([
  ["health", TABLE_CYNET_HEALTH],
  ["canada", TABLE_CYNET_HEALTH_CANADA],
  ["locums", TABLE_CYNET_LOCUMS],
]);

/**
 * Normalize a domain name from params/env. Returns null for empty/unknown, which callers must treat
 * as "no filter — process every domain" (the pre-split behaviour).
 * @param {unknown} domain
 * @returns {string|null}
 */
function normalizeSyncDomain(domain) {
  const key = String(domain ?? "").trim().toLowerCase();
  if (!key) return null;
  return DOMAIN_TO_ACTIVE_TABLE.has(key) ? key : null;
}

/**
 * Active deal sheet table a domain owns.
 * @param {unknown} domain
 * @returns {string|null}
 */
function resolveActiveDealSheetTableIdForDomain(domain) {
  const key = normalizeSyncDomain(domain);
  return key ? DOMAIN_TO_ACTIVE_TABLE.get(key) : null;
}

/**
 * True when a row belongs to `domain`. A null/unknown domain matches everything, so callers can pass
 * the raw param straight through without branching.
 * @param {unknown} domain
 * @param {unknown} email - ASSIGNMENT_RECRUITER_EMAIL
 * @returns {boolean}
 */
function rowMatchesSyncDomain(domain, email) {
  const wanted = resolveActiveDealSheetTableIdForDomain(domain);
  if (!wanted) return true;
  return resolveActiveDealSheetTableId(email) === wanted;
}

module.exports = {
  ACTIVE_DEAL_SHEET_TABLE_IDS,
  resolveActiveDealSheetTableId,
  SYNC_DOMAINS,
  normalizeSyncDomain,
  resolveActiveDealSheetTableIdForDomain,
  rowMatchesSyncDomain,
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
  resolvePairedActiveTableId,
  resolveRunrateTableIdForDealSheetTable,
};
