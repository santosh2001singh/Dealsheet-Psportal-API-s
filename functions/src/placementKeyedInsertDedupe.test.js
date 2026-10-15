const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  allocateContractIdsForInsertableRows,
  resolveContractIdsForRows,
} = require("./contractIdResolver");
const {
  isPlacementKeyedDealSheetTable,
  isPlacementKeyedSyncDomain,
} = require("./recruiterDomainTables");

// Live case (Sep 2026): placement 1464278 (Albany Medical Center) was offer-rejected and stored as
// DID NOT ACCEPT under DEAL_SHEET_ID 5248044 with CHC23113. Nexus then moved that SAME deal sheet onto
// a new job and the candidate started as placement 1464580. Keyed on the deal sheet, the health insert
// skipped 1464580 forever. Health is now placement-keyed: the new placement is inserted and goes
// through the normal new-contract rules instead of inheriting CHC23113.

const SYNC_SRC = fs.readFileSync(path.join(__dirname, "syncService.js"), "utf8");
const BQ_SRC = fs.readFileSync(path.join(__dirname, "bigQueryClient.js"), "utf8");

const NEW_PLACEMENT = {
  DEAL_TYPE: "DEAL",
  DEAL_SHEET_ID: 5248044,
  PLACEMENT_ID: 1464580,
  CANDIDATE_ID: 8750069,
  CLIENT_ID: 3669334,
  CLIENT_STATE: "NY",
  ASSIGNMENT_RECRUITER_EMAIL: "mayank.r@cynethealth.com",
  CONTRACT_ID: null,
};

/** Stub for fetchContractIdsByDealSheetIds that records the options of every call. */
function tableHolds(byPlainKey, byPairKey, calls) {
  return {
    fetchContractIdsByDealSheetIdsFn: async (ids, opts) => {
      calls.push({ ids, matchPlacement: opts?.matchPlacement === true });
      return new Map(Object.entries(opts?.matchPlacement === true ? byPairKey : byPlainKey));
    },
  };
}

const NO_RUNRATE_MATCH = { fetchLegacyContractIdentityFn: async () => new Map() };

test("only health is placement-keyed", () => {
  assert.equal(isPlacementKeyedSyncDomain("health"), true);
  assert.equal(isPlacementKeyedSyncDomain("canada"), false);
  assert.equal(isPlacementKeyedSyncDomain("locums"), false);
  assert.equal(isPlacementKeyedSyncDomain(null), false, "legacy all-domain run keeps the old rule");
  assert.equal(isPlacementKeyedDealSheetTable("cynet_health_deal_sheet"), true);
  assert.equal(isPlacementKeyedDealSheetTable("cynet_health_canada_deal_sheet"), false);
  assert.equal(isPlacementKeyedDealSheetTable("cynet_locums_deal_sheet"), false);
  assert.equal(isPlacementKeyedDealSheetTable("cynet_health_ended_deal_sheet"), false);
});

test("health insert: a new placement on a known deal sheet does not take the old placement's id", async () => {
  const calls = [];
  const rows = [{ ...NEW_PLACEMENT }];
  await allocateContractIdsForInsertableRows(rows, {
    tableId: "cynet_health_deal_sheet",
    ...tableHolds({ 5248044: "CHC23113" }, { "5248044|1464278": "CHC23113" }, calls),
    ...NO_RUNRATE_MATCH,
    allocateContractIdsFn: async (n) => Array.from({ length: n }, (_, i) => `CHC9990${i}`),
  });

  assert.equal(rows[0].CONTRACT_ID, "CHC99900", "new placement mints under the normal rules");
  assert.ok(calls.length > 0 && calls.every((c) => c.matchPlacement), "health looks up DS + PLACEMENT");
});

test("health insert: the same placement still keeps its own existing id", async () => {
  const calls = [];
  const rows = [{ ...NEW_PLACEMENT, PLACEMENT_ID: 1464278 }];
  await allocateContractIdsForInsertableRows(rows, {
    tableId: "cynet_health_deal_sheet",
    ...tableHolds({}, { "5248044|1464278": "CHC23113" }, calls),
    ...NO_RUNRATE_MATCH,
    allocateContractIdsFn: async () => {
      throw new Error("must not mint: the placement already has an id");
    },
  });
  assert.equal(rows[0].CONTRACT_ID, "CHC23113");
});

test("canada insert: reuse stays keyed on DEAL_SHEET_ID alone", async () => {
  const calls = [];
  const rows = [{ ...NEW_PLACEMENT, CLIENT_STATE: "ON" }];
  await allocateContractIdsForInsertableRows(rows, {
    tableId: "cynet_health_canada_deal_sheet",
    ...tableHolds({ 5248044: "CAC1234" }, {}, calls),
    ...NO_RUNRATE_MATCH,
    allocateContractIdsFn: async () => {
      throw new Error("must not mint");
    },
  });
  assert.equal(rows[0].CONTRACT_ID, "CAC1234");
  assert.ok(calls.every((c) => !c.matchPlacement));
});

test("enrich-time reuse (Phase A) splits health and non-health rows by their own routing", async () => {
  const calls = [];
  const health = { ...NEW_PLACEMENT };
  const locums = { ...NEW_PLACEMENT, DEAL_SHEET_ID: 777, PLACEMENT_ID: 888, OFFERING: "LOCUMS" };
  await resolveContractIdsForRows([health, locums], {
    skipAllocation: true,
    ...tableHolds({ 5248044: "CHC23113", 777: "LOC1500" }, { "5248044|1464278": "CHC23113" }, calls),
    fetchContractIdsForExtensionsFn: async () => new Map(),
    // An email-only resolver, as the enricher passes: the gate must not trust it for routing.
    resolveTableIdFn: () => "cynet_health_deal_sheet",
  });

  assert.equal(health.CONTRACT_ID, null, "health new placement is left for Phase B to decide");
  assert.equal(locums.CONTRACT_ID, "LOC1500", "locums keeps DEAL_SHEET_ID reuse");
  assert.deepEqual(
    calls.map((c) => [c.ids, c.matchPlacement]),
    [[["777"], false], [["5248044"], true]]
  );
});

test("health insert trigger skips on PLACEMENT_ID only, in both dedupe layers", () => {
  assert.ok(SYNC_SRC.includes("const dedupeExistingByPlacementOnly = isPlacementKeyedSyncDomain(syncDomain);"));
  // pre-fetch skip filter: the DEAL_SHEET_ID half is off, the PLACEMENT_ID half is untouched
  assert.ok(SYNC_SRC.includes("if (!dedupeExistingByPlacementOnly && dsid != null"));
  assert.ok(SYNC_SRC.includes("if (pidKey !== \"\" && knownExistingPlacementIds.has(pidKey)) {"));
  // ...and the flag reaches the insert pipeline
  assert.ok(SYNC_SRC.includes("      dedupeExistingByPlacementOnly,\n"));
  assert.ok(BQ_SRC.includes("if (skipExistingDealSheets && !dedupeExistingByPlacementOnly) {"));
  assert.ok(BQ_SRC.includes("const existingDealSheets = dedupeExistingByPlacementOnly\n      ? new Set()"));
});
