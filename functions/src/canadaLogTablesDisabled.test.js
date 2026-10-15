const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  domainWritesEnrichLogs,
  ENRICH_LOG_WRITES_DISABLED_DOMAINS,
} = require("./syncService");
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

test("locums does not write the per-row enrich logs either", () => {
  assert.equal(domainWritesEnrichLogs({ sync_domain: "locums" }), false);
});

test("health still writes the per-row enrich logs", () => {
  assert.equal(domainWritesEnrichLogs({ sync_domain: "health" }), true);
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

test("canada and locums are the disabled domains", () => {
  assert.deepEqual([...ENRICH_LOG_WRITES_DISABLED_DOMAINS].sort(), ["canada", "locums"]);
});

// --------------------------------------------------------------------------
// 2. Table-wide audit scans in the scheduled triggers
// --------------------------------------------------------------------------

const INDEX_SRC = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");

test("canada and locums are the domains skipping the audit-log scans", () => {
  const m = /const SYNC_DOMAINS_WITHOUT_AUDIT_LOG_SCANS = new Set\(\[([^\]]*)\]\)/.exec(INDEX_SRC);
  assert.ok(m, "SYNC_DOMAINS_WITHOUT_AUDIT_LOG_SCANS must exist");
  const domains = m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  assert.deepEqual(domains.sort(), ["canada", "locums"]);
});

test("both scheduled triggers gate their audit scans", () => {
  const guards = INDEX_SRC.match(/if \(!domainRunsAuditLogScans\(domain\)\) \{/g);
  assert.equal(guards?.length, 2, "insert and update triggers both need the guard");
});

test("canada runs the ownership-log scans only; locums runs none", () => {
  const m = /const SYNC_DOMAINS_WITH_OWNERSHIP_LOG_SCANS_ONLY = new Set\(\[([^\]]*)\]\)/.exec(INDEX_SRC);
  assert.ok(m, "SYNC_DOMAINS_WITH_OWNERSHIP_LOG_SCANS_ONLY must exist");
  const domains = m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  assert.deepEqual(domains, ["canada"]);
  // Both skip branches take the ownership-only path before returning.
  const branches = INDEX_SRC.match(/if \(domainRunsOwnershipLogScansOnly\(domain\)\) \{/g);
  assert.equal(branches?.length, 2);
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
//
// Canada's ownership_change_logs are the one Canada log that is ON (Sep 2026) — Canada has no
// inorganic hierarchy, so this log is its only record of who held each seat.
// --------------------------------------------------------------------------

const BQ_SRC = fs.readFileSync(path.join(__dirname, "bigQueryClient.js"), "utf8");

test("canada log writes are switched off", () => {
  assert.ok(
    /const LOG_WRITES_DISABLED_FOR_CANADA = true;/.test(BQ_SRC),
    "the canada log kill-switch must be on while the domain is being validated"
  );
});

test("canada ownership log writes are the exception and switched on", () => {
  assert.ok(/const OWNERSHIP_LOG_WRITES_ENABLED_FOR_CANADA = true;/.test(BQ_SRC));
});

test("the insertAll gate filters on rows, not on a caller flag", () => {
  assert.ok(
    BQ_SRC.includes("if (isCanadaDealSheetRow(row)) return OWNERSHIP_LOG_WRITES_ENABLED_FOR_CANADA;"),
    "canada rows must be let through by the ownership switch, keyed on CLIENT_STATE"
  );
  assert.ok(
    BQ_SRC.includes("isCynetLocumsRecruiter(row?.ASSIGNMENT_RECRUITER_EMAIL)"),
    "the ownership-log row set must also drop locums rows, by recruiter email"
  );
  assert.ok(
    BQ_SRC.includes("ownershipLogRows.length > 0"),
    "an empty batch must skip the ownership-log call entirely"
  );
});

test("the canada ownership check runs before the locums one (province beats locums)", () => {
  const canadaAt = BQ_SRC.indexOf("if (isCanadaDealSheetRow(row)) return OWNERSHIP_LOG_WRITES_ENABLED_FOR_CANADA;");
  const locumsAt = BQ_SRC.indexOf("if (LOG_WRITES_DISABLED_FOR_LOCUMS && isCynetLocumsRecruiter(row?.ASSIGNMENT_RECRUITER_EMAIL))");
  assert.ok(canadaAt > 0 && locumsAt > canadaAt);
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

test("the rate-change scan excludes both locums tables too", () => {
  assert.ok(RATE_CHANGE_LOG_EXCLUDED_TABLE_IDS.has("cynet_locums_deal_sheet"));
  assert.ok(RATE_CHANGE_LOG_EXCLUDED_TABLE_IDS.has("cynet_locums_ended_deal_sheet"));
});

test("the rate-change scan still covers health", () => {
  assert.ok(!RATE_CHANGE_LOG_EXCLUDED_TABLE_IDS.has("cynet_health_deal_sheet"));
  assert.ok(!RATE_CHANGE_LOG_EXCLUDED_TABLE_IDS.has("cynet_health_ended_deal_sheet"));
});

test("every rate-change union call site passes the exclusion", () => {
  // Three fetches build the union: the CONTRACT_ID pair scan, the placement-version scan and the
  // segment scan. Missing any one would let canada rows back into ch_rate_change_logs.
  const gated = (BQ_SRC.match(/excludeTableIds: RATE_CHANGE_LOG_EXCLUDED_TABLE_IDS/g) || []).length;
  assert.equal(gated, 3, "every fetch*RateChangePairsFromActive call must be gated");
});

test("the union builder defaults to every table when no exclusion is passed", () => {
  // Other callers must be unaffected by the new option.
  assert.ok(
    BQ_SRC.includes('async function buildActiveDealSheetSchemaSafeUnionParts(datasetId, whereClause = "", options = {})'),
    "exclusion must be an optional third argument"
  );
});
