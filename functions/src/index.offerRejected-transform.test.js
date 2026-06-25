const test = require("node:test");
const assert = require("node:assert/strict");
const {
  filterOfferRejectedEndedPlacementStatuses,
  filterOfferRejectedRowsByMinTentativeDate,
  transformOfferRejectedEndedRowsForBigQuery,
} = require("./offerRejectedRowTransform");

test("filterOfferRejectedEndedPlacementStatuses keeps ended-style statuses only", () => {
  const rows = [
    { PLACEMENT_STATUS: "ENDED" },
    { PLACEMENT_STATUS: "STARTED" },
    { PLACEMENT_STATUS: "DID NOT ACCEPT" },
  ];
  const out = filterOfferRejectedEndedPlacementStatuses(rows);
  assert.equal(out.length, 2);
  assert.equal(out[0].PLACEMENT_STATUS, "ENDED");
  assert.equal(out[1].PLACEMENT_STATUS, "DID NOT ACCEPT");
});

test("filterOfferRejectedRowsByMinTentativeDate uses TENTATIVE_DATE not START_DATE", () => {
  const rows = [
    { PLACEMENT_STATUS: "ENDED", TENTATIVE_DATE: "2026-05-01", START_DATE: "2026-01-01" },
    { PLACEMENT_STATUS: "ENDED", TENTATIVE_DATE: "2026-04-30", START_DATE: "2026-06-01" },
    { PLACEMENT_STATUS: "ENDED", TENTATIVE_DATE: null, START_DATE: "2026-06-01" },
  ];
  const out = filterOfferRejectedRowsByMinTentativeDate(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].TENTATIVE_DATE, "2026-05-01");
});

test("filterOfferRejectedRowsByMinTentativeDate: DID NOT START uses START_DATE when tentative null", () => {
  const rows = [
    {
      PLACEMENT_STATUS: "DID NOT START",
      TENTATIVE_DATE: null,
      START_DATE: "2026-06-01",
    },
    {
      PLACEMENT_STATUS: "DID NOT START",
      TENTATIVE_DATE: null,
      START_DATE: "2026-04-01",
    },
  ];
  const out = filterOfferRejectedRowsByMinTentativeDate(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].START_DATE, "2026-06-01");
});

test("transformOfferRejectedEndedRowsForBigQuery applies placement then tentative date", () => {
  const rows = [
    { PLACEMENT_STATUS: "ENDED", TENTATIVE_DATE: "2026-05-01" },
    { PLACEMENT_STATUS: "STARTED", TENTATIVE_DATE: "2026-06-01" },
    { PLACEMENT_STATUS: "ENDED", TENTATIVE_DATE: "2026-04-01" },
  ];
  const out = transformOfferRejectedEndedRowsForBigQuery(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].PLACEMENT_STATUS, "ENDED");
  assert.equal(out[0].TENTATIVE_DATE, "2026-05-01");
});
