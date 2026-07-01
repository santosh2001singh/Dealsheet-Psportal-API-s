const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyExtensionStartDateForRow,
  applyExtensionDateFreeze,
  computeDealSheetFirstInsertDateStamps,
  resolveExtensionDatesForInsertRows,
} = require("./bigQueryClient");

test("applyExtensionStartDateForRow copies START_DATE for EXTENSION rows", () => {
  const ext = applyExtensionStartDateForRow({
    DEAL_TYPE: "EXTENSION",
    START_DATE: "2026-03-15",
  });
  assert.equal(ext.EXTENSION_START_DATE, "2026-03-15");

  const deal = applyExtensionStartDateForRow({
    DEAL_TYPE: "DEAL",
    START_DATE: "2026-03-15",
  });
  assert.equal(deal.EXTENSION_START_DATE, null);
});

test("applyExtensionDateFreeze keeps baseline EXTENSION_DATE when present", () => {
  const frozen = applyExtensionDateFreeze(
    { DEAL_TYPE: "EXTENSION", EXTENSION_DATE: null },
    { EXTENSION_DATE: "2026-01-10T15:30:00.000Z" }
  );
  assert.equal(frozen.frozen, true);
  assert.equal(frozen.row.EXTENSION_DATE, "2026-01-10T15:30:00.000Z");

  const notFrozen = applyExtensionDateFreeze(
    { DEAL_TYPE: "EXTENSION", EXTENSION_DATE: null },
    { EXTENSION_DATE: null }
  );
  assert.equal(notFrozen.frozen, false);
  assert.equal(notFrozen.row.EXTENSION_DATE, null);
});

test("computeDealSheetFirstInsertDateStamps stamps EXTENSION without BOOKED gate", () => {
  const stamped = computeDealSheetFirstInsertDateStamps(
    { DEAL_TYPE: "EXTENSION", PLACEMENT_STATUS: "STARTED", EXTENSION_DATE: null },
    "2026-06-15T18:30:00.000Z"
  );
  assert.ok(stamped.EXTENSION_DATE);
  assert.match(stamped.EXTENSION_DATE, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

  const deal = computeDealSheetFirstInsertDateStamps(
    { DEAL_TYPE: "DEAL", EXTENSION_DATE: null },
    "2026-06-15T18:30:00.000Z"
  );
  assert.equal(deal.EXTENSION_DATE, undefined);

  const alreadySet = computeDealSheetFirstInsertDateStamps(
    { DEAL_TYPE: "EXTENSION", EXTENSION_DATE: "2026-01-01T00:00:00.000Z" },
    "2026-06-15T18:30:00.000Z"
  );
  assert.equal(alreadySet.EXTENSION_DATE, undefined);
});

test("resolveExtensionDatesForInsertRows uses MIN(DATE_AND_TIME) from BigQuery", async () => {
  const fetchEarliestFn = async (rows) => {
    assert.equal(rows.length, 1);
    return new Map([["100|200", "2026-02-01T12:00:00.000Z"]]);
  };

  const out = await resolveExtensionDatesForInsertRows(
    [
      {
        DEAL_SHEET_ID: 100,
        PLACEMENT_ID: 200,
        DEAL_TYPE: "EXTENSION",
        START_DATE: "2026-04-01",
        EXTENSION_DATE: null,
      },
    ],
    {},
    { fetchEarliestFn }
  );

  assert.equal(out.length, 1);
  assert.equal(out[0].EXTENSION_START_DATE, "2026-04-01");
  assert.equal(out[0].EXTENSION_DATE, "2026-02-01T12:00:00.000Z");
});

test("resolveExtensionDatesForInsertRows leaves empty when no BQ history", async () => {
  const fetchEarliestFn = async () => new Map();

  const out = await resolveExtensionDatesForInsertRows(
    [
      {
        DEAL_SHEET_ID: 1,
        PLACEMENT_ID: 2,
        DEAL_TYPE: "EXTENSION",
        START_DATE: "2026-04-01",
        EXTENSION_DATE: null,
      },
    ],
    {},
    { fetchEarliestFn }
  );

  assert.equal(out[0].EXTENSION_DATE, null);
  assert.equal(out[0].EXTENSION_START_DATE, "2026-04-01");
});
