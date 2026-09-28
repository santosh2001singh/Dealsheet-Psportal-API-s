const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildActiveChangeScanUnionParts,
  fetchActiveExtensionRowsForInorganic,
} = require("./bigQueryClient");
const {
  ACTIVE_DEAL_SHEET_TABLE_IDS,
  resolveActiveDealSheetTableIdForDomain,
  resolveSyncDomainForActiveTableId,
} = require("./recruiterDomainTables");

// Each scheduled trigger owns ONE domain, so the shared audit-log scans it runs (ownership /
// inorganic / effective-date) must read only that domain's deal sheet table. Before this, a health
// run's scans unioned all three tables and wrote 300 ownership + 1 inorganic log rows for canada
// placements while canada's own logs were switched off.

const DOMAINS = ["health", "canada", "locums"];

test("the change-scan union reads only the given domain's table", () => {
  for (const domain of DOMAINS) {
    const table = resolveActiveDealSheetTableIdForDomain(domain);
    const parts = buildActiveChangeScanUnionParts("rr_project_data", domain);
    assert.equal(parts.length, 1, domain);
    assert.match(parts[0], new RegExp(`\\.${table}\``), domain);
    for (const other of ACTIVE_DEAL_SHEET_TABLE_IDS.filter((t) => t !== table)) {
      assert.ok(!parts[0].includes(`.${other}\``), `${domain} must not read ${other}`);
    }
  }
});

test("with no domain the union still covers all three tables", () => {
  // Manual HTTP calls pass no sync_domain and keep the old behaviour.
  assert.equal(buildActiveChangeScanUnionParts("rr_project_data").length, 3);
  assert.equal(buildActiveChangeScanUnionParts("rr_project_data", null).length, 3);
});

test("the inorganic EXTENSION seed reads only the given domain's table", async () => {
  for (const domain of DOMAINS) {
    let sql = "";
    await fetchActiveExtensionRowsForInorganic(
      { datasetId: "rr_project_data", domain },
      { queryFn: async (q) => { sql = q; return []; } }
    );
    const table = resolveActiveDealSheetTableIdForDomain(domain);
    assert.ok(sql.includes(`.${table}\``), domain);
    for (const other of ACTIVE_DEAL_SHEET_TABLE_IDS.filter((t) => t !== table)) {
      assert.ok(!sql.includes(`.${other}\``), `${domain} must not read ${other}`);
    }
  }
});

test("table -> domain is the inverse of domain -> table", () => {
  for (const domain of DOMAINS) {
    assert.equal(resolveSyncDomainForActiveTableId(resolveActiveDealSheetTableIdForDomain(domain)), domain);
  }
  assert.equal(resolveSyncDomainForActiveTableId("cynet_health_canada_ended_deal_sheet"), null);
  assert.equal(resolveSyncDomainForActiveTableId(""), null);
});

// --------------------------------------------------------------------------
// Wiring: the domain has to actually reach the scans.
// --------------------------------------------------------------------------

const INDEX_SRC = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
const SYNC_SRC = fs.readFileSync(path.join(__dirname, "syncService.js"), "utf8");

test("both triggers pass their domain to every audit-log scan", () => {
  for (const fn of [
    "syncOwnershipChangeLogEffectiveDatesFromExtensions",
    "syncInorganicHierarchyLogsFromBigQuery",
    "syncOwnershipChangeLogsFromBigQuery",
  ]) {
    const calls = INDEX_SRC.split(`await ${fn}({`).slice(1);
    assert.equal(calls.length, 2, `${fn}: insert + update trigger`);
    for (const body of calls) {
      const args = body.slice(0, body.indexOf("});"));
      assert.match(args, /sync_domain: domain,/, fn);
    }
  }
});

test("each scan hands its domain to every source query", () => {
  for (const call of [
    "fetchActiveExtensionRowsForInorganic({ datasetId: dealSheetDatasetId, domain })",
    "fetchRecruiterHierarchyReconciliation({ datasetId: dealSheetDatasetId, domain })",
    "fetchDealSheetOwnershipChangePairsFromActive({ datasetId: dealSheetDatasetId, domain })",
  ]) {
    assert.ok(SYNC_SRC.includes(call), call);
  }
  for (const fn of [
    "fetchDealSheetRecruiterChangePairsFromActive",
    "fetchContractOwnershipChangePairsFromActive",
    "overwriteOwnershipChangeLogCandidateInfoFromDealSheet",
    "overwriteOwnershipChangeLogDatesFromPlacements",
  ]) {
    const body = SYNC_SRC.split(`await ${fn}({`)[1] ?? "";
    assert.match(body.slice(0, body.indexOf("});")), /\bdomain,/, fn);
  }
});

test("the refresh endpoint writes logs under the row's own domain", () => {
  // Manual refresh passes no sync_domain; the log gates must read the row's table instead.
  assert.equal((SYNC_SRC.match(/resolveSyncDomainForActiveTableId\(effectiveTableId\)/g) || []).length, 2);
  assert.equal((SYNC_SRC.match(/writeAdditionalCostLogRows\(additionalCostLogRows, 0, logParams,/g) || []).length, 2);
  assert.equal((SYNC_SRC.match(/writeTerminationReasonLogRows\(terminationLogRows, 0, logParams,/g) || []).length, 2);
  assert.ok(SYNC_SRC.includes("if (domainWritesEnrichLogs(logParams)) {"), "handover ownership gate");
  assert.ok(
    SYNC_SRC.includes("params.refresh_run_inorganic_scan === true && domainWritesEnrichLogs(logParams)"),
    "inorganic scan gate"
  );
});
