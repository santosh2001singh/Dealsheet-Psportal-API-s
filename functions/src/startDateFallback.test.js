const test = require("node:test");
const assert = require("node:assert/strict");

const { mapJobSubmittalToBq } = require("./columnMappings");

// Business rule: job.start_date/end_date are authoritative; the submittal is only a fallback when the
// job value is null/blank. (Reversed from the old submittal-first order.)

test("START_DATE uses job.start_date when present (job wins over submittal)", () => {
  const out = mapJobSubmittalToBq(
    { id: 1, start_date: "2026-06-08" },
    { start_date: "2026-07-12" }
  );
  assert.equal(out.START_DATE, "2026-07-12");
});

test("START_DATE falls back to submittal.start_date when job.start_date is null", () => {
  const out = mapJobSubmittalToBq(
    { id: 1, start_date: "2026-06-08" },
    { start_date: null }
  );
  assert.equal(out.START_DATE, "2026-06-08");
});

test("START_DATE falls back to submittal.start_date when job.start_date is blank string", () => {
  const out = mapJobSubmittalToBq({ id: 1, start_date: "2026-06-08" }, { start_date: "  " });
  assert.equal(out.START_DATE, "2026-06-08");
});

test("START_DATE null when neither job nor submittal has a start_date", () => {
  const out = mapJobSubmittalToBq({ id: 1, start_date: null }, { start_date: null });
  assert.equal(out.START_DATE, null);
});

test("TENTATIVE_DATE uses job.end_date first, submittal.end_date fallback", () => {
  assert.equal(
    mapJobSubmittalToBq({ id: 1, end_date: "2026-06-08" }, { end_date: "2026-07-12" }).TENTATIVE_DATE,
    "2026-07-12"
  );
  assert.equal(
    mapJobSubmittalToBq({ id: 1, end_date: "2026-06-08" }, { end_date: null }).TENTATIVE_DATE,
    "2026-06-08"
  );
});
