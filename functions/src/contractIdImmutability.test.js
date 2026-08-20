const test = require("node:test");
const assert = require("node:assert/strict");

const { allocateContractIdsForInsertableRows } = require("./contractIdResolver");

// A placement's contract identity is decided ONCE, at first insert, and is immutable after that:
// ch_rate_change_logs / ownership_change_logs / ch_termination_reason_logs are all keyed on
// CONTRACT_ID, and EXTENSION rows inherit it from their parent DEAL. So whenever a DEAL_SHEET_ID
// already carries an id, that id must win over every matcher in the allocator.
//
// Live regression (Aug 2026): DEAL_SHEET_ID 5139885 / PLACEMENT_ID 1441464 came back as CHC20892 on
// 08-18 after being CHC20908 on 08-17, every business field identical.
//
// The cause was NOT ordering inside the allocator — applyLegacyContractIdentityToDealRows already
// skips any row whose CONTRACT_ID is set, so a populated id was never overwritten there. The cause
// was that the existing-id reuse could not SEE the baseline: allocateContractIdsForInsertableRows was
// called without bqOptions, so fetchContractIdsByDealSheetIds fell back to config defaults instead of
// the dataset actually being written, the placement looked brand new, and the run-rate matcher (then
// the Firestore sequence) supplied a different id.
//
// These tests pin the resulting INVARIANT rather than the call order: whatever the existing-id lookup
// reports for a DEAL_SHEET_ID must win over every matcher and must never be re-minted.

/** The run-rate matcher, stubbed to always propose a DIFFERENT id than the baseline. */
function runrateProposes(contractId) {
  return {
    fetchLegacyContractIdentityFn: async (rows) => {
      const out = new Map();
      for (const r of rows) {
        const key = r.DEAL_SHEET_ID != null ? `ds:${r.DEAL_SHEET_ID}` : `pl:${r.PLACEMENT_ID}`;
        out.set(key, { CONTRACT_ID: contractId, SKU_NUMBER: null });
      }
      return out;
    },
  };
}

/** Existing-id lookup, stubbed to return what the table already holds for a DEAL_SHEET_ID. */
function tableHolds(map) {
  return { fetchContractIdsByDealSheetIdsFn: async () => new Map(Object.entries(map)) };
}

const NEVER_MINT = {
  allocateContractIdsFn: async () => {
    throw new Error("must not mint: the placement already has an id");
  },
};

test("an existing CONTRACT_ID beats a run-rate match proposing a different one", async () => {
  const rows = [
    {
      DEAL_TYPE: "DEAL",
      DEAL_SHEET_ID: 5139885,
      PLACEMENT_ID: 1441464,
      CANDIDATE_ID: 20118086,
      CLIENT_ID: 1953556,
      CANDIDATE_EMAIL: "jackietate670@gmail.com",
      CELL_PHONE: "(917) 536-3118",
      CONTRACT_ID: null,
    },
  ];

  await allocateContractIdsForInsertableRows(rows, {
    tableId: "cynet_health_deal_sheet",
    ...tableHolds({ 5139885: "CHC20908" }),
    ...runrateProposes("CHC20892"),
    ...NEVER_MINT,
  });

  assert.equal(rows[0].CONTRACT_ID, "CHC20908", "the id the placement already had must survive");
});

test("the same rule protects EXTENSION rows", async () => {
  // Extensions were previously excluded from the existing-id reuse entirely.
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      DEAL_SHEET_ID: 5256080,
      PLACEMENT_ID: 1465994,
      CANDIDATE_ID: 30947933,
      CLIENT_ID: 3702938,
      CANDIDATE_EMAIL: "piter_zebra@yahoo.com",
      CELL_PHONE: "(347) 881-7137",
      CONTRACT_ID: null,
    },
  ];

  await allocateContractIdsForInsertableRows(rows, {
    tableId: "cynet_health_deal_sheet",
    ...tableHolds({ 5256080: "CHC21529" }),
    ...runrateProposes("CHC99999"),
    ...NEVER_MINT,
  });

  assert.equal(rows[0].CONTRACT_ID, "CHC21529");
});

test("a placement with NO existing id still takes the run-rate match", async () => {
  // The matcher must stay fully functional for genuinely new placements — reuse-first must not
  // become reuse-only. Needs the fields buildLegacyContractLookupKey requires (a candidate, a
  // client, and at least one date), or no lookup key forms and the matcher is never consulted.
  const rows = [
    {
      DEAL_TYPE: "DEAL",
      DEAL_SHEET_ID: 7000001,
      PLACEMENT_ID: 1500001,
      CANDIDATE_ID: 42,
      INTERNAL_JOB_ID: 999001,
      CLIENT_ID: 7,
      NEXUS_PARENT_CLIENT_ID: 7,
      CANDIDATE_EMAIL: "new@example.com",
      CELL_PHONE: "555",
      START_DATE: "2026-05-01",
      FACILITY_NAME: "Some Facility",
      PARENT_CLIENT_NAME: "Some Health System",
      CONTRACT_ID: null,
    },
  ];

  await allocateContractIdsForInsertableRows(rows, {
    tableId: "cynet_health_deal_sheet",
    ...tableHolds({}),
    ...runrateProposes("CHC12345"),
    ...NEVER_MINT,
  });

  assert.equal(rows[0].CONTRACT_ID, "CHC12345");
});

test("a placement with neither an existing id nor a run-rate match mints a fresh one", async () => {
  const rows = [
    {
      DEAL_TYPE: "DEAL",
      DEAL_SHEET_ID: 7000002,
      PLACEMENT_ID: 1500002,
      CANDIDATE_ID: 43,
      CLIENT_ID: 8,
      CANDIDATE_EMAIL: "fresh@example.com",
      CELL_PHONE: "556",
      CONTRACT_ID: null,
    },
  ];

  await allocateContractIdsForInsertableRows(rows, {
    tableId: "cynet_health_deal_sheet",
    ...tableHolds({}),
    fetchLegacyContractIdentityFn: async () => new Map(),
    allocateContractIdsFn: async () => ["CHC30000"],
  });

  assert.equal(rows[0].CONTRACT_ID, "CHC30000");
});
