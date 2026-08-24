const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  domainWritesEnrichLogs,
  ENRICH_LOG_WRITES_DISABLED_DOMAINS,
} = require("./syncService");
const { isCanadaDealSheetRow } = require("./canadaDerivedPlacementFields");
const { RATE_CHANGE_LOG_EXCLUDED_TABLE_IDS } = require("./bigQueryClient");

/**
 * While Canada is being validated its rows are deleted and re-synced repeatedly, so no log table
 * should accumulate rows keyed on them. Two separate mechanisms cover that:
 *   1. the per-row enrich log writes (ch_additional_cost_logs / ch_termination_reason_logs)
 *   2. the table-wide audit scans run from the scheduled triggers (ownership / inorganic)
 * Cynet health and locums must be unaffected by both.
 */

// --------------------------------------------------------------------------
// 1. Per-row enrich log writes
// --------------------------------------------------------------------------

test("canada does not write the per-row enrich logs", () => {
  assert.equal(domainWritesEnrichLogs({ sync_domain: "canada" }), false);
});

test("health and locums still write the per-row enrich logs", () => {
  assert.equal(domainWritesEnrichLogs({ sync_domain: "health" }), true);
  assert.equal(domainWritesEnrichLogs({ sync_domain: "locums" }), true);
});

test("a run with no domain keeps writing logs", () => {
  // The manual HTTP paths pass no sync_domain; they must behave exactly as before.
  assert.equal(domainWritesEnrichLogs({}), true);
  assert.equal(domainWritesEnrichLogs({ sync_domain: undefined }), true);
  assert.equal(domainWritesEnrichLogs(undefined), true);
});

test("the canada check is case- and whitespace-insensitive", () => {
  for (const v of ["CANADA", "Canada", "  canada  "]) {
    assert.equal(domainWritesEnrichLogs({ sync_domain: v }), false, v);
  }
});

test("only canada is disabled", () => {
  assert.deepEqual([...ENRICH_LOG_WRITES_DISABLED_DOMAINS], ["canada"]);
});

// --------------------------------------------------------------------------
// 2. Table-wide audit scans in the scheduled triggers
// --------------------------------------------------------------------------

const INDEX_SRC = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");

test("canada is the only domain skipping the audit-log scans", () => {
  const m = /const SYNC_DOMAINS_WITHOUT_AUDIT_LOG_SCANS = new Set\(\[([^\]]*)\]\)/.exec(INDEX_SRC);
  assert.ok(m, "SYNC_DOMAINS_WITHOUT_AUDIT_LOG_SCANS must exist");
  const domains = m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  assert.deepEqual(domains, ["canada"]);
});

test("both scheduled triggers gate their audit scans", () => {
  const guards = INDEX_SRC.match(/if \(!domainRunsAuditLogScans\(domain\)\) \{/g);
  assert.equal(guards?.length, 2, "insert and update triggers both need the guard");
});

test("the audit scans are still wired up for the domains that run them", () => {
  // The guard must skip the scans, not delete them — health still runs all three.
  for (const call of [
    "syncOwnershipChangeLogEffectiveDatesFromExtensions({",
    "syncInorganicHierarchyLogsFromBigQuery({",
    "syncOwnershipChangeLogsFromBigQuery({",
  ]) {
    assert.ok(INDEX_SRC.includes(call), call);
  }
});

// --------------------------------------------------------------------------
// 3. Insert-time contract-chain ownership logs
//
// These run inside insertAll, so EVERY insert path reaches them — the scheduled trigger, the manual
// HTTP sync and the refresh endpoint alike. The gate is on the rows themselves (CLIENT_STATE), not
// on a caller-supplied flag, so no path can bypass it.
// --------------------------------------------------------------------------

const BQ_SRC = fs.readFileSync(path.join(__dirname, "bigQueryClient.js"), "utf8");

test("canada log writes are switched off", () => {
  assert.ok(
    /const LOG_WRITES_DISABLED_FOR_CANADA = true;/.test(BQ_SRC),
    "the canada log kill-switch must be on while the domain is being validated"
  );
});

test("insert-time ownership logs filter canada rows out", () => {
  // Mirrors the filter applied in insertAll.
  const rows = [
    { CLIENT_STATE: "BC", PLACEMENT_ID: 1 },
    { CLIENT_STATE: "TX", PLACEMENT_ID: 2 },
    { CLIENT_STATE: "ON", PLACEMENT_ID: 3 },
    { CLIENT_STATE: "AZ", PLACEMENT_ID: 4 },
  ];
  const kept = rows.filter((r) => !isCanadaDealSheetRow(r));
  assert.deepEqual(kept.map((r) => r.PLACEMENT_ID), [2, 4], "only non-canada rows may be logged");
});

test("the insertAll gate filters on rows, not on a caller flag", () => {
  assert.ok(
    BQ_SRC.includes("rowsToInsert.filter((row) => !isCanadaDealSheetRow(row))"),
    "the ownership-log row set must be filtered by CLIENT_STATE"
  );
  assert.ok(
    BQ_SRC.includes("ownershipLogRows.length > 0"),
    "an all-canada batch must skip the ownership-log call entirely"
  );
});

test("a batch of only canada rows writes no ownership logs at all", () => {
  const rows = [{ CLIENT_STATE: "BC" }, { CLIENT_STATE: "NL" }];
  assert.equal(rows.filter((r) => !isCanadaDealSheetRow(r)).length, 0);
});

test("health-only batches are unaffected", () => {
  const rows = [{ CLIENT_STATE: "TX" }, { CLIENT_STATE: "CA" }, { CLIENT_STATE: null }];
  assert.equal(rows.filter((r) => !isCanadaDealSheetRow(r)).length, 3);
});

// --------------------------------------------------------------------------
// 4. ch_rate_change_logs
//
// rateChangeLogSyncTrigger is a SEPARATE scheduled function from the per-domain deal sheet triggers,
// so the domain gates in index.js never reach it — it scans every active table on its own schedule.
// Canada is excluded from its union instead.
// --------------------------------------------------------------------------

test("the rate-change scan excludes both canada tables", () => {
  assert.ok(RATE_CHANGE_LOG_EXCLUDED_TABLE_IDS.has("cynet_health_canada_deal_sheet"));
  assert.ok(RATE_CHANGE_LOG_EXCLUDED_TABLE_IDS.has("cynet_health_canada_ended_deal_sheet"));
});

test("the rate-change scan still covers health and locums", () => {
  assert.ok(!RATE_CHANGE_LOG_EXCLUDED_TABLE_IDS.has("cynet_health_deal_sheet"));
  assert.ok(!RATE_CHANGE_LOG_EXCLUDED_TABLE_IDS.has("cynet_locums_deal_sheet"));
});

test("both rate-change union call sites pass the exclusion", () => {
  // Two fetches build the union: the CONTRACT_ID pair scan and the segment scan. Missing either one
  // would let canada rows back into ch_rate_change_logs.
  const gated = (BQ_SRC.match(/excludeTableIds: RATE_CHANGE_LOG_EXCLUDED_TABLE_IDS/g) || []).length;
  assert.equal(gated, 2, "both fetchContract*RateChangePairsFromActive calls must be gated");
});

test("the union builder defaults to every table when no exclusion is passed", () => {
  // Other callers must be unaffected by the new option.
  assert.ok(
    BQ_SRC.includes('async function buildActiveDealSheetSchemaSafeUnionParts(datasetId, whereClause = "", options = {})'),
    "exclusion must be an optional third argument"
  );
});
