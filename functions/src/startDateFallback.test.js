const test = require("node:test");
const assert = require("node:assert/strict");

const { mapJobSubmittalToBq } = require("./columnMappings");

test("START_DATE uses submittal.start_date when present", () => {
  const out = mapJobSubmittalToBq(
    { id: 1, start_date: "2026-06-08" },
    { start_date: "2026-07-12" }
  );
  assert.equal(out.START_DATE, "2026-06-08");
});

test("START_DATE falls back to job.start_date when submittal.start_date is null", () => {
  const out = mapJobSubmittalToBq(
    { id: 1456868, start_date: null, organization_submittal_status: { code: "OFFER_REJECTED", submittal_status: "Offer Rejected" } },
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
