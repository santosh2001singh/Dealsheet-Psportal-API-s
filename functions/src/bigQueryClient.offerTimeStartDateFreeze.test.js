const test = require("node:test");
const assert = require("node:assert/strict");

const { applyOfferTimeStartDateFreeze, hasBusinessColumnChanges } = require("./bigQueryClient");
const { API_OWNED_COLUMNS, SYSTEM_CONTROLLED_COLUMNS } = require("./columnMappings");

test("OFFER_TIME_START_DATE is system-controlled, not API-owned", () => {
  assert.equal(API_OWNED_COLUMNS.has("OFFER_TIME_START_DATE"), false);
  assert.equal(SYSTEM_CONTROLLED_COLUMNS.has("OFFER_TIME_START_DATE"), true);
});

test("applyOfferTimeStartDateFreeze: baseline set freezes despite different incoming and START_DATE change", () => {
  const baseline = {
    OFFER_TIME_START_DATE: "2026-01-15",
    START_DATE: "2026-01-15",
  };
  const incoming = {
    OFFER_TIME_START_DATE: "2026-06-01",
    START_DATE: "2026-06-15",
  };
  const { row, frozen } = applyOfferTimeStartDateFreeze(incoming, baseline);
  assert.equal(frozen, true);
  assert.equal(row.OFFER_TIME_START_DATE, "2026-01-15");
  assert.equal(row.START_DATE, "2026-06-15");
});

test("applyOfferTimeStartDateFreeze: empty baseline keeps incoming Nexus value", () => {
  const baseline = { OFFER_TIME_START_DATE: null, START_DATE: "2026-01-01" };
  const incoming = { OFFER_TIME_START_DATE: "2026-03-01", START_DATE: "2026-03-01" };
  const { row, frozen } = applyOfferTimeStartDateFreeze(incoming, baseline);
  assert.equal(frozen, false);
  assert.equal(row.OFFER_TIME_START_DATE, "2026-03-01");
});

test("applyOfferTimeStartDateFreeze: blank-string baseline treated as empty", () => {
  const baseline = { OFFER_TIME_START_DATE: "  " };
  const incoming = { OFFER_TIME_START_DATE: "2026-04-01" };
  const { row, frozen } = applyOfferTimeStartDateFreeze(incoming, baseline);
  assert.equal(frozen, false);
  assert.equal(row.OFFER_TIME_START_DATE, "2026-04-01");
});

test("hasBusinessColumnChanges: only OFFER_TIME_START_DATE differing is NOT a change", () => {
  const IGNORE = new Set(["ID", "LAST_UPDATED", "IS_REJECTED"]);
  const baseline = {
    ASSIGNMENT_RECRUITER_EMAIL: "a@cynethealth.com",
    DEAL_TYPE: "DEAL",
    BILL_RATE: "90",
    START_DATE: "2026-06-15",
    OFFER_TIME_START_DATE: "2026-01-15",
  };
  const incoming = {
    ...baseline,
    OFFER_TIME_START_DATE: "2026-06-01",
  };
  assert.equal(hasBusinessColumnChanges(incoming, baseline, IGNORE), false);
});

test("hasBusinessColumnChanges: START_DATE change still detected when offer time also differs", () => {
  const IGNORE = new Set(["ID", "LAST_UPDATED", "IS_REJECTED"]);
  const baseline = {
    ASSIGNMENT_RECRUITER_EMAIL: "a@cynethealth.com",
    DEAL_TYPE: "DEAL",
    BILL_RATE: "90",
    START_DATE: "2026-01-15",
    OFFER_TIME_START_DATE: "2026-01-15",
  };
  const incoming = {
    ...baseline,
    START_DATE: "2026-06-15",
    OFFER_TIME_START_DATE: "2026-06-01",
  };
  assert.equal(hasBusinessColumnChanges(incoming, baseline, IGNORE), true);
});
