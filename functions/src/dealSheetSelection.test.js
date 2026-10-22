const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  pickPreferredDealSheetCandidate,
  selectOneDealSheetPerJobCandidate,
  resolveStoredDealSheetSelection,
} = require("./dealSheetSelection");
const { buildStoredDealSheetIdsByPlacement } = require("./syncService");

const SYNC_SRC = fs.readFileSync(path.join(__dirname, "syncService.js"), "utf8");

// Live Nexus /api/deal-sheet-candidates/ rows (2026-10-20).
function ds(deal_sheet, type, deal_sheet_status, created_date, job = 35523230, candidate = 31230671) {
  return { deal_sheet, type, deal_sheet_status, created_date, job, candidate };
}

// Placement 1465579 (Amy Freeman): PRIMARY FINAL 5253880 + SECONDARY VERBAL 5253886, both inserted.
const AMY_PRIMARY = ds(5253880, "PRIMARY", "FINAL", "2026-08-05T17:07:49Z");
const AMY_SECONDARY = ds(5253886, "SECONDARY", "VERBAL", "2026-08-05T17:13:26Z");

test("PRIMARY wins over a newer SECONDARY", () => {
  assert.equal(pickPreferredDealSheetCandidate([AMY_SECONDARY, AMY_PRIMARY]), AMY_PRIMARY);
});

test("PRIMARY wins even when it is the older VERBAL (placement 1448637)", () => {
  const primary = ds(5171341, "PRIMARY", "VERBAL", "2026-02-19T19:07:08Z", 35288672, 31144989);
  const secondary = ds(5174261, "SECONDARY", "VERBAL", "2026-02-24T20:25:36Z", 35288672, 31144989);
  assert.equal(pickPreferredDealSheetCandidate([secondary, primary]), primary);
});

test("both PRIMARY: FINAL wins over a newer VERBAL (placement 1443009)", () => {
  const finalDs = ds(5146646, "PRIMARY", "FINAL", "2026-01-14T15:22:30Z", 35329047, 8230731);
  const verbalDs = ds(5199010, "PRIMARY", "VERBAL", "2026-04-07T21:08:44Z", 35329047, 8230731);
  assert.equal(pickPreferredDealSheetCandidate([verbalDs, finalDs]), finalDs);
});

test("same type and status: newest created wins", () => {
  const older = ds(1, "PRIMARY", "FINAL", "2026-01-01T00:00:00Z");
  const newer = ds(2, "PRIMARY", "FINAL", "2026-02-01T00:00:00Z");
  assert.equal(pickPreferredDealSheetCandidate([older, newer]), newer);
});

test("insert: one deal sheet per job + candidate, other placements untouched", () => {
  const other = ds(5274477, "PRIMARY", "FINAL", "2026-09-29T21:28:11Z", 35572117, 23836273);
  const sameJobOtherCandidate = ds(5253933, "PRIMARY", "VERBAL", "2026-08-05T18:04:30Z", 35523230, 31687614);
  const { kept, dropped } = selectOneDealSheetPerJobCandidate([
    AMY_SECONDARY,
    other,
    AMY_PRIMARY,
    sameJobOtherCandidate,
  ]);
  assert.deepEqual(kept, [other, AMY_PRIMARY, sameJobOtherCandidate]);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].row, AMY_SECONDARY);
  assert.equal(dropped[0].winner, AMY_PRIMARY);
});

test("insert path applies the selection for placement-keyed (health) syncs only", () => {
  assert.match(
    SYNC_SRC,
    /if \(dedupeExistingByPlacementOnly && filteredCandidates\.length > 1\) \{\s*const \{ kept, dropped \} = selectOneDealSheetPerJobCandidate\(filteredCandidates\);/
  );
});

test("update: the non-selected stored deal sheet is skipped, the selected one refreshes", () => {
  const rows = [AMY_PRIMARY, AMY_SECONDARY];
  const stored = ["5253880", "5253886"];
  assert.deepEqual(
    resolveStoredDealSheetSelection({ candidateRows: rows, candidateId: 31230671, dealSheetId: "5253886", storedDealSheetIds: stored }),
    { selected: false, winnerDealSheetId: "5253880" }
  );
  assert.deepEqual(
    resolveStoredDealSheetSelection({ candidateRows: rows, candidateId: 31230671, dealSheetId: "5253880", storedDealSheetIds: stored }),
    { selected: true, winnerDealSheetId: "5253880" }
  );
});

test("update: a single stored deal sheet is always refreshed", () => {
  assert.deepEqual(
    resolveStoredDealSheetSelection({
      candidateRows: [AMY_PRIMARY, AMY_SECONDARY],
      candidateId: 31230671,
      dealSheetId: "5253886",
      storedDealSheetIds: ["5253886"],
    }),
    { selected: true, winnerDealSheetId: null }
  );
});

test("update: a stored deal sheet Nexus no longer lists loses to one it does (placement 1464301)", () => {
  const listed = ds(5248292, "PRIMARY", "VERBAL", "2026-07-22T20:45:14Z", 35516143, 25894642);
  assert.deepEqual(
    resolveStoredDealSheetSelection({
      candidateRows: [listed],
      candidateId: 25894642,
      dealSheetId: "5248308",
      storedDealSheetIds: ["5248292", "5248308"],
    }),
    { selected: false, winnerDealSheetId: "5248292" }
  );
});

test("update: no stored deal sheet listed in Nexus -> refresh as before", () => {
  assert.deepEqual(
    resolveStoredDealSheetSelection({
      candidateRows: [],
      candidateId: 31230671,
      dealSheetId: "5253886",
      storedDealSheetIds: ["5253880", "5253886"],
    }),
    { selected: true, winnerDealSheetId: null }
  );
});

test("update targets: only health placements with several deal sheets are mapped", () => {
  const map = buildStoredDealSheetIdsByPlacement([
    { table_id: "cynet_health_deal_sheet", placement_id: "1465579", deal_sheet_id: "5253880" },
    { table_id: "cynet_health_deal_sheet", placement_id: "1465579", deal_sheet_id: "5253886" },
    { table_id: "cynet_health_deal_sheet", placement_id: "1470015", deal_sheet_id: "5274477" },
    { table_id: "cynet_health_deal_sheet", placement_id: "1470015", deal_sheet_id: null },
    { table_id: "cynet_health_canada_deal_sheet", placement_id: "9", deal_sheet_id: "1" },
    { table_id: "cynet_health_canada_deal_sheet", placement_id: "9", deal_sheet_id: "2" },
  ]);
  assert.deepEqual(Array.from(map.entries()), [["cynet_health_deal_sheet|1465579", ["5253880", "5253886"]]]);
});
