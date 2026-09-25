const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { mapDealSheetRatesListToBq } = require("./columnMappings");

/**
 * Client-side (BR_*) rate fallback from /api/job-rates/, for LOCUMS only.
 *
 * A locums deal sheet routinely lists only a few of its rates. Deal sheet 5161506 carried six —
 * none of them BR_GREATER_THAN_FOURTY or BR_HOLIDAY_RATE — while /api/job-rates/ for the same job
 * (35387277) had 338 and 390, the figures the run-rate row shows. Without them CLIENT_OT_RATE and
 * CLIENT_HOLIDAY_RATE land null, and GM_OT (which divides by CLIENT_OT_RATE) never computes.
 *
 * Rules the fallback must keep:
 *   * fill-if-absent, never overwrite — a rate the deal sheet states is the agreed one for THIS
 *     placement; the job's is only the posting's default;
 *   * BR_* only — job-rates carries no pay-side codes at all;
 *   * locums only — passing no job rates must behave exactly as before.
 */

// The live payloads, verbatim.
const DEAL_SHEET_RATES = [
  { bill_rate_code: "PR_REGULAR_PAY_RATE", rate: 0 },
  { bill_rate_code: "BR_REGULAR_BILL_RATE", rate: 260 },
  { bill_rate_code: "PR_CALL_BACK_RATE", rate: 0 },
  { bill_rate_code: "BR_CALL_BACK_RATE", rate: 0 },
  { bill_rate_code: "PR_ON_CALL_RATE", rate: 0 },
  { bill_rate_code: "BR_ON_CALL_RATE", rate: 0 },
];
const JOB_RATES = [
  { bill_rate_code: "BR_REGULAR_BILL_RATE", rate: 260 },
  { bill_rate_code: "BR_GREATER_THAN_FOURTY", rate: 338 },
  { bill_rate_code: "BR_HOLIDAY_RATE", rate: 390 },
  { bill_rate_code: "BR_CALL_BACK_RATE", rate: 338 },
];

test("absent client codes are filled from the job", () => {
  const out = mapDealSheetRatesListToBq(DEAL_SHEET_RATES, "OR", JOB_RATES);
  assert.equal(out.CLIENT_OT_RATE, 338, "BR_GREATER_THAN_FOURTY");
  assert.equal(out.CLIENT_HOLIDAY_RATE, 390, "BR_HOLIDAY_RATE");
});

test("a rate the deal sheet states is never overwritten, not even a zero", () => {
  // BR_CALL_BACK_RATE is 0 on the deal sheet and 338 on the job. The deal sheet wins: 0 is a stated
  // rate for this placement, not a missing one.
  const out = mapDealSheetRatesListToBq(DEAL_SHEET_RATES, "OR", JOB_RATES);
  assert.equal(out.CLIENT_CALL_BACK_RATE, 0);
  assert.equal(out.BILL_RATE, 260);
});

test("pay-side codes are untouched by the fallback", () => {
  const withPay = [...JOB_RATES, { bill_rate_code: "PR_REGULAR_PAY_RATE", rate: 999 }];
  const out = mapDealSheetRatesListToBq(DEAL_SHEET_RATES, "OR", withPay);
  assert.equal(out.PAY_RATE, 0, "PR_* must never come from the job");
  assert.equal(out.OT_RATE, null);
  assert.equal(out.HOLIDAY_RATE, null);
});

test("passing no job rates behaves exactly as before", () => {
  const before = mapDealSheetRatesListToBq(DEAL_SHEET_RATES, "OR");
  assert.deepEqual(mapDealSheetRatesListToBq(DEAL_SHEET_RATES, "OR", null), before);
  assert.deepEqual(mapDealSheetRatesListToBq(DEAL_SHEET_RATES, "OR", []), before);
  assert.equal(before.CLIENT_OT_RATE, null, "unfilled without the fallback");
});

test("the CA/AK eight-hour OT code is filled from the job too", () => {
  // Those states read BR_GREATER_THAN_EIGHT instead.
  const out = mapDealSheetRatesListToBq(
    DEAL_SHEET_RATES,
    "CA",
    [{ bill_rate_code: "BR_GREATER_THAN_EIGHT", rate: 400 }]
  );
  assert.equal(out.CLIENT_OT_RATE, 400);
});

test("job rates alone still produce a row", () => {
  // An empty deal-sheet list used to short-circuit to {}.
  const out = mapDealSheetRatesListToBq([], "OR", JOB_RATES);
  assert.equal(out.CLIENT_OT_RATE, 338);
  assert.equal(out.PAY_RATE, null);
});

test("both lists empty still returns nothing", () => {
  assert.deepEqual(mapDealSheetRatesListToBq([], "OR", []), {});
  assert.deepEqual(mapDealSheetRatesListToBq(null, "OR", null), {});
});

// --------------------------------------------------------------------------
// Locums-only: cynet health must not gain a request per job.
// --------------------------------------------------------------------------

const ENRICHER_SRC = fs.readFileSync(path.join(__dirname, "api", "dealSheetEnricher.js"), "utf8");
const SYNC_SRC = fs.readFileSync(path.join(__dirname, "syncService.js"), "utf8");

test("job rates are fetched only when the sync domain is locums", () => {
  assert.ok(
    ENRICHER_SRC.includes(
      'const fetchLocumsJobRates = String(options?.syncDomain ?? "").trim().toLowerCase() === "locums";'
    )
  );
  assert.ok(ENRICHER_SRC.includes("if (fetchLocumsJobRates) {"), "the wave1 URLs are gated");
});

test("every other domain passes null job rates to the mapper", () => {
  assert.ok(
    ENRICHER_SRC.includes("const jobRatesList = fetchLocumsJobRates && jobId != null")
  );
});

test("the sync passes its domain through to the enricher", () => {
  assert.ok(SYNC_SRC.includes("// Locums alone fetches job rates, to fill the client-side codes its deal sheets omit.\n        syncDomain,"));
});
