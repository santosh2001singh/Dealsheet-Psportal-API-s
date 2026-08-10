// CLIENT_TYPE / TYPE_OF_CLIENT became manual columns in Aug 2026. They used to be enriched from the
// client offering's client_setting_type, but the offering pick could swing between syncs and rewrite
// the values under the business. They are now hand-owned in BigQuery: the enrich pipeline never
// writes them, the baseline value is carried forward on every append, and a difference in them can
// no longer trigger an append-on-change row.

const test = require("node:test");
const assert = require("node:assert/strict");

const { applyManualColumnsCarryForward, hasBusinessColumnChanges } = require("./bigQueryClient");
const { API_OWNED_COLUMNS, MANUAL_COLUMNS, mapMspFromClientOfferingRow } = require("./columnMappings");

test("CLIENT_TYPE / TYPE_OF_CLIENT are manual, not API-owned", () => {
  for (const key of ["CLIENT_TYPE", "TYPE_OF_CLIENT"]) {
    assert.equal(API_OWNED_COLUMNS.has(key), false, `${key} must not be API-owned`);
    assert.equal(MANUAL_COLUMNS.has(key), true, `${key} must be manual`);
  }
});

test("mapMspFromClientOfferingRow no longer emits either client-type column", () => {
  const offeringRow = {
    msp: { id: 42, name: "Acme MSP" },
    client_setting_type: { value: "Federal VMS" },
  };
  const out = mapMspFromClientOfferingRow(offeringRow);

  assert.equal(Object.prototype.hasOwnProperty.call(out, "CLIENT_TYPE"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out, "TYPE_OF_CLIENT"), false);
  // MSP fields still come from the same row.
  assert.equal(out.MSP_ID, 42);
  assert.equal(out.MSP_NAME, "Acme MSP");
  assert.equal(out.LINE_OF_BUSINESS, "Acme MSP");
});

test("carry-forward keeps the hand-edited values over anything on the incoming row", () => {
  const baseline = { CLIENT_TYPE: "State/Local Direct", TYPE_OF_CLIENT: "Goverment" };
  // A stale enrich row that still carried the old API-derived values must not win.
  const incoming = { CLIENT_TYPE: "VMS", TYPE_OF_CLIENT: "Commercial" };

  const { row } = applyManualColumnsCarryForward(incoming, baseline);

  assert.equal(row.CLIENT_TYPE, "State/Local Direct");
  assert.equal(row.TYPE_OF_CLIENT, "Goverment");
});

test("carry-forward restores manual values the enrich row omits entirely", () => {
  const baseline = { CLIENT_TYPE: "Federal VMS", TYPE_OF_CLIENT: "Federal" };
  const incoming = { PLACEMENT_ID: 123 };

  const { row } = applyManualColumnsCarryForward(incoming, baseline);

  assert.equal(row.CLIENT_TYPE, "Federal VMS");
  assert.equal(row.TYPE_OF_CLIENT, "Federal");
});

test("a NULL baseline stays NULL — enrich cannot backfill a manual column", () => {
  const baseline = { CLIENT_TYPE: null, TYPE_OF_CLIENT: null };
  const incoming = { CLIENT_TYPE: "VMS", TYPE_OF_CLIENT: "Commercial" };

  const { row } = applyManualColumnsCarryForward(incoming, baseline);

  assert.equal(row.CLIENT_TYPE, null);
  assert.equal(row.TYPE_OF_CLIENT, null);
});

test("a client-type difference alone no longer appends a new row", () => {
  const existing = { CLIENT_TYPE: "VMS", TYPE_OF_CLIENT: "Commercial", BILL_RATE: 100 };
  const incoming = { CLIENT_TYPE: "Federal VMS", TYPE_OF_CLIENT: "Federal", BILL_RATE: 100 };

  assert.equal(hasBusinessColumnChanges(incoming, existing), false);
});

test("a real API-owned change still appends, client-type change alongside notwithstanding", () => {
  const existing = { CLIENT_TYPE: "VMS", TYPE_OF_CLIENT: "Commercial", BILL_RATE: 100 };
  const incoming = { CLIENT_TYPE: "Federal VMS", TYPE_OF_CLIENT: "Federal", BILL_RATE: 125 };

  assert.equal(hasBusinessColumnChanges(incoming, existing), true);
});
