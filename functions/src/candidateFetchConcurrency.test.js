const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveCandidateFetchConcurrency } = require("./syncService");

/**
 * deal-sheet-candidates is a THIRD Nexus fan-out path, separate from config.fetchAllMax (enrich
 * waves) and updatePlacementConcurrency (the update trigger's placement loop). Until Sep 2026 it
 * read neither, so every domain fanned out 8 wide here whatever its own pacing said.
 *
 * That is what failed dealSheetSyncTriggerLocums on 2026-09-23: with its START_DATE filter removed
 * the page carried 293 job_ids, 8 went out at a time against an edge already throttling the run,
 * and 7 still failed after retries — enough to throw and pause the whole page:
 *
 *   TIMER_FAIL dealSheetSyncTriggerLocums elapsed=952s
 *   deal-sheet-candidates fetch failed for 7/293 job_id(s) after retries
 *
 * Cynet health never had this problem, so it must keep the historical default untouched.
 */

test("the unfiltered domains fan out below the default", () => {
  assert.equal(resolveCandidateFetchConcurrency("canada"), 5);
  assert.equal(resolveCandidateFetchConcurrency("locums"), 5);
});

test("cynet health keeps the historical default of 8", () => {
  // NOT its fetchAllMax of 10 — raising it would be a behaviour change to a domain that never had
  // the problem this map exists to solve.
  assert.equal(resolveCandidateFetchConcurrency("health"), 8);
});

test("an unknown or absent domain keeps the default too", () => {
  for (const d of [undefined, null, "", "   ", "something_else"]) {
    assert.equal(resolveCandidateFetchConcurrency(d), 8, String(d));
  }
});

test("the domain match is case- and whitespace-insensitive", () => {
  for (const v of ["LOCUMS", "Locums", "  locums  "]) {
    assert.equal(resolveCandidateFetchConcurrency(v), 5, v);
  }
});

test("an explicit env var still wins, for every domain", () => {
  const prev = process.env.DEAL_SHEET_CANDIDATE_FETCH_CONCURRENCY;
  try {
    process.env.DEAL_SHEET_CANDIDATE_FETCH_CONCURRENCY = "3";
    for (const d of ["health", "canada", "locums", undefined]) {
      assert.equal(resolveCandidateFetchConcurrency(d), 3, String(d));
    }
    // ...and the 1..20 clamp still applies.
    process.env.DEAL_SHEET_CANDIDATE_FETCH_CONCURRENCY = "999";
    assert.equal(resolveCandidateFetchConcurrency("locums"), 20);
    process.env.DEAL_SHEET_CANDIDATE_FETCH_CONCURRENCY = "0";
    assert.equal(resolveCandidateFetchConcurrency("locums"), 5, "a bad value falls through, not to 0");
  } finally {
    if (prev === undefined) delete process.env.DEAL_SHEET_CANDIDATE_FETCH_CONCURRENCY;
    else process.env.DEAL_SHEET_CANDIDATE_FETCH_CONCURRENCY = prev;
  }
});

test("every domain stays inside the 1..20 socket-safety clamp", () => {
  for (const d of ["health", "canada", "locums", undefined]) {
    const n = resolveCandidateFetchConcurrency(d);
    assert.ok(n >= 1 && n <= 20, `${d}: ${n}`);
  }
});
