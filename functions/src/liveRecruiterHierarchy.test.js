const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  usesLiveRecruiterHierarchy,
  LIVE_MANAGED_HIERARCHY_FIELDS,
  rowNeedsDealRecruiterHierarchyBackfill,
  applyDealRecruiterHierarchyForInsertRows,
  applyExtensionInheritForInsertRows,
  applyLiveRecruiterHierarchyToDealSheet,
} = require("./bigQueryClient");
const {
  syncInorganicHierarchyLogsFromBigQuery,
  syncLiveRecruiterHierarchyForDomain,
  LIVE_RECRUITER_HIERARCHY_DOMAINS,
} = require("./syncService");

// Canada and Locums have no inorganic hierarchy: a person is effective as soon as they are in the
// recruiter's chain. Health keeps its freeze-at-hire + inorganic log model unchanged.

const CANADA = { CLIENT_STATE: "BC", ASSIGNMENT_RECRUITER_EMAIL: "rec@cynethealth.ca" };
const LOCUMS = { CLIENT_STATE: "TX", ASSIGNMENT_RECRUITER_EMAIL: "rec@cynetlocums.com" };
const GOV_DESK_LOCUMS = { CLIENT_STATE: "TX", ASSIGNMENT_RECRUITER_EMAIL: "rec@cynethealth.com", OFFERING: "LOCUMS" };
const HEALTH = { CLIENT_STATE: "TX", ASSIGNMENT_RECRUITER_EMAIL: "rec@cynethealth.com" };

test("canada and locums rows use the live chain; health does not", () => {
  assert.equal(usesLiveRecruiterHierarchy(CANADA), true);
  assert.equal(usesLiveRecruiterHierarchy(LOCUMS), true);
  assert.equal(usesLiveRecruiterHierarchy(GOV_DESK_LOCUMS), true);
  assert.equal(usesLiveRecruiterHierarchy(HEALTH), false);
  // "CA" is California, not Canada.
  assert.equal(usesLiveRecruiterHierarchy({ ...HEALTH, CLIENT_STATE: "CA" }), false);
});

test("the live chain owns the managed fields only, never the manual SECONDARY_* ones", () => {
  assert.ok(LIVE_MANAGED_HIERARCHY_FIELDS.includes("TEAM_LEAD"));
  assert.ok(LIVE_MANAGED_HIERARCHY_FIELDS.includes("TEAM_LEAD_EMP_NO"));
  for (const manual of ["SECONDARY_RECRUITER", "SECONDARY_RECRUITER_EMP_NO", "SECONDARY_AM", "SECONDARY_AM_EMP_NO"]) {
    assert.ok(!LIVE_MANAGED_HIERARCHY_FIELDS.includes(manual), manual);
  }
});

test("canada / locums EXTENSION inserts take the directory chain; health EXTENSION does not", () => {
  const ext = { DEAL_TYPE: "EXTENSION", PLACEMENT_ID: 1, TEAM_LEAD: null };
  assert.equal(rowNeedsDealRecruiterHierarchyBackfill({ ...ext, ...CANADA }), true);
  assert.equal(rowNeedsDealRecruiterHierarchyBackfill({ ...ext, ...LOCUMS }), true);
  assert.equal(rowNeedsDealRecruiterHierarchyBackfill({ ...ext, ...HEALTH }), false);
  // An update-append still never re-derives on insert — the live scan owns updates.
  assert.equal(
    rowNeedsDealRecruiterHierarchyBackfill({ ...ext, ...CANADA, __CARRIED_FORWARD_UPDATE: true }),
    false
  );
});

test("the current-chain option reaches the directory lookup", async () => {
  let seenOptions = null;
  await applyDealRecruiterHierarchyForInsertRows(
    [{ DEAL_TYPE: "EXTENSION", PLACEMENT_ID: 7, ...HEALTH, TEAM_LEAD: null }],
    { currentChain: true },
    { fetchFn: async (_rows, options) => { seenOptions = options; return new Map(); } }
  );
  assert.equal(seenOptions?.currentChain, true);
});

// --------------------------------------------------------------------------
// EXTENSION inherit: no stale chain from parent DEAL / prior extension / run-rate
// --------------------------------------------------------------------------

const noPrior = async () => new Map();
const noContract = async () => new Map();

test("a canada extension does not inherit the managed hierarchy from its parent DEAL", async () => {
  const rows = [{
    DEAL_TYPE: "EXTENSION", CONTRACT_ID: null, CANDIDATE_ID: 1, PLACEMENT_ID: 500,
    ...CANADA, TEAM_LEAD: "Live Lead", TEAM_LEAD_EMP_NO: "E-LIVE", INITIAL_START_DATE: null,
  }];
  const parentFetchFn = async () => new Map([["500", {
    INITIAL_START_DATE: "2026-01-05", TEAM_LEAD: "Stale Parent Lead", TEAM_LEAD_EMP_NO: "E-OLD",
  }]]);
  const runrateFetchFn = async () => new Map([["500", { RM: "Stale Runrate RM", RM_EMP_NO: "E-RR" }]]);
  const [out] = await applyExtensionInheritForInsertRows(rows, {}, {
    parentFetchFn, priorExtensionFetchFn: noPrior, runrateFetchFn, resolveContractIdsFn: noContract,
    queryObjectsFn: async () => [],
  });
  assert.equal(out.TEAM_LEAD, "Live Lead");
  assert.equal(out.TEAM_LEAD_EMP_NO, "E-LIVE");
  assert.equal(out.RM ?? null, null);
  // Non-hierarchy inherit still works.
  assert.equal(out.INITIAL_START_DATE, "2026-01-05");
});

test("a health extension still takes its parent DEAL's hierarchy", async () => {
  const rows = [{
    DEAL_TYPE: "EXTENSION", CONTRACT_ID: null, CANDIDATE_ID: 1, PLACEMENT_ID: 501,
    ...HEALTH, TEAM_LEAD: null, INITIAL_START_DATE: null,
  }];
  const parentFetchFn = async () => new Map([["501", { TEAM_LEAD: "Parent Lead", TEAM_LEAD_EMP_NO: "E-P" }]]);
  const [out] = await applyExtensionInheritForInsertRows(rows, {}, {
    parentFetchFn, priorExtensionFetchFn: noPrior, runrateFetchFn: async () => new Map(),
    resolveContractIdsFn: noContract,
  });
  assert.equal(out.TEAM_LEAD, "Parent Lead");
});

// --------------------------------------------------------------------------
// The live scan
// --------------------------------------------------------------------------

function storedRow(pid, overrides = {}) {
  return {
    DEAL_SHEET_ID: 9000 + pid, PLACEMENT_ID: pid, PLACEMENT_STATUS: "STARTED", DEAL_TYPE: "DEAL",
    ASSIGNMENT_RECRUITER_EMAIL: "rec@cynethealth.ca", RECRUITER_EMP_NO: "R1",
    TEAM_LEAD: "Old Lead", TEAM_LEAD_EMP_NO: "E1", RM: "Same RM", RM_EMP_NO: "E2",
    ...overrides,
  };
}

async function runScan(domain, stored, chainByPid) {
  let sql = "";
  let appended = null;
  let resolveOptions = null;
  const result = await applyLiveRecruiterHierarchyToDealSheet(
    { datasetId: "rr_project_data", domain },
    {
      queryFn: async (q) => { sql = q; return stored; },
      resolveFn: async (rows, options) => {
        resolveOptions = options;
        return rows.map((r) => ({ ...r, ...(chainByPid[r.PLACEMENT_ID] || {}) }));
      },
      appendFn: async (updates) => { appended = updates; return { appended: updates.length }; },
    }
  );
  return { result, sql, appended, resolveOptions };
}

test("a changed chain is appended onto the deal sheet with the whole managed set", async () => {
  const { result, appended, resolveOptions } = await runScan("canada", [storedRow(1)], {
    1: { TEAM_LEAD: "New Lead", TEAM_LEAD_EMP_NO: "E9", RM: "Same RM", RM_EMP_NO: "E2" },
  });
  assert.equal(resolveOptions.currentChain, true);
  assert.equal(result.changed, 1);
  assert.equal(appended.length, 1);
  const [u] = appended;
  assert.equal(u.srcTable, "cynet_health_canada_deal_sheet");
  assert.equal(u.updatedFields.TEAM_LEAD, "New Lead");
  assert.equal(u.updatedFields.TEAM_LEAD_EMP_NO, "E9");
  assert.equal(u.updatedFields.RM, "Same RM");
  // A role nobody holds any more is cleared, not left stale.
  assert.equal(u.updatedFields.ATL, null);
  // Canada has no AVP column, so it is never written.
  assert.ok(!("AVP" in u.updatedFields));
  assert.ok(!("SECONDARY_RECRUITER" in u.updatedFields));
});

test("an unchanged chain appends nothing", async () => {
  const { result, appended } = await runScan("canada", [storedRow(2)], {
    2: { TEAM_LEAD: "Old Lead", TEAM_LEAD_EMP_NO: "E1", RM: "Same RM", RM_EMP_NO: "E2" },
  });
  assert.equal(result.changed, 0);
  assert.equal(appended, null);
});

test("a recruiter the directory cannot resolve keeps its hierarchy", async () => {
  const { result, appended } = await runScan("locums", [storedRow(3)], {});
  assert.equal(result.checked, 1);
  assert.equal(result.changed, 0);
  assert.equal(appended, null);
});

test("the scan reads only open DEAL / EXTENSION placements of its own table", async () => {
  const { sql } = await runScan("locums", [], {});
  assert.match(sql, /cynet_locums_deal_sheet`/);
  assert.ok(!sql.includes("cynet_health_deal_sheet`"));
  assert.ok(!sql.includes("cynet_health_canada_deal_sheet`"));
  assert.match(sql, /NOT LIKE 'ENDED%'/);
  // ENDED is judged on the LATEST row, i.e. after rn = 1.
  assert.ok(sql.indexOf("rn = 1") < sql.indexOf("NOT LIKE 'ENDED%'"));
  const { sql: canadaSql } = await runScan("canada", [], {});
  assert.ok(!/\bAVP\b/.test(canadaSql), "canada table has no AVP column");
});

test("the live scan is a no-op for health", async () => {
  const out = await syncLiveRecruiterHierarchyForDomain({ sync_domain: "health" });
  assert.equal(out.skipped, true);
  const none = await syncLiveRecruiterHierarchyForDomain({});
  assert.equal(none.skipped, true);
});

// --------------------------------------------------------------------------
// No inorganic logs for canada / locums
// --------------------------------------------------------------------------

test("canada and locums are the live-hierarchy domains", () => {
  assert.deepEqual([...LIVE_RECRUITER_HIERARCHY_DOMAINS].sort(), ["canada", "locums"]);
});

test("the inorganic scan skips canada and locums without querying anything", async () => {
  for (const domain of ["canada", "locums", " Canada "]) {
    const out = await syncInorganicHierarchyLogsFromBigQuery({ sync_domain: domain });
    assert.equal(out.inserted, 0, domain);
    assert.ok(out.skippedDomain, domain);
  }
});

const SYNC_SRC = fs.readFileSync(path.join(__dirname, "syncService.js"), "utf8");
const INDEX_SRC = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");

test("an inorganic scan with no domain covers health only", () => {
  assert.ok(SYNC_SRC.includes('const domain = requestedDomain ?? "health";'));
});

test("both triggers run the live scan before the audit-log guard", () => {
  const parts = INDEX_SRC.split("await syncLiveRecruiterHierarchyForDomain({").slice(1);
  assert.equal(parts.length, 2, "insert + update trigger");
  for (const after of parts) {
    assert.match(after.slice(0, after.indexOf("});")), /sync_domain: domain,/);
    const guard = after.indexOf("if (!domainRunsAuditLogScans(domain)) {");
    assert.ok(guard > 0 && guard < 800, "live scan must sit right before the guard");
  }
});
