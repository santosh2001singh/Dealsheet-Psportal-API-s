const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function extractOfferRejectedHttpBlock(source) {
  const marker = "exports.dealSheetSyncOfferRejected = onRequest(";
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const tail = source.slice(start);
  const nextExport = tail.indexOf("exports.rateChangeLogSyncTrigger");
  return nextExport >= 0 ? tail.slice(0, nextExport) : tail;
}

function extractDealSheetSyncTriggerBlock(source) {
  const marker = "exports.dealSheetSyncTrigger = onSchedule(";
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const tail = source.slice(start);
  const nextExport = tail.indexOf("exports.dealSheetSyncUpdateTrigger");
  return nextExport >= 0 ? tail.slice(0, nextExport) : tail;
}

function extractDealSheetSyncUpdateTriggerBlock(source) {
  const marker = "exports.dealSheetSyncUpdateTrigger = onSchedule(";
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const tail = source.slice(start);
  const nextExport = tail.indexOf("exports.dealSheetSyncOfferRejected");
  return nextExport >= 0 ? tail.slice(0, nextExport) : tail;
}

test("offer-rejected HTTP function uses Firestore pagination and ended routing", () => {
  const filePath = path.join(__dirname, "index.js");
  const source = fs.readFileSync(filePath, "utf8");
  const block = extractOfferRejectedHttpBlock(source);

  assert.notEqual(block, "", "dealSheetSyncOfferRejected HTTP block should exist");
  assert.equal(block.includes("resume_from_checkpoint: resume"), true);
  assert.equal(block.includes("clear_checkpoint_on_complete: true"), true);
  assert.equal(block.includes("OFFER_REJECTED_SYNC_CHECKPOINT_KEY"), true);
  assert.equal(block.includes("use_ended_domain_routing: true"), true);
  assert.equal(block.includes("checkpoint_use_submittal_page: checkpointUseSubmittalPage"), true);
  assert.equal(block.includes("transform_rows_fn: transformOfferRejectedEndedRowsForBigQuery"), true);
  assert.equal(block.includes("append_on_change_by_dealsheet: true"), true);
  assert.equal(block.includes('generated_uuid_field: "ID"'), true);
  assert.equal(block.includes("compare_ignore_fields:"), true);
  assert.equal(block.includes('"DATE_AND_TIME"'), true);
  assert.equal(block.includes("first_insert_placement_status_allowlist: ACTIVE_EXPANDED_FIRST_INSERT_PLACEMENT_STATUSES"), true);
  assert.equal(block.includes("dedupe_by_placement_id: dedupeByPlacementId"), true);
  assert.equal(source.includes("transformOfferRejectedEndedRowsForBigQuery"), true);
  assert.equal(source.includes("./offerRejectedRowTransform"), true);
  const transformSource = fs.readFileSync(
    path.join(__dirname, "offerRejectedRowTransform.js"),
    "utf8"
  );
  assert.equal(transformSource.includes("[offer-rejected-transform]"), true);
  assert.equal(transformSource.includes('status === "DID NOT ACCEPT"'), true);
  assert.equal(transformSource.includes("after_tentative_date_filter"), true);
  assert.equal(transformSource.includes("TENTATIVE_DATE>=2026-05-01 UTC"), true);
  assert.equal(transformSource.includes("after_start_date_filter"), false);
  assert.equal(block.includes('bq_table: "ch_ended_records"'), false);
});

test("dealSheetSyncTrigger applies min START_DATE transform before BigQuery", () => {
  const filePath = path.join(__dirname, "index.js");
  const source = fs.readFileSync(filePath, "utf8");
  const block = extractDealSheetSyncTriggerBlock(source);

  assert.notEqual(block, "", "dealSheetSyncTrigger block should exist");
  assert.equal(
    block.includes("transform_rows_fn: filterEnrichedRowsByDealSheetMinStartDate"),
    true,
    "scheduled insert trigger should filter rows by START_DATE >= 2026-05-01"
  );
});

test("dealSheetSyncTrigger is insert-only and skips existing deal sheet or placement", () => {
  const filePath = path.join(__dirname, "index.js");
  const source = fs.readFileSync(filePath, "utf8");
  const block = extractDealSheetSyncTriggerBlock(source);

  assert.notEqual(block, "", "dealSheetSyncTrigger block should exist");
  assert.equal(block.includes("only_new_deal_sheets: true"), true);
  assert.equal(block.includes("skip_existing_deal_sheet_or_placement: true"), true);
  assert.equal(block.includes("reject_if_existing_deal_sheet_or_placement: true"), true);
  assert.equal(block.includes("append_on_change_by_dealsheet: false"), true);
  assert.equal(block.includes("ACTIVE_BOOTSTRAP_SUBMITTAL_CODES"), true);
  assert.equal(block.includes("first_insert_placement_status_allowlist: firstInsertPlacementStatuses"), true);
  assert.equal(block.includes("resume_from_checkpoint"), false);
  assert.equal(block.includes("max_pages"), false);
});

test("rateChangeLogSyncTrigger uses BigQuery CONTRACT_ID scan (no Nexus pipeline)", () => {
  const filePath = path.join(__dirname, "index.js");
  const source = fs.readFileSync(filePath, "utf8");
  const marker = "exports.rateChangeLogSyncTrigger = onSchedule(";
  const start = source.indexOf(marker);
  assert.ok(start >= 0, "rateChangeLogSyncTrigger block should exist");
  const block = source.slice(start, start + 2500);

  assert.equal(block.includes("syncRateChangeLogsFromBigQuery"), true);
  assert.equal(block.includes("syncRateChangeLogsToBigQuery"), false);
  assert.equal(block.includes("only_new_deal_sheets"), false);
  assert.equal(block.includes("PERM_STARTS,ACTIVE,BOOKED"), false);
  assert.equal(block.includes('bq_table: "ch_rate_change_logs"'), true);
});

function extractRefreshDealSheetByPlacementIdBlock(source) {
  const marker = "exports.refreshDealSheetByPlacementId = onRequest(";
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const tail = source.slice(start);
  const nextExport = tail.indexOf("exports.peoplestrongEmployeeDetailsSyncTrigger");
  return nextExport >= 0 ? tail.slice(0, nextExport) : tail;
}

test("refreshDealSheetByPlacementId uses expanded first-insert placement allowlist only on this HTTP handler", () => {
  const filePath = path.join(__dirname, "index.js");
  const source = fs.readFileSync(filePath, "utf8");
  const block = extractRefreshDealSheetByPlacementIdBlock(source);

  assert.notEqual(block, "", "refreshDealSheetByPlacementId block should exist");
  assert.equal(block.includes("params.first_insert_placement_status_allowlist"), true);
  assert.equal(block.includes("ACTIVE_EXPANDED_FIRST_INSERT_PLACEMENT_STATUSES"), true);
  assert.equal(block.includes("refreshPlacementRecordToBigQuery(params)"), true);
  assert.equal(block.includes("ACTIVE_BOOTSTRAP_FIRST_INSERT_PLACEMENT_STATUSES"), false);
});

test("dealSheetSyncUpdateTrigger uses deal-sheet targets and deal_sheet_id baseline", () => {
  const filePath = path.join(__dirname, "index.js");
  const source = fs.readFileSync(filePath, "utf8");
  const block = extractDealSheetSyncUpdateTriggerBlock(source);

  assert.notEqual(block, "", "dealSheetSyncUpdateTrigger block should exist");
  assert.equal(block.includes('schedule: "30 1,5,9,13,17,21 * * *"'), true);
  assert.equal(block.includes("syncExistingActiveDealSheetUpdatesFromBigQuery"), true);
  assert.equal(block.includes("ACTIVE_UPDATE_SYNC_CHECKPOINT_KEY"), true);
  assert.equal(block.includes("resume_from_checkpoint: true"), true);
  assert.equal(block.includes("max_pairs_per_run: maxPairsPerRun"), true);
});
