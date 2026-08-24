const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EXTENSION_RUNRATE_HIERARCHY_COLUMNS,
  RUNRATE_HIERARCHY_MISSING_COLUMNS_BY_TABLE,
  resolveExtensionRunrateHierarchyColumns,
} = require("./bigQueryClient");

// Regression: dealSheetSyncTrigger crashed with "Unrecognized name: AVP at [31:7]" once
// RUNRATE_LOCUMS_TABLE_ID was pointed at the real all_locums_runrate table. The code assumed every
// domain run-rate table shared all_CH_data_runrate's schema (confirmed via INFORMATION_SCHEMA.COLUMNS
// on 2026-07-28); all_locums_runrate has every EXTENSION_RUNRATE_HIERARCHY_COLUMNS entry except
// AVP/AVP_EMP_NO, so unconditionally SELECTing AVP from it fails.

test("all_locums_runrate has AVP registered as a known schema gap", () => {
  assert.ok(RUNRATE_HIERARCHY_MISSING_COLUMNS_BY_TABLE.get("all_locums_runrate")?.has("AVP"));
});

test("resolveExtensionRunrateHierarchyColumns drops AVP for all_locums_runrate only", () => {
  const locumsCols = resolveExtensionRunrateHierarchyColumns("all_locums_runrate");
  assert.ok(!locumsCols.includes("AVP"));
  // Every other confirmed-present column stays.
  for (const col of ["TEAM_LEAD", "ATL", "RM", "ACCOUNT_MANAGER", "SECONDARY_AM", "ASSOCIATE_AM", "ASSOCIATE_DELIVERY_DIRECTOR", "DELIVERY_DIRECTOR", "VP"]) {
    assert.ok(locumsCols.includes(col), `expected ${col} to remain for all_locums_runrate`);
  }
});

test("resolveExtensionRunrateHierarchyColumns is a no-op for tables with no registered gap", () => {
  assert.deepEqual(resolveExtensionRunrateHierarchyColumns("all_CH_data_runrate"), EXTENSION_RUNRATE_HIERARCHY_COLUMNS);
  assert.deepEqual(resolveExtensionRunrateHierarchyColumns("some_future_table"), EXTENSION_RUNRATE_HIERARCHY_COLUMNS);
});

test("the canada run-rate table drops AVP (it has no AVP column)", () => {
  // Cynet Health Canada has no AVP role — the chain tops out at VP / Sr. VP — so
  // all_Health_Canada_data_Runrate carries no AVP column and naming it fails the query.
  const cols = resolveExtensionRunrateHierarchyColumns("all_Health_Canada_data_Runrate");
  assert.ok(!cols.includes("AVP"));
  assert.ok(cols.includes("VP"));
  assert.equal(cols.length, EXTENSION_RUNRATE_HIERARCHY_COLUMNS.length - 1);
});

test("EXTENSION_RUNRATE_HIERARCHY_COLUMNS itself is untouched (source of truth stays intact)", () => {
  assert.ok(EXTENSION_RUNRATE_HIERARCHY_COLUMNS.includes("AVP"));
  assert.ok(EXTENSION_RUNRATE_HIERARCHY_COLUMNS.includes("DELIVERY_DIRECTOR"));
});
