const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("fetchActiveDealSheetUpdateTargets partitions by DEAL_SHEET_ID with placement fallback", () => {
  const source = fs.readFileSync(path.join(__dirname, "bigQueryClient.js"), "utf8");
  const fnStart = source.indexOf("async function fetchActiveDealSheetUpdateTargets");
  assert.ok(fnStart >= 0, "fetchActiveDealSheetUpdateTargets should exist");
  const fnBody = source.slice(fnStart, fnStart + 3500);
  assert.equal(fnBody.includes("PARTITION BY CAST(DEAL_SHEET_ID AS STRING)"), true);
  assert.equal(fnBody.includes("DEAL_SHEET_ID IS NULL AND PLACEMENT_ID IS NOT NULL"), true);
  assert.equal(fnBody.includes("PARTITION BY CAST(PLACEMENT_ID AS STRING)"), true);
  assert.equal(fnBody.includes("deal_sheet_id: null"), true);
});

test("fetchActiveDealSheetUpdateTargets is exported", () => {
  const { fetchActiveDealSheetUpdateTargets } = require("./bigQueryClient");
  assert.equal(typeof fetchActiveDealSheetUpdateTargets, "function");
});

test("fetchExistingPlacementIdsSet is exported", () => {
  const { fetchExistingPlacementIdsSet } = require("./bigQueryClient");
  assert.equal(typeof fetchExistingPlacementIdsSet, "function");
});
