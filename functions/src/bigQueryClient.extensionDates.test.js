const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyExtensionStartDateForRow,
  applyExtensionDateFreeze,
  applyExtensionStartDatesForInsertRows,
} = require("./bigQueryClient");
const { resolveExtensionDateForExtensionRow } = require("./columnMappings");

test("resolveExtensionDateForExtensionRow uses submittal created_date for EXTENSION", () => {
  const ts = resolveExtensionDateForExtensionRow("EXTENSION", {
    created_date: "2026-04-27T19:48:37Z",
  });
  assert.equal(ts, "2026-04-27T19:48:37.000Z");

  assert.equal(resolveExtensionDateForExtensionRow("DEAL", { created_date: "2026-04-27T19:48:37Z" }), null);
  assert.equal(resolveExtensionDateForExtensionRow("EXTENSION", {}), null);
  assert.equal(resolveExtensionDateForExtensionRow("EXTENSION", null), null);
});

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

test("applyExtensionStartDatesForInsertRows sets EXTENSION_START_DATE only", () => {
  const out = applyExtensionStartDatesForInsertRows([
    {
      DEAL_TYPE: "EXTENSION",
      START_DATE: "2026-04-01",
      EXTENSION_DATE: "2026-04-27T19:48:37.000Z",
    },
  ]);
  assert.equal(out[0].EXTENSION_START_DATE, "2026-04-01");
  assert.equal(out[0].EXTENSION_DATE, "2026-04-27T19:48:37.000Z");
});
