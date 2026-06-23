/**
 * First-insert date stamps for EXTENSION_DATE (NEW_HIRE_DATE comes from submittal notes enrich).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { computeDealSheetFirstInsertDateStamps } = require("./bigQueryClient");

const insertTs = "2026-06-03T15:04:05.123Z";

test("computeDealSheetFirstInsertDateStamps: deal does not stamp NEW_HIRE_DATE", () => {
  const row = { DEAL_TYPE: "deal", PLACEMENT_STATUS: "BOOKED" };
  const out = computeDealSheetFirstInsertDateStamps(row, insertTs);
  assert.equal(Object.hasOwn(out, "NEW_HIRE_DATE"), false);
  assert.equal(Object.hasOwn(out, "EXTENSION_DATE"), false);
  assert.equal(Object.hasOwn(out, "ORIGINAL_START_DATE"), false);
});

test("computeDealSheetFirstInsertDateStamps: extension + booked sets EXTENSION_DATE in ET", () => {
  const row = { DEAL_TYPE: "extension", PLACEMENT_STATUS: "booked" };
  const out = computeDealSheetFirstInsertDateStamps(row, insertTs);
  assert.equal(out.EXTENSION_DATE, "2026-06-03");
  assert.equal(Object.hasOwn(out, "NEW_HIRE_DATE"), false);
});

test("computeDealSheetFirstInsertDateStamps: extension without booked sets nothing", () => {
  const row = { DEAL_TYPE: "extension", PLACEMENT_STATUS: "STARTED" };
  const out = computeDealSheetFirstInsertDateStamps(row, insertTs);
  assert.deepEqual(out, {});
});

test("computeDealSheetFirstInsertDateStamps: populated NEW_HIRE_DATE unchanged (no stamp)", () => {
  const row = {
    DEAL_TYPE: "deal",
    NEW_HIRE_DATE: "2025-01-01T00:00:00.000Z",
  };
  const out = computeDealSheetFirstInsertDateStamps(row, insertTs);
  assert.deepEqual(out, {});
});

test("computeDealSheetFirstInsertDateStamps: does not overwrite populated EXTENSION_DATE", () => {
  const row = {
    DEAL_TYPE: "extension",
    PLACEMENT_STATUS: "BOOKED",
    EXTENSION_DATE: "2025-01-01",
  };
  const out = computeDealSheetFirstInsertDateStamps(row, insertTs);
  assert.deepEqual(out, {});
});

test("computeDealSheetFirstInsertDateStamps: ET date uses America/New_York calendar day", () => {
  const row = { DEAL_TYPE: "extension", PLACEMENT_STATUS: "BOOKED" };
  // 03:00 UTC on June 3 is still June 2 in US Eastern (EDT).
  const out = computeDealSheetFirstInsertDateStamps(row, "2026-06-03T03:00:00.000Z");
  assert.equal(out.EXTENSION_DATE, "2026-06-02");
});

test("computeDealSheetFirstInsertDateStamps: empty dateTime yields nothing", () => {
  const row = { DEAL_TYPE: "deal" };
  assert.deepEqual(computeDealSheetFirstInsertDateStamps(row, null), {});
  assert.deepEqual(computeDealSheetFirstInsertDateStamps(row, ""), {});
});

test("computeDealSheetFirstInsertDateStamps: blank EXTENSION_DATE treated as empty", () => {
  const extRow = {
    DEAL_TYPE: "extension",
    PLACEMENT_STATUS: "BOOKED",
    EXTENSION_DATE: "",
  };
  assert.equal(
    computeDealSheetFirstInsertDateStamps(extRow, insertTs).EXTENSION_DATE,
    "2026-06-03"
  );
});
