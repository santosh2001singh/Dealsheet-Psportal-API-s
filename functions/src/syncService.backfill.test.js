const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  normalizeBulkPlacementIds,
  resolveBulkBackfillMaxPlacementIds,
  bulkBackfillPlacementRecordsFromNexus,
} = require("./syncService");

test("normalizeBulkPlacementIds trims, drops empty, and dedupes", () => {
  assert.deepEqual(normalizeBulkPlacementIds([" 1 ", "2", "1", "", null, "2"]), ["1", "2"]);
  assert.deepEqual(normalizeBulkPlacementIds(null), []);
});

test("resolveBulkBackfillMaxPlacementIds defaults to 200", () => {
  const prev = process.env.BULK_BACKFILL_MAX_PLACEMENT_IDS;
  delete process.env.BULK_BACKFILL_MAX_PLACEMENT_IDS;
  try {
    assert.equal(resolveBulkBackfillMaxPlacementIds(), 200);
  } finally {
    if (prev != null) process.env.BULK_BACKFILL_MAX_PLACEMENT_IDS = prev;
  }
});

test("resolveBulkBackfillMaxPlacementIds reads env override", () => {
  const prev = process.env.BULK_BACKFILL_MAX_PLACEMENT_IDS;
  process.env.BULK_BACKFILL_MAX_PLACEMENT_IDS = "50";
  try {
    assert.equal(resolveBulkBackfillMaxPlacementIds(), 50);
  } finally {
    if (prev == null) delete process.env.BULK_BACKFILL_MAX_PLACEMENT_IDS;
    else process.env.BULK_BACKFILL_MAX_PLACEMENT_IDS = prev;
  }
});

test("bulkBackfillPlacementRecordsFromNexus rejects empty placement_ids", async () => {
  const result = await bulkBackfillPlacementRecordsFromNexus({ placement_ids: [] });
  assert.equal(result._badRequest, true);
  assert.match(result.error, /at least one id/i);
});

test("bulkBackfillPlacementRecordsFromNexus rejects over max cap", async () => {
  const prev = process.env.BULK_BACKFILL_MAX_PLACEMENT_IDS;
  process.env.BULK_BACKFILL_MAX_PLACEMENT_IDS = "2";
  try {
    const result = await bulkBackfillPlacementRecordsFromNexus({
      placement_ids: ["1", "2", "3"],
    });
    assert.equal(result._badRequest, true);
    assert.match(result.error, /max per request is 2/);
  } finally {
    if (prev == null) delete process.env.BULK_BACKFILL_MAX_PLACEMENT_IDS;
    else process.env.BULK_BACKFILL_MAX_PLACEMENT_IDS = prev;
  }
});

test("backfillPlacementRecordFromNexus uses Nexus enrich without BQ baseline compare", () => {
  const source = fs.readFileSync(path.join(__dirname, "syncService.js"), "utf8");
  const fnStart = source.indexOf("async function backfillPlacementRecordFromNexus");
  assert.ok(fnStart >= 0, "backfillPlacementRecordFromNexus should exist");
  const fnEnd = source.indexOf("async function bulkBackfillPlacementRecordsFromNexus", fnStart);
  const block = source.slice(fnStart, fnEnd);
  assert.equal(block.includes("fetchLatestRowsByDealSheetPlacementPairs"), false);
  assert.equal(block.includes("hasBusinessColumnChanges"), false);
  assert.equal(block.includes("fetchTerminationDetails: true"), true);
  assert.equal(block.includes("skip_contract_id: true"), true);
  assert.equal(block.includes("appendOnChangeByDealSheet: false"), true);
  assert.equal(block.includes("writeAdditionalCostLogRows"), true);
  assert.equal(block.includes("writeTerminationReasonLogRows"), true);
});

test("bulkBackfillByPlacementId HTTP handler is exported in index.js", () => {
  const source = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  assert.equal(source.includes("exports.bulkBackfillByPlacementId = onRequest("), true);
  assert.equal(source.includes("bulkBackfillPlacementRecordsFromNexus(params)"), true);
  assert.equal(source.includes("placement_ids"), true);
});
