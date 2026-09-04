const test = require("node:test");
const assert = require("node:assert/strict");

const { computeBqEndDateFromSubmittal, mapJobSubmittalToBq } = require("./columnMappings");

// Business rule:
//  TENTATIVE_END_DATE = submittal.end_date (planned/tentative end), job.end_date as fallback only
//  END_DATE       = submittal.end_date (ACTUAL end) — ONLY once the placement has ENDED / ENDED<30.
//  STARTED/BOOKED/ACTIVE -> END_DATE null (not ended yet). DID NOT ACCEPT/START -> end = start.
const JOB = { start_date: "2026-06-22", end_date: "2026-09-19" };
const withStatus = (code, over = {}) => ({
  start_date: "2026-06-22",
  end_date: "2026-07-06",
  organization_submittal_status: { code },
  ...over,
});

test("END_DATE for EARLY_TERM = submittal end_date (actual early-term date, not the job planned end)", () => {
  assert.equal(computeBqEndDateFromSubmittal(withStatus("EARLY_TERM"), JOB), "2026-07-06");
});

test("END_DATE for COMPLETED = submittal end_date", () => {
  assert.equal(computeBqEndDateFromSubmittal(withStatus("COMPLETED"), JOB), "2026-07-06");
});

test("END_DATE falls back to job.end_date when the ended submittal has no end_date", () => {
  assert.equal(
    computeBqEndDateFromSubmittal({ start_date: "2026-06-22", end_date: null, organization_submittal_status: { code: "COMPLETED" } }, JOB),
    "2026-09-19"
  );
});

test("END_DATE is null while STARTED / BOOKED / ACTIVE (not ended yet — planned end lives in TENTATIVE_END_DATE)", () => {
  assert.equal(computeBqEndDateFromSubmittal(withStatus("PERM_STARTS"), JOB), null);
  assert.equal(computeBqEndDateFromSubmittal(withStatus("BOOKED"), JOB), null);
  assert.equal(computeBqEndDateFromSubmittal(withStatus("ACTIVE"), JOB), null);
});

test("END_DATE = start_date for DID NOT ACCEPT / DID NOT START (never worked)", () => {
  assert.equal(computeBqEndDateFromSubmittal(withStatus("OFFER_REJECTED"), JOB), "2026-06-22");
  assert.equal(computeBqEndDateFromSubmittal(withStatus("CANCELLED"), JOB), "2026-06-22");
});

test("TENTATIVE_END_DATE = submittal.end_date (planned), START_DATE = submittal.start_date", () => {
  const m = mapJobSubmittalToBq(withStatus("EARLY_TERM"), JOB);
  assert.equal(m.TENTATIVE_END_DATE, "2026-07-06");
  assert.equal(m.START_DATE, "2026-06-22");
});
