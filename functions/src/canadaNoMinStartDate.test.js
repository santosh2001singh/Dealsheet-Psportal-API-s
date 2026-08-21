const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * index.js wires the scheduled triggers to firebase-functions at require time, so these assertions
 * read the source rather than importing it. The three layers of the START_DATE lower bound must all
 * sit behind the same `useMinStartDate` guard, and Canada must be the only exempt domain.
 */
const SRC = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");

test("canada is the only domain exempt from the min start date", () => {
  const m = /const SYNC_DOMAINS_WITHOUT_MIN_START_DATE = new Set\(\[([^\]]*)\]\)/.exec(SRC);
  assert.ok(m, "SYNC_DOMAINS_WITHOUT_MIN_START_DATE must exist");
  const domains = m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  assert.deepEqual(domains, ["canada"], "health and locums must keep the bound");
});

test("the min-start-date constants are unchanged (health still starts 2026-01-01)", () => {
  assert.ok(
    /const DEAL_SHEET_MIN_START_DATE_MS = Date\.UTC\(2026, 0, 1\)/.test(SRC),
    "health's 2026-01-01 lower bound must not move"
  );
});

test("all three filter layers sit behind the useMinStartDate guard", () => {
  // 1. the Nexus list's server-side bound, 2. the post-enrich row filter, 3. the insert-pipeline gate
  for (const layer of [
    "submittal_start_date_from: DEAL_SHEET_MIN_START_DATE_ISO",
    "transform_rows_fn: filterEnrichedRowsByDealSheetMinStartDate",
    "min_start_date_ms: DEAL_SHEET_MIN_START_DATE_MS",
  ]) {
    assert.ok(SRC.includes(layer), `${layer} should still be present`);
  }
  // The insert trigger spreads all three together, only when the domain uses the bound.
  const insertGuard = /\.\.\.\(useMinStartDate\s*\?\s*\{\s*submittal_start_date_from: DEAL_SHEET_MIN_START_DATE_ISO,\s*transform_rows_fn: filterEnrichedRowsByDealSheetMinStartDate,[\s\S]*?min_start_date_ms: DEAL_SHEET_MIN_START_DATE_MS,\s*\}\s*:\s*\{\}\)/;
  assert.ok(insertGuard.test(SRC), "insert trigger must gate all three layers on useMinStartDate");
});

test("the update trigger gates its min_start_date_ms too", () => {
  const updateGuard = /\.\.\.\(useMinStartDate \? \{ min_start_date_ms: DEAL_SHEET_MIN_START_DATE_MS \} : \{\}\)/;
  assert.ok(updateGuard.test(SRC), "update trigger must gate min_start_date_ms on useMinStartDate");
});

test("both scheduled trigger bodies resolve useMinStartDate from their domain", () => {
  const matches = SRC.match(/const useMinStartDate = domainUsesDealSheetMinStartDate\(domain\);/g);
  assert.equal(matches?.length, 2, "insert and update trigger bodies both need it");
});

test("the HTTP manual sync keeps its own unconditional filter", () => {
  // dealSheetSync is driven by explicit query params, not by sync_domain, so it is deliberately
  // untouched — a caller who wants canada's full history uses the scheduled trigger.
  assert.ok(SRC.includes("params.min_start_date_ms = DEAL_SHEET_MIN_START_DATE_MS;"));
});

// --------------------------------------------------------------------------
// The pipeline side: an absent bound must mean "no filter", never a default.
// --------------------------------------------------------------------------

test("syncService treats an absent min_start_date_ms as no filter", () => {
  const svc = fs.readFileSync(path.join(__dirname, "syncService.js"), "utf8");
  // Both readers coerce a missing/blank param to null rather than substituting a date.
  // Three readers: the row-level gate, the insert-pipeline gate, and the update sync.
  const readers = svc.match(
    /params\.min_start_date_ms != null && Number\.isFinite\(Number\(params\.min_start_date_ms\)\)\s*\n?\s*\?\s*Number\(params\.min_start_date_ms\)\s*\n?\s*:\s*null/g
  );
  assert.equal(readers?.length, 3, "every reader defaults to null, never to a date");
  // And the row gate only runs when a bound was actually supplied.
  assert.ok(
    svc.includes("if (minStartDateMs != null && !startDateOnOrAfterUtcMin("),
    "row filter must be skipped entirely when no bound is set"
  );
});

test("an absent submittal_start_date_from is omitted from the Nexus query", () => {
  const svc = fs.readFileSync(path.join(__dirname, "syncService.js"), "utf8");
  const spreads = svc.match(
    /\.\.\.\(submittalStartDateFrom \? \{ start_date_from: submittalStartDateFrom \} : \{\}\)/g
  );
  assert.ok(spreads && spreads.length >= 2, "start_date_from must be spread conditionally");
});
