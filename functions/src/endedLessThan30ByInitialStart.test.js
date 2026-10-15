// ENDED vs ENDED<30 = INITIAL_START_DATE -> END_DATE (< 30 days => ENDED<30), never the submittal's
// Early Term status. INITIAL_START_DATE falls back to START_DATE when blank.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyEndedPlacementStatusByInitialStart,
  mapSubmittalStatusToPlacementStatus,
  mapSubmittalCodeToPlacementStatus,
} = require("./columnMappings");

test("Early Term / Completed both map to plain ENDED at the mapper", () => {
  assert.equal(mapSubmittalStatusToPlacementStatus("Early Term"), "ENDED");
  assert.equal(mapSubmittalStatusToPlacementStatus("Completed"), "ENDED");
  assert.equal(mapSubmittalCodeToPlacementStatus("EARLY_TERM"), "ENDED");
});

test("< 30 days from INITIAL_START_DATE -> ENDED<30", () => {
  const row = { PLACEMENT_STATUS: "ENDED", INITIAL_START_DATE: "2026-09-01", START_DATE: "2026-09-01", END_DATE: "2026-09-30" };
  assert.equal(applyEndedPlacementStatusByInitialStart(row).PLACEMENT_STATUS, "ENDED<30"); // 29 days
});

test("exactly 30 days -> ENDED", () => {
  const row = { PLACEMENT_STATUS: "ENDED<30", INITIAL_START_DATE: "2026-09-01", END_DATE: "2026-10-01" };
  assert.equal(applyEndedPlacementStatusByInitialStart(row).PLACEMENT_STATUS, "ENDED");
});

test("short extension of a long contract -> ENDED (contract start, not own START_DATE)", () => {
  const row = { PLACEMENT_STATUS: "ENDED", INITIAL_START_DATE: "2026-01-05", START_DATE: "2026-09-01", END_DATE: "2026-09-14" };
  assert.equal(applyEndedPlacementStatusByInitialStart(row).PLACEMENT_STATUS, "ENDED");
});

test("blank INITIAL_START_DATE falls back to START_DATE; BQ DATE objects accepted", () => {
  const row = { PLACEMENT_STATUS: "ENDED", INITIAL_START_DATE: null, START_DATE: { value: "2026-09-01" }, END_DATE: "2026-09-10T00:00:00Z" };
  assert.equal(applyEndedPlacementStatusByInitialStart(row).PLACEMENT_STATUS, "ENDED<30");
});

test("override (baseline INITIAL_START_DATE) wins over the row's own", () => {
  const row = { PLACEMENT_STATUS: "ENDED", START_DATE: "2026-09-01", END_DATE: "2026-09-10" };
  assert.equal(applyEndedPlacementStatusByInitialStart(row, "2026-01-01").PLACEMENT_STATUS, "ENDED");
});

test("non-ended statuses and missing dates are left untouched", () => {
  const started = { PLACEMENT_STATUS: "STARTED", INITIAL_START_DATE: "2026-09-01", END_DATE: "2026-09-05" };
  assert.equal(applyEndedPlacementStatusByInitialStart(started), started);
  const noEnd = { PLACEMENT_STATUS: "ENDED", INITIAL_START_DATE: "2026-09-01", END_DATE: null };
  assert.equal(applyEndedPlacementStatusByInitialStart(noEnd), noEnd);
});
