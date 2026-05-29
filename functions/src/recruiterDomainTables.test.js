const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveActiveDealSheetTableId,
  buildActiveDealSheetRoutingSentinel,
  ACTIVE_DEAL_SHEET_TABLE_IDS,
  TABLE_CYNET_HEALTH,
  TABLE_CYNET_HEALTH_CANADA,
  TABLE_CYNET_LOCUMS,
  resolveEndedDealSheetTableId,
  buildEndedDealSheetRoutingSentinel,
  ENDED_DEAL_SHEET_TABLE_IDS,
  TABLE_ENDED_CYNET_HEALTH,
  TABLE_ENDED_CYNET_HEALTH_CANADA,
  TABLE_ENDED_CYNET_LOCUMS,
} = require("./recruiterDomainTables");

test("resolveActiveDealSheetTableId maps cynethealth.ca", () => {
  assert.equal(resolveActiveDealSheetTableId("Recruiter@CynetHealth.CA"), TABLE_CYNET_HEALTH_CANADA);
});

test("resolveActiveDealSheetTableId maps cynethealth.com", () => {
  assert.equal(resolveActiveDealSheetTableId("a@cynethealth.com"), TABLE_CYNET_HEALTH);
});

test("resolveActiveDealSheetTableId maps cynetlocums.com", () => {
  assert.equal(resolveActiveDealSheetTableId("x@CYNETLOCUMS.COM"), TABLE_CYNET_LOCUMS);
});

test("resolveActiveDealSheetTableId defaults to cynet_health_deal_sheet", () => {
  assert.equal(resolveActiveDealSheetTableId(""), TABLE_CYNET_HEALTH);
  assert.equal(resolveActiveDealSheetTableId(null), TABLE_CYNET_HEALTH);
  assert.equal(resolveActiveDealSheetTableId("other@example.com"), TABLE_CYNET_HEALTH);
});

test("ACTIVE_DEAL_SHEET_TABLE_IDS lists three tables", () => {
  assert.deepEqual(new Set(ACTIVE_DEAL_SHEET_TABLE_IDS), new Set([
    TABLE_CYNET_HEALTH,
    TABLE_CYNET_HEALTH_CANADA,
    TABLE_CYNET_LOCUMS,
  ]));
});

test("buildActiveDealSheetRoutingSentinel is stable", () => {
  assert.equal(
    buildActiveDealSheetRoutingSentinel("cynetdatabase", "rr_project_data"),
    "cynetdatabase.rr_project_data:ACTIVE_DOMAIN_ROUTED"
  );
});

test("resolveEndedDealSheetTableId maps cynethealth.ca", () => {
  assert.equal(resolveEndedDealSheetTableId("x@Cynethealth.CA"), TABLE_ENDED_CYNET_HEALTH_CANADA);
});

test("resolveEndedDealSheetTableId maps cynethealth.com", () => {
  assert.equal(resolveEndedDealSheetTableId("a@cynethealth.com"), TABLE_ENDED_CYNET_HEALTH);
});

test("resolveEndedDealSheetTableId maps cynetlocums.com", () => {
  assert.equal(resolveEndedDealSheetTableId("z@cynetlocums.com"), TABLE_ENDED_CYNET_LOCUMS);
});

test("resolveEndedDealSheetTableId defaults to cynet_health_ended_deal_sheet", () => {
  assert.equal(resolveEndedDealSheetTableId(""), TABLE_ENDED_CYNET_HEALTH);
  assert.equal(resolveEndedDealSheetTableId("other@foo.com"), TABLE_ENDED_CYNET_HEALTH);
});

test("ENDED_DEAL_SHEET_TABLE_IDS lists three tables", () => {
  assert.deepEqual(new Set(ENDED_DEAL_SHEET_TABLE_IDS), new Set([
    TABLE_ENDED_CYNET_HEALTH,
    TABLE_ENDED_CYNET_HEALTH_CANADA,
    TABLE_ENDED_CYNET_LOCUMS,
  ]));
});

test("buildEndedDealSheetRoutingSentinel is stable", () => {
  assert.equal(
    buildEndedDealSheetRoutingSentinel("cynetdatabase", "rr_project_data"),
    "cynetdatabase.rr_project_data:ENDED_DOMAIN_ROUTED"
  );
});
