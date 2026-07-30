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
