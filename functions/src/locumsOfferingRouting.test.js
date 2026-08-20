const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveActiveDealSheetTableId,
  resolveActiveDealSheetTableIdForRow,
  resolveEndedDealSheetTableIdForRow,
  rowMatchesSyncDomainForRow,
  isLocumsOffering,
  TABLE_CYNET_HEALTH,
  TABLE_CYNET_HEALTH_CANADA,
  TABLE_CYNET_LOCUMS,
  TABLE_ENDED_CYNET_HEALTH,
  TABLE_ENDED_CYNET_LOCUMS,
  TABLE_ENDED_CYNET_HEALTH_CANADA,
} = require("./recruiterDomainTables");

// OFFERING is the authority on what KIND of business a placement is; the recruiter email only says
// who owns it. The GOV desk sits on @cynethealth.com and places locums work, so routing on the email
// alone put real locums business in cynet_health_deal_sheet — where the locums pay/bill/margin
// derivations do not apply and health's reporting counts business that is not health's.
//
// Live examples (Aug 2026), all @cynethealth.com recruiters with OFFERING=LOCUMS:
//   Keith S Susko      / PLACEMENT_ID 1457477 / "Demi Sharma (GOV)"
//   Akhil Maheshwari   / PLACEMENT_ID 1459467 / "Yogesh Tiwari (GOV)"
//   Joel Leifheit      / PLACEMENT_ID 1443592 / "Demi Sharma (GOV)"
//   Mark Kropinak      / PLACEMENT_ID 1451211 / "Aditi Kestwal (GOV)"
// Each also carries a @cynetlocums.com onsite AM and PROFESSION=Physician.

const GOV_LOCUMS_ROW = {
  ASSIGNMENT_RECRUITER_EMAIL: "demi.s@cynethealth.com",
  OFFERING: "LOCUMS",
  JOB_TYPE: "LOCUM",
  PROFESSION: "Physician",
  ONSITE_AM_EMAIL: "katie.a@cynetlocums.com",
};

test("isLocumsOffering reads OFFERING case- and whitespace-insensitively", () => {
  assert.equal(isLocumsOffering({ OFFERING: "LOCUMS" }), true);
  assert.equal(isLocumsOffering({ OFFERING: "locums" }), true);
  assert.equal(isLocumsOffering({ OFFERING: "  Locums  " }), true);
  assert.equal(isLocumsOffering({ OFFERING: "NURSING" }), false);
  assert.equal(isLocumsOffering({ OFFERING: null }), false);
  assert.equal(isLocumsOffering({}), false);
  assert.equal(isLocumsOffering(null), false);
});

test("a health recruiter's LOCUMS row routes to the locums table", () => {
  assert.equal(resolveActiveDealSheetTableIdForRow(GOV_LOCUMS_ROW), TABLE_CYNET_LOCUMS);
  // The email-only resolver is what used to send it to health — kept to show the difference.
  assert.equal(
    resolveActiveDealSheetTableId(GOV_LOCUMS_ROW.ASSIGNMENT_RECRUITER_EMAIL),
    TABLE_CYNET_HEALTH
  );
});

test("a health recruiter's non-locums row still routes to health", () => {
  // The change must be scoped to OFFERING=LOCUMS and touch nothing else.
  assert.equal(
    resolveActiveDealSheetTableIdForRow({
      ASSIGNMENT_RECRUITER_EMAIL: "someone@cynethealth.com",
      OFFERING: "NURSING",
    }),
    TABLE_CYNET_HEALTH
  );
  assert.equal(
    resolveActiveDealSheetTableIdForRow({
      ASSIGNMENT_RECRUITER_EMAIL: "someone@cynethealth.com",
      OFFERING: null,
    }),
    TABLE_CYNET_HEALTH
  );
});

test("a real locums recruiter is unaffected", () => {
  assert.equal(
    resolveActiveDealSheetTableIdForRow({
      ASSIGNMENT_RECRUITER_EMAIL: "x@cynetlocums.com",
      OFFERING: "LOCUMS",
    }),
    TABLE_CYNET_LOCUMS
  );
  // Even with a non-locums offering, the recruiter's own domain still owns the row.
  assert.equal(
    resolveActiveDealSheetTableIdForRow({
      ASSIGNMENT_RECRUITER_EMAIL: "x@cynetlocums.com",
      OFFERING: "NURSING",
    }),
    TABLE_CYNET_LOCUMS
  );
});

test("a Canada recruiter is NEVER pulled into the US locums table", () => {
  // Canada is a separate legal entity, so the kind of work must not move a row across it.
  assert.equal(
    resolveActiveDealSheetTableIdForRow({
      ASSIGNMENT_RECRUITER_EMAIL: "y@cynethealth.ca",
      OFFERING: "LOCUMS",
    }),
    TABLE_CYNET_HEALTH_CANADA
  );
  assert.equal(
    resolveEndedDealSheetTableIdForRow({
      ASSIGNMENT_RECRUITER_EMAIL: "y@cynethealth.ca",
      OFFERING: "LOCUMS",
    }),
    TABLE_ENDED_CYNET_HEALTH_CANADA
  );
});

test("the ended table follows the same rule, so a row keeps its domain when it ends", () => {
  assert.equal(resolveEndedDealSheetTableIdForRow(GOV_LOCUMS_ROW), TABLE_ENDED_CYNET_LOCUMS);
  assert.equal(
    resolveEndedDealSheetTableIdForRow({
      ASSIGNMENT_RECRUITER_EMAIL: "someone@cynethealth.com",
      OFFERING: "NURSING",
    }),
    TABLE_ENDED_CYNET_HEALTH
  );
});

test("the health run drops the row and the locums run claims it — exactly one domain owns it", () => {
  // Filter and insert-time resolver share one rule, so a row can never be claimed twice or dropped
  // by every domain.
  assert.equal(rowMatchesSyncDomainForRow("health", GOV_LOCUMS_ROW), false);
  assert.equal(rowMatchesSyncDomainForRow("locums", GOV_LOCUMS_ROW), true);
  assert.equal(rowMatchesSyncDomainForRow("canada", GOV_LOCUMS_ROW), false);
});

test("every one of the four live GOV rows lands in locums", () => {
  const recruiters = [
    "demi.s@cynethealth.com", // Keith S Susko, Joel Leifheit
    "yogesh.t@cynethealth.com", // Akhil Maheshwari
    "aditi.k2@cynethealth.com", // Mark Kropinak
    "neha.b@cynethealth.com", // Alexandra Hansen
  ];
  for (const email of recruiters) {
    const row = { ASSIGNMENT_RECRUITER_EMAIL: email, OFFERING: "LOCUMS" };
    assert.equal(resolveActiveDealSheetTableIdForRow(row), TABLE_CYNET_LOCUMS, email);
    assert.equal(rowMatchesSyncDomainForRow("health", row), false, `${email} must leave health`);
  }
});

test("an unfiltered run (no domain) still accepts every row", () => {
  // Callers pass the raw param through, so a null domain must keep matching everything.
  assert.equal(rowMatchesSyncDomainForRow(null, GOV_LOCUMS_ROW), true);
  assert.equal(rowMatchesSyncDomainForRow("", GOV_LOCUMS_ROW), true);
});
