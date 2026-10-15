const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveNewHireDateForDealRow } = require("./columnMappings");

const bookedNote = (modified) => ({
  org_submittal_status: { code: "BOOKED" },
  modified_date: modified,
});

const CANCELLED_SUBMITTAL = { modified_date: "2026-07-20T15:59:33Z" };

test("DEAL + DID NOT START + no BOOKED note -> submittal modified_date (ISO)", () => {
  assert.equal(
    resolveNewHireDateForDealRow("DEAL", [], "DID NOT START", CANCELLED_SUBMITTAL),
    "2026-07-20T15:59:33.000Z"
  );
});

test("DEAL + DID NOT START + BOOKED note present -> BOOKED date (no cancellation overwrite)", () => {
  assert.equal(
    resolveNewHireDateForDealRow(
      "DEAL",
      [bookedNote("2026-06-30T10:00:00Z")],
      "DID NOT START",
      CANCELLED_SUBMITTAL
    ),
    "2026-06-30T10:00:00Z"
  );
});

test("DEAL + STARTED + no BOOKED note -> null (no cancellation fallback)", () => {
  assert.equal(
    resolveNewHireDateForDealRow("DEAL", [], "STARTED", CANCELLED_SUBMITTAL),
    null
  );
});

test("EXTENSION + DID NOT START -> null (unchanged)", () => {
  assert.equal(
    resolveNewHireDateForDealRow("EXTENSION", [], "DID NOT START", CANCELLED_SUBMITTAL),
    null
  );
});

test("DEAL + DID NOT START + missing submittal modified_date -> null", () => {
  assert.equal(
    resolveNewHireDateForDealRow("DEAL", [], "DID NOT START", { modified_date: "" }),
    null
  );
});

// DID NOT ACCEPT (Oct 2026): a DEAL whose offer was rejected takes the day it was rejected.
const rejectedNote = (created) => ({
  org_submittal_status: { code: "OFFER_REJECTED" },
  created_date: created,
  modified_date: created,
});

test("DEAL + DID NOT ACCEPT -> earliest OFFER_REJECTED note created_date", () => {
  assert.equal(
    resolveNewHireDateForDealRow(
      "DEAL",
      [rejectedNote("2026-03-23T18:00:05Z"), rejectedNote("2026-03-23T18:00:00Z")],
      "DID NOT ACCEPT",
      CANCELLED_SUBMITTAL
    ),
    "2026-03-23T18:00:00Z"
  );
});

test("DEAL + DID NOT ACCEPT -> rejection wins over an earlier BOOKED note", () => {
  assert.equal(
    resolveNewHireDateForDealRow(
      "DEAL",
      [bookedNote("2026-03-01T10:00:00Z"), rejectedNote("2026-03-23T18:00:00Z")],
      "DID NOT ACCEPT",
      CANCELLED_SUBMITTAL
    ),
    "2026-03-23T18:00:00Z"
  );
});

test("DEAL + DID NOT ACCEPT + no OFFER_REJECTED note -> null (no modified_date fallback)", () => {
  assert.equal(resolveNewHireDateForDealRow("DEAL", [], "DID NOT ACCEPT", CANCELLED_SUBMITTAL), null);
});

test("EXTENSION + DID NOT ACCEPT -> null (keeps the inherited contract hire date)", () => {
  assert.equal(
    resolveNewHireDateForDealRow("EXTENSION", [rejectedNote("2026-03-23T18:00:00Z")], "DID NOT ACCEPT", CANCELLED_SUBMITTAL),
    null
  );
});

test("DEAL + STARTED ignores an OFFER_REJECTED note (BOOKED rule unchanged)", () => {
  assert.equal(
    resolveNewHireDateForDealRow(
      "DEAL",
      [rejectedNote("2026-03-23T18:00:00Z"), bookedNote("2026-03-25T10:00:00Z")],
      "STARTED",
      CANCELLED_SUBMITTAL
    ),
    "2026-03-25T10:00:00Z"
  );
});
