const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveOriginalStartDatesForRows } = require("./originalStartDateResolver");

function row(overrides = {}) {
  return {
    DEAL_SHEET_ID: 70001,
    PLACEMENT_ID: 1437555,
    CANDIDATE_NEXUS_ID: 9001,
    CANDIDATE_EMAIL: "john@example.com",
    PHONE_NUMBER: "555-0100",
    NEXUS_INTERNAL_JOB_ID: 5500,
    CLIENT_ID: 200,
    START_DATE: "2026-01-05",
    DEAL_TYPE: "DEAL",
    ...overrides,
  };
}

function noopDeps(overrides = {}) {
  return {
    fetchOriginalStartDatesForExtensionsFn: async () => new Map(),
    ...overrides,
  };
}

test("DEAL + EXTENSION same batch inherit ORIGINAL_START_DATE without BQ lookup", async () => {
  let extLookupCalled = false;
  const rows = [
    row({ PLACEMENT_ID: 1437555, DEAL_TYPE: "DEAL", START_DATE: "2026-01-05" }),
    row({
      PLACEMENT_ID: 1458621,
      DEAL_TYPE: "EXTENSION",
      DEAL_SHEET_ID: 70128,
      START_DATE: "2026-04-05",
    }),
  ];
  await resolveOriginalStartDatesForRows(
    rows,
    noopDeps({
      fetchOriginalStartDatesForExtensionsFn: async () => {
        extLookupCalled = true;
        return new Map();
      },
    })
  );
  assert.equal(rows[0].ORIGINAL_START_DATE, undefined);
  assert.equal(rows[1].ORIGINAL_START_DATE, "2026-01-05");
  assert.equal(extLookupCalled, false);
});

test("EXTENSION picks latest DEAL start on or before extension START_DATE in batch", async () => {
  const rows = [
    row({
      PLACEMENT_ID: 1000,
      DEAL_TYPE: "DEAL",
      START_DATE: "2026-01-01",
      DEAL_SHEET_ID: 70001,
    }),
    row({
      PLACEMENT_ID: 1001,
      DEAL_TYPE: "DEAL",
      START_DATE: "2026-03-01",
      DEAL_SHEET_ID: 70002,
    }),
    row({
      PLACEMENT_ID: 2000,
      DEAL_TYPE: "EXTENSION",
      START_DATE: "2026-02-15",
      DEAL_SHEET_ID: 70100,
    }),
  ];
  await resolveOriginalStartDatesForRows(rows, noopDeps());
  assert.equal(rows[2].ORIGINAL_START_DATE, "2026-01-01");
});

test("EXTENSION uses BQ lookup when no in-batch DEAL", async () => {
  const rows = [
    row({
      PLACEMENT_ID: 1458621,
      DEAL_TYPE: "EXTENSION",
      START_DATE: "2026-04-05",
    }),
  ];
  await resolveOriginalStartDatesForRows(
    rows,
    noopDeps({
      fetchOriginalStartDatesForExtensionsFn: async () =>
        new Map([["1458621", "2025-11-20"]]),
    })
  );
  assert.equal(rows[0].ORIGINAL_START_DATE, "2025-11-20");
});

test("EXTENSION orphan stays null when BQ returns no date", async () => {
  const rows = [row({ PLACEMENT_ID: 9999, DEAL_TYPE: "EXTENSION" })];
  await resolveOriginalStartDatesForRows(
    rows,
    noopDeps({
      fetchOriginalStartDatesForExtensionsFn: async () => new Map([["9999", null]]),
    })
  );
  assert.equal(rows[0].ORIGINAL_START_DATE, null);
});

test("EXTENSION without match key stays null", async () => {
  const rows = [
    row({
      DEAL_TYPE: "EXTENSION",
      CANDIDATE_NEXUS_ID: null,
      CLIENT_ID: 200,
    }),
  ];
  await resolveOriginalStartDatesForRows(rows, noopDeps());
  assert.equal(rows[0].ORIGINAL_START_DATE, null);
});

test("DEAL row ORIGINAL_START_DATE left to insert-time stamp (resolver does not set DEAL)", async () => {
  const rows = [row({ DEAL_TYPE: "DEAL", START_DATE: "2026-05-01" })];
  await resolveOriginalStartDatesForRows(rows, noopDeps());
  assert.equal(rows[0].ORIGINAL_START_DATE, undefined);
});
