const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { splitActiveDealSheetUpdateTargetsByPlacementStatus } = require("./syncService");

function target(id, status) {
  return {
    deal_sheet_id: String(id),
    placement_id: String(id),
    table_id: "cynet_health_deal_sheet",
    placement_status: status,
  };
}

test("splitActiveDealSheetUpdateTargetsByPlacementStatus: STARTED BOOKED ACTIVE go to priority", () => {
  const targets = [
    target(1, "STARTED"),
    target(2, "BOOKED"),
    target(3, "ACTIVE"),
    target(4, "started"),
    target(5, "ENDED"),
  ];
  const { priorityTargets, batchTargets } = splitActiveDealSheetUpdateTargetsByPlacementStatus(targets);
  assert.equal(priorityTargets.length, 4);
  assert.deepEqual(
    priorityTargets.map((t) => t.deal_sheet_id),
    ["1", "2", "3", "4"]
  );
  assert.equal(batchTargets.length, 1);
  assert.equal(batchTargets[0].deal_sheet_id, "5");
});

test("splitActiveDealSheetUpdateTargetsByPlacementStatus: ended family goes to batch", () => {
  const targets = [
    target(1, "ENDED"),
    target(2, "ENDED<30"),
    target(3, "DID NOT START"),
    target(4, "DID NOT ACCEPT"),
  ];
  const { priorityTargets, batchTargets } = splitActiveDealSheetUpdateTargetsByPlacementStatus(targets);
  assert.equal(priorityTargets.length, 0);
  assert.equal(batchTargets.length, 4);
});

test("splitActiveDealSheetUpdateTargetsByPlacementStatus: CANCELLED and null go to batch", () => {
  const targets = [target(1, "CANCELLED"), target(2, null), target(3, "")];
  const { priorityTargets, batchTargets } = splitActiveDealSheetUpdateTargetsByPlacementStatus(targets);
  assert.equal(priorityTargets.length, 0);
  assert.equal(batchTargets.length, 3);
});

test("splitActiveDealSheetUpdateTargetsByPlacementStatus: preserves relative order within tiers", () => {
  const targets = [
    target(10, "ENDED"),
    target(11, "STARTED"),
    target(12, "BOOKED"),
    target(13, "ENDED<30"),
    target(14, "ACTIVE"),
  ];
  const { priorityTargets, batchTargets } = splitActiveDealSheetUpdateTargetsByPlacementStatus(targets);
  assert.deepEqual(
    priorityTargets.map((t) => t.deal_sheet_id),
    ["11", "12", "14"]
  );
  assert.deepEqual(
    batchTargets.map((t) => t.deal_sheet_id),
    ["10", "13"]
  );
});

test("slice composition: priority all plus batch slice capped by maxPairsPerRun", () => {
  const targets = [
    target(1, "STARTED"),
    target(2, "BOOKED"),
    target(3, "ENDED"),
    target(4, "ENDED<30"),
    target(5, "DID NOT START"),
  ];
  const { priorityTargets, batchTargets } = splitActiveDealSheetUpdateTargetsByPlacementStatus(targets);
  const maxPairsPerRun = 2;
  const batchOffset = 0;
  const batchSlice = batchTargets.slice(batchOffset, batchOffset + maxPairsPerRun);
  const slice = [...priorityTargets, ...batchSlice];
  assert.equal(priorityTargets.length, 2);
  assert.equal(batchSlice.length, 2);
  assert.equal(slice.length, 4);
  assert.deepEqual(
    slice.map((t) => t.deal_sheet_id),
    ["1", "2", "3", "4"]
  );
});

test("syncExistingActiveDealSheetUpdatesFromBigQuery uses batchOffset and batchTotal checkpoint", () => {
  const source = fs.readFileSync(path.join(__dirname, "syncService.js"), "utf8");
  const fnStart = source.indexOf("async function syncExistingActiveDealSheetUpdatesFromBigQuery");
  assert.ok(fnStart >= 0);
  const fnBody = source.slice(fnStart, fnStart + 6000);
  assert.equal(fnBody.includes("splitActiveDealSheetUpdateTargetsByPlacementStatus"), true);
  assert.equal(fnBody.includes("batchOffset"), true);
  assert.equal(fnBody.includes("batchTotal"), true);
  assert.equal(fnBody.includes("const slice = [...priorityTargets, ...batchSlice]"), true);
});
