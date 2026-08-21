const test = require("node:test");
const assert = require("node:assert/strict");

const {
  legacyDealManualColumns,
  RUNRATE_EXTRA_MANUAL_COLUMNS_BY_TABLE,
  RUNRATE_MANUAL_MISSING_COLUMNS_BY_TABLE,
} = require("./bigQueryClient");
const {
  applyCanadaDefaultEntity,
  CANADA_DEFAULT_ENTITY,
} = require("./canadaDerivedPlacementFields");
const { resolveRunrateTableIdForDealSheetTable } = require("./recruiterDomainTables");

const CANADA_RUNRATE = "all_Health_Canada_Deal_sheet_data";
const HEALTH_RUNRATE = "all_CH_data_runrate";
const LOCUMS_RUNRATE = "all_locums_runrate";

// The five columns Canada carries that health's run-rate table does not have.
const CANADA_ONLY = [
  "CLIENT_AVERAGING_AGREEMENT",
  "CANDIDATE_AVERAGING_AGREEMENT",
  "NO_OF_TIME_EXTENSION_RECEIVED",
  "DT_RATE",
  "CLIENT_DT_RATE",
];

// Columns in the shared list that the Canada source table does not have.
const CANADA_MISSING = [
  "CLIENT_NAME_IN_CONREP",
  "FIFTYTWO_TENURE_RTO_LASTDATE",
  "FIFTYTWO_TENURE_CANDIDATE_STATUS",
];

// --------------------------------------------------------------------------
// Canada's run-rate table is the one that actually exists
// --------------------------------------------------------------------------

test("the canada deal sheet resolves to the real run-rate table", () => {
  // Was "all_Health_Canada_data_Runrate" until Aug 2026 — a table that does not exist, so every
  // Canada legacy lookup failed and no Canada row recovered its CONTRACT_ID or manual columns.
  assert.equal(
    resolveRunrateTableIdForDealSheetTable("cynet_health_canada_deal_sheet"),
    CANADA_RUNRATE
  );
  assert.equal(
    resolveRunrateTableIdForDealSheetTable("cynet_health_canada_ended_deal_sheet"),
    CANADA_RUNRATE
  );
});

test("health and locums keep their own run-rate tables", () => {
  assert.equal(resolveRunrateTableIdForDealSheetTable("cynet_health_deal_sheet"), HEALTH_RUNRATE);
  assert.equal(resolveRunrateTableIdForDealSheetTable("cynet_locums_deal_sheet"), LOCUMS_RUNRATE);
});

// --------------------------------------------------------------------------
// Per-table manual column lists
// --------------------------------------------------------------------------

test("canada carries its five extra manual columns", () => {
  const cols = legacyDealManualColumns(CANADA_RUNRATE);
  for (const c of CANADA_ONLY) {
    assert.ok(cols.includes(c), `canada should carry ${c}`);
  }
});

test("canada omits the columns its source table does not have", () => {
  const cols = legacyDealManualColumns(CANADA_RUNRATE);
  for (const c of CANADA_MISSING) {
    assert.ok(!cols.includes(c), `canada must not select ${c}`);
  }
});

test("health's manual column list is completely unchanged", () => {
  const health = legacyDealManualColumns(HEALTH_RUNRATE);
  // No canada extra leaks in — selecting one would throw "Unrecognized name" against health.
  for (const c of CANADA_ONLY) {
    assert.ok(!health.includes(c), `health must not carry ${c}`);
  }
  // And health keeps the columns canada drops.
  for (const c of CANADA_MISSING) {
    assert.ok(health.includes(c), `health should still carry ${c}`);
  }
});

test("an unknown or absent table id yields the plain shared list", () => {
  const base = legacyDealManualColumns(undefined);
  assert.deepEqual(legacyDealManualColumns(HEALTH_RUNRATE), base);
  assert.deepEqual(legacyDealManualColumns(LOCUMS_RUNRATE), base);
  assert.deepEqual(legacyDealManualColumns("some_other_table"), base);
  assert.deepEqual(legacyDealManualColumns(null), base);
});

test("the canada list has no duplicates", () => {
  const cols = legacyDealManualColumns(CANADA_RUNRATE);
  assert.equal(new Set(cols).size, cols.length);
});

test("only the canada run-rate table has overrides registered", () => {
  assert.deepEqual([...RUNRATE_EXTRA_MANUAL_COLUMNS_BY_TABLE.keys()], [CANADA_RUNRATE]);
  assert.deepEqual([...RUNRATE_MANUAL_MISSING_COLUMNS_BY_TABLE.keys()], [CANADA_RUNRATE]);
});

// --------------------------------------------------------------------------
// ENTITY default
// --------------------------------------------------------------------------

test("a blank ENTITY on a canada row takes the default", () => {
  for (const blank of [undefined, null, "", "   "]) {
    const row = { CLIENT_STATE: "BC" };
    if (blank !== undefined) row.ENTITY = blank;
    assert.equal(applyCanadaDefaultEntity(row).ENTITY, CANADA_DEFAULT_ENTITY, String(blank));
  }
});

test("an existing ENTITY always wins over the default", () => {
  // Whether it came from the run-rate row or a hand edit, it must not be overwritten.
  const row = { CLIENT_STATE: "ON", ENTITY: "Some Other Entity" };
  assert.equal(applyCanadaDefaultEntity(row).ENTITY, "Some Other Entity");
});

test("the ENTITY default never touches a non-canada row", () => {
  for (const state of ["TX", "AZ", "CA", null]) {
    const row = { CLIENT_STATE: state };
    const out = applyCanadaDefaultEntity(row);
    assert.equal(out.ENTITY, undefined, String(state));
    assert.equal(out, row, "non-canada rows are returned untouched");
  }
});

test("the ENTITY default does not mutate its input", () => {
  const row = { CLIENT_STATE: "BC" };
  const out = applyCanadaDefaultEntity(row);
  assert.equal(row.ENTITY, undefined, "input row untouched");
  assert.equal(out.ENTITY, CANADA_DEFAULT_ENTITY);
});

test("the ENTITY default tolerates junk input", () => {
  assert.equal(applyCanadaDefaultEntity(null), null);
  assert.equal(applyCanadaDefaultEntity(undefined), undefined);
});

// --------------------------------------------------------------------------
// Ownership / hierarchy flow
//
// Canada follows cynet health exactly: EXTENSION rows inherit hierarchy from the matched run-rate
// row, fresh DEAL rows take it from the directory hierarchy snapshot. The one structural difference
// is that Canada has no AVP role — the chain tops out at VP / Sr. VP.
// --------------------------------------------------------------------------

const {
  resolveExtensionRunrateHierarchyColumns,
  RUNRATE_HIERARCHY_MISSING_COLUMNS_BY_TABLE,
} = require("./bigQueryClient");
const { sanitizeCanadaDealSheetRow } = require("./canadaDerivedPlacementFields");

test("canada's extension hierarchy select omits AVP", () => {
  // all_Health_Canada_Deal_sheet_data has no AVP column, so naming it would fail the query with
  // "Unrecognized name: AVP".
  const cols = resolveExtensionRunrateHierarchyColumns(CANADA_RUNRATE);
  assert.ok(!cols.includes("AVP"));
  assert.ok(cols.includes("VP"), "VP / Sr. VP is the top of the canada chain");
});

test("canada inherits every other hierarchy role like health does", () => {
  const cols = resolveExtensionRunrateHierarchyColumns(CANADA_RUNRATE);
  for (const role of [
    "TEAM_LEAD", "ATL", "RM", "ACCOUNT_MANAGER", "SECONDARY_AM", "ASSOCIATE_AM",
    "ASSOCIATE_DELIVERY_DIRECTOR", "DELIVERY_DIRECTOR", "VP",
  ]) {
    assert.ok(cols.includes(role), role);
  }
});

test("health's hierarchy select still includes AVP", () => {
  const cols = resolveExtensionRunrateHierarchyColumns(HEALTH_RUNRATE);
  assert.ok(cols.includes("AVP"), "health must be unaffected");
  assert.equal(cols.length, 10);
});

test("AVP is registered missing for canada and locums only", () => {
  assert.ok(RUNRATE_HIERARCHY_MISSING_COLUMNS_BY_TABLE.get(CANADA_RUNRATE).has("AVP"));
  assert.ok(RUNRATE_HIERARCHY_MISSING_COLUMNS_BY_TABLE.get(LOCUMS_RUNRATE).has("AVP"));
  assert.equal(RUNRATE_HIERARCHY_MISSING_COLUMNS_BY_TABLE.get(HEALTH_RUNRATE), undefined);
});

test("a canada row never reaches BigQuery carrying AVP", () => {
  // The DEAL hierarchy backfill writes DEAL_RECRUITER_HIERARCHY_FIELDS (AVP included) onto insert
  // rows; the canada sanitizer is the last step before insert and must drop it.
  const out = sanitizeCanadaDealSheetRow({
    CLIENT_STATE: "BC",
    TEAM_LEAD: "TL", TEAM_LEAD_EMP_NO: "E1",
    VP: "VPname", VP_EMP_NO: "E9",
    AVP: "AVPname", AVP_EMP_NO: "E10",
    DELIVERY_DIRECTOR: "DD",
  });
  assert.ok(!Object.prototype.hasOwnProperty.call(out, "AVP"));
  assert.ok(!Object.prototype.hasOwnProperty.call(out, "AVP_EMP_NO"));
  // Everything else survives untouched.
  assert.equal(out.VP, "VPname");
  assert.equal(out.VP_EMP_NO, "E9");
  assert.equal(out.TEAM_LEAD, "TL");
  assert.equal(out.DELIVERY_DIRECTOR, "DD");
});
