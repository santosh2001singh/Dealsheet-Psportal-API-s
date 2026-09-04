const test = require("node:test");
const assert = require("node:assert/strict");

const { mapJobSubmittalToBq } = require("./columnMappings");

// Business rule (mapJobSubmittalToBq signature is (submittalRow, jobObj)):
//   START_DATE — the job-submittal's start_date wins; the job is only a fallback when the submittal
//                has none/blank.
//   TENTATIVE_END_DATE — the JOB's end_date ONLY (no submittal fallback).
//   END_DATE — submittal-first, and only once the placement has actually ENDED (covered elsewhere).

test("START_DATE uses submittal.start_date when present (submittal wins over job)", () => {
  const out = mapJobSubmittalToBq(
    { id: 1, start_date: "2026-06-08" },
    { start_date: "2026-07-12" }
  );
  assert.equal(out.START_DATE, "2026-06-08");
});

test("START_DATE falls back to job.start_date when submittal.start_date is null", () => {
  const out = mapJobSubmittalToBq(
    { id: 1, start_date: null },
    { start_date: "2026-07-12" }
  );
  assert.equal(out.START_DATE, "2026-07-12");
});

test("START_DATE falls back to job.start_date when submittal.start_date is blank string", () => {
  const out = mapJobSubmittalToBq({ id: 1, start_date: "  " }, { start_date: "2026-07-12" });
  assert.equal(out.START_DATE, "2026-07-12");
});

test("START_DATE null when neither submittal nor job has a start_date", () => {
  const out = mapJobSubmittalToBq({ id: 1, start_date: null }, { start_date: null });
  assert.equal(out.START_DATE, null);
});

test("TENTATIVE_END_DATE is submittal.end_date first, job.end_date as fallback", () => {
  // submittal present -> submittal wins over the job
  assert.equal(
    mapJobSubmittalToBq({ id: 1, end_date: "2026-06-08" }, { end_date: "2026-07-12" }).TENTATIVE_END_DATE,
    "2026-06-08"
  );
  // submittal end_date blank/absent -> fall back to the job's end_date
  assert.equal(
    mapJobSubmittalToBq({ id: 1, end_date: null }, { end_date: "2026-07-12" }).TENTATIVE_END_DATE,
    "2026-07-12"
  );
  assert.equal(
    mapJobSubmittalToBq({ id: 1, end_date: "   " }, { end_date: "2026-07-12" }).TENTATIVE_END_DATE,
    "2026-07-12"
  );
  // neither has one -> null
  assert.equal(
    mapJobSubmittalToBq({ id: 1, end_date: null }, { end_date: null }).TENTATIVE_END_DATE,
    null
  );
  assert.equal(mapJobSubmittalToBq({ id: 1, end_date: null }, {}).TENTATIVE_END_DATE, null);
});
