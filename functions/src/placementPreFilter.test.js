const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * PLACEMENT_ID pre-filter, applied BEFORE the deal-sheet-candidates fetch.
 *
 * The skip-existing filter keys on `deal_sheet`, which only /api/deal-sheet-candidates/ supplies —
 * so a full-history scan fetched the whole page just to find most of it already in BigQuery. On
 * locums listPage=13 that was 298 job_ids fetched in 58s to keep 49 (264 skipped as existing).
 *
 * The submittal row already carries the placement id, so a job whose every submittal is an
 * already-synced placement can be dropped before any fetch. The rule must only ever remove work the
 * later filter would have discarded anyway — anything uncertain is kept and fetched.
 */

/** The decision rule, mirrored from syncService.js. */
function shouldFetchJob(placementIds, knownExistingPlacementIds) {
  if (!placementIds || placementIds.size === 0) return true;
  for (const pid of placementIds) {
    if (pid === "" || !knownExistingPlacementIds.has(pid)) return true;
  }
  return false;
}

const KNOWN = new Set(["100", "101", "102"]);

test("a job whose every placement is already synced is not fetched", () => {
  assert.equal(shouldFetchJob(new Set(["100", "101"]), KNOWN), false);
  assert.equal(shouldFetchJob(new Set(["100"]), KNOWN), false);
});

test("one unknown placement keeps the whole job", () => {
  // The job's other submittals still need enriching, so the job must be fetched.
  assert.equal(shouldFetchJob(new Set(["100", "999"]), KNOWN), true);
  assert.equal(shouldFetchJob(new Set(["999"]), KNOWN), true);
});

test("a blank placement id is treated as unknown, never as existing", () => {
  // A submittal with no placement id cannot be judged, so it must not cause a skip.
  assert.equal(shouldFetchJob(new Set([""]), KNOWN), true);
  assert.equal(shouldFetchJob(new Set(["100", ""]), KNOWN), true);
});

test("a job with no submittals at all is fetched", () => {
  assert.equal(shouldFetchJob(new Set(), KNOWN), true);
  assert.equal(shouldFetchJob(undefined, KNOWN), true);
  assert.equal(shouldFetchJob(null, KNOWN), true);
});

test("nothing known yet means nothing is skipped", () => {
  // First run against an empty table: every job must still be fetched.
  const empty = new Set();
  for (const pids of [new Set(["100"]), new Set(["100", "101"]), new Set([""])]) {
    assert.equal(shouldFetchJob(pids, empty), true);
  }
});

// --------------------------------------------------------------------------
// Wiring: the pre-filter must feed the fetch AND the loop that consumes it, and must not disturb
// the DEAL_SHEET_ID dedupe that runs afterwards.
// --------------------------------------------------------------------------

const SRC = fs.readFileSync(path.join(__dirname, "syncService.js"), "utf8");

test("the fetch and the consuming loop use the same reduced list", () => {
  // Fetching a reduced list while looping over the full one would silently drop rows.
  assert.ok(SRC.includes("const candidatesByJobId = await fetchDealSheetCandidatesByJobIdsParallel(\n        jobIdsToFetch,"));
  assert.ok(SRC.includes("for (const jobId of jobIdsToFetch) {"));
});

test("the pre-filter only runs when skip-existing is on", () => {
  assert.ok(SRC.includes("if (skipExistingDealSheetOrPlacement && uniqueJobIds.length > 0) {"));
  // ...and defaults to the full list otherwise.
  assert.ok(SRC.includes("let jobIdsToFetch = uniqueJobIds;"));
});

test("the DEAL_SHEET_ID dedupe still runs on what is fetched", () => {
  // The pre-filter narrows the fetch; it does not replace the filter below it.
  assert.ok(SRC.includes("if (dsKey !== \"\" && knownExistingDealSheetIds.has(dsKey)) {"));
  assert.ok(SRC.includes("skippedExistingDealSheet++"));
});

test("the pre-filter reuses the same existing-placement lookups as the filter below", () => {
  // Same source of truth, so the two can never disagree about what 'already synced' means.
  const preFilterBlock = SRC.slice(
    SRC.indexOf("PRE-FILTER (PLACEMENT_ID, before fetch)") - 3000,
    SRC.indexOf("PRE-FILTER (PLACEMENT_ID, before fetch)")
  );
  assert.ok(preFilterBlock.includes("fetchExistingPlacementIdsSet("));
  assert.ok(preFilterBlock.includes("fetchExistingPlacementIdsSetAnyActiveTable("));
});
