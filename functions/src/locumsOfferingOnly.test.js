const test = require("node:test");
const assert = require("node:assert/strict");

const {
  rowMatchesSyncDomainForRow,
  rowAllowedInActiveTable,
  TABLE_CYNET_HEALTH,
  TABLE_CYNET_HEALTH_CANADA,
  TABLE_CYNET_LOCUMS,
} = require("./recruiterDomainTables");
const { submittalMayBeLocums } = require("./locumsDerivedPlacementFields");

/**
 * cynet_locums_deal_sheet holds OFFERING=LOCUMS only (2026-11-24). A @cynetlocums.com recruiter's
 * NURSING / ALLIED work used to land there; none of it is on the locums run-rate, so it is now
 * written nowhere. The pre-filter drops submittals whose client has no LOCUMS offering before any
 * enrich call — that fan-out is what timed every locums run out at 1800s.
 */

const LOCUMS_RECRUITER = "x@cynetlocums.com";

test("locums run keeps a locums recruiter's LOCUMS row", () => {
  assert.equal(
    rowMatchesSyncDomainForRow("locums", { ASSIGNMENT_RECRUITER_EMAIL: LOCUMS_RECRUITER, OFFERING: "LOCUMS" }),
    true
  );
});

test("locums run drops a locums recruiter's non-LOCUMS rows", () => {
  for (const OFFERING of ["NURSING", "ALLIED", "NONCLINICAL", null, ""]) {
    assert.equal(
      rowMatchesSyncDomainForRow("locums", { ASSIGNMENT_RECRUITER_EMAIL: LOCUMS_RECRUITER, OFFERING }),
      false,
      String(OFFERING)
    );
  }
});

test("health does not pick up a locums recruiter's NURSING row either", () => {
  assert.equal(
    rowMatchesSyncDomainForRow("health", { ASSIGNMENT_RECRUITER_EMAIL: LOCUMS_RECRUITER, OFFERING: "NURSING" }),
    false
  );
});

test("GOV-desk health recruiter with OFFERING=LOCUMS still goes to locums", () => {
  const row = { ASSIGNMENT_RECRUITER_EMAIL: "demi.s@cynethealth.com", OFFERING: "LOCUMS" };
  assert.equal(rowMatchesSyncDomainForRow("locums", row), true);
  assert.equal(rowMatchesSyncDomainForRow("health", row), false);
});

test("health and canada rows are unaffected", () => {
  assert.equal(
    rowMatchesSyncDomainForRow("health", { ASSIGNMENT_RECRUITER_EMAIL: "a@cynethealth.com", OFFERING: "NURSING" }),
    true
  );
  assert.equal(
    rowMatchesSyncDomainForRow("canada", { ASSIGNMENT_RECRUITER_EMAIL: "a@cynethealth.ca", CLIENT_STATE: "ON", OFFERING: "NURSING" }),
    true
  );
});

test("rowAllowedInActiveTable gates only the locums table", () => {
  const nursing = { OFFERING: "NURSING" };
  assert.equal(rowAllowedInActiveTable(TABLE_CYNET_LOCUMS, nursing), false);
  assert.equal(rowAllowedInActiveTable(TABLE_CYNET_LOCUMS, { OFFERING: " locums " }), true);
  assert.equal(rowAllowedInActiveTable(TABLE_CYNET_HEALTH, nursing), true);
  assert.equal(rowAllowedInActiveTable(TABLE_CYNET_HEALTH_CANADA, nursing), true);
  assert.equal(rowAllowedInActiveTable("cynet_locums_ended_deal_sheet", nursing), true);
});

test("submittalMayBeLocums: client with a LOCUMS offering is kept", () => {
  const s = { client: { client_offerings: [{ offering_id: "NURSING" }, { offering_id: "LOCUMS" }] } };
  assert.equal(submittalMayBeLocums(s), true);
});

test("submittalMayBeLocums: client with only other offerings is dropped", () => {
  const s = { client: { client_offerings: [{ offering_id: "NURSING" }, { offering_id: "ALLIED" }] } };
  assert.equal(submittalMayBeLocums(s), false);
});

test("submittalMayBeLocums: missing or unreadable offerings are kept", () => {
  assert.equal(submittalMayBeLocums({}), true);
  assert.equal(submittalMayBeLocums({ client: {} }), true);
  assert.equal(submittalMayBeLocums({ client: { client_offerings: [] } }), true);
  assert.equal(submittalMayBeLocums({ client: { client_offerings: [{ offering_id: null }] } }), true);
  assert.equal(submittalMayBeLocums(null), true);
});

test("submittalMayBeLocums: reads `offering` too, case-insensitive", () => {
  assert.equal(submittalMayBeLocums({ client: { client_offerings: [{ offering: "locums" }] } }), true);
  assert.equal(submittalMayBeLocums({ client: { client_offerings: [{ offering: "nursing" }] } }), false);
});
