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

/** OFFERING value that marks a placement as locums business regardless of who recruited it. */
const OFFERING_LOCUMS = "LOCUMS";

/**
 * True when the row's OFFERING says this is locums business.
 *
 * OFFERING comes from the Nexus job, not from the recruiter, so it is the authority on what KIND of
 * business a placement is. The recruiter email only says who owns it.
 */
function isLocumsOffering(row) {
  return (
    String(row?.OFFERING ?? "")
      .trim()
      .toUpperCase() === OFFERING_LOCUMS
  );
}

/**
 * Table a row belongs in, deciding on the row rather than the recruiter email alone.
 *
 * A recruiter on @cynethealth.com can place locums business — the GOV desk does exactly this, e.g.
 * "Demi Sharma (GOV)" <demi.s@cynethealth.com> with OFFERING=LOCUMS, JOB_TYPE=LOCUM,
 * PROFESSION=Physician and a @cynetlocums.com onsite AM. Routing on the email alone put those rows in
 * cynet_health_deal_sheet, where locums-specific derivations (pay/bill/margin) do not apply and the
 * health reporting counts business that is not health's.
 *
 * OFFERING wins over the email for the US pair only. A @cynethealth.ca recruiter stays on the Canada
 * table: Canada is a separate legal entity, so its rows must not be pulled into a US table by the
 * kind of work they describe.
 *
 * @param {Record<string, *>|null|undefined} row
 * @returns {string} BigQuery table id for rr_project_data
 */
function resolveActiveDealSheetTableIdForRow(row) {
  const byEmail = resolveActiveDealSheetTableId(row?.ASSIGNMENT_RECRUITER_EMAIL);
  if (byEmail === TABLE_CYNET_HEALTH && isLocumsOffering(row)) return TABLE_CYNET_LOCUMS;
  return byEmail;
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

/**
 * Ended-table twin of resolveActiveDealSheetTableIdForRow — same OFFERING-over-email rule, so a
 * placement does not change domain when it moves from the active table to the ended one.
 *
 * @param {Record<string, *>|null|undefined} row
 * @returns {string} BigQuery ended deal sheet table id
 */
function resolveEndedDealSheetTableIdForRow(row) {
  const byEmail = resolveEndedDealSheetTableId(row?.ASSIGNMENT_RECRUITER_EMAIL);
  if (byEmail === TABLE_ENDED_CYNET_HEALTH && isLocumsOffering(row)) return TABLE_ENDED_CYNET_LOCUMS;
  return byEmail;
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

/**
 * Row-aware twin of rowMatchesSyncDomain: decides on the whole row so OFFERING is honoured.
 *
 * This is what keeps a locums placement out of the health run. The health domain filter previously
 * saw only ASSIGNMENT_RECRUITER_EMAIL, so a @cynethealth.com recruiter's OFFERING=LOCUMS row passed
 * the filter and was inserted into cynet_health_deal_sheet. Deciding on the row sends it to the
 * locums run instead — and because both the filter and the insert-time table resolver now use the
 * same rule, a row is claimed by exactly one domain.
 *
 * @param {unknown} domain
 * @param {Record<string, *>|null|undefined} row
 * @returns {boolean}
 */
function rowMatchesSyncDomainForRow(domain, row) {
  const wanted = resolveActiveDealSheetTableIdForDomain(domain);
  if (!wanted) return true;
  return resolveActiveDealSheetTableIdForRow(row) === wanted;
}

module.exports = {
  ACTIVE_DEAL_SHEET_TABLE_IDS,
  resolveActiveDealSheetTableId,
  resolveActiveDealSheetTableIdForRow,
  resolveEndedDealSheetTableIdForRow,
  rowMatchesSyncDomainForRow,
  isLocumsOffering,
  OFFERING_LOCUMS,
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
