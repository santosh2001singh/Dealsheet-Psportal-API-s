// CONTRACT_ID is minted for DEAL_TYPE='DEAL' rows only (Aug 2026), mirroring how SKU_NUMBER works:
// an EXTENSION inherits its id down the contract chain and never generates one. Before this, a
// run-rate-matched EXTENSION with no resolvable parent would mint a fresh id, producing standalone
// CONTRACT_IDs that no DEAL row ever shared.
//
// These tests pin the invariant on both allocation paths in contractIdResolver.js.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveContractIdsForRows,
  allocateContractIdsForInsertableRows,
} = require("./contractIdResolver");

const SEQUENCE_OPTIONS = { docId: "cynet_health_deal_sheet", prefix: "CHC", startValue: 23000 };

function makeRow(overrides = {}) {
  return {
    DEAL_TYPE: "DEAL",
    DEAL_SHEET_ID: 1,
    PLACEMENT_ID: 1,
    CANDIDATE_ID: 111,
    CLIENT_ID: 55,
    CANDIDATE_EMAIL: "a@x.com",
    CELL_PHONE: "555",
    START_DATE: "2026-01-01",
    ...overrides,
  };
}

/** Records how many ids were requested so a test can assert "nothing was minted". */
function makeAllocator(state) {
  return async (count) => {
    state.calls++;
    state.requested += count;
    return Array.from({ length: count }, (_, i) => `CHC${23000 + i}`);
  };
}

const emptyDealSheetIdFetch = { fetchContractIdsByDealSheetIdsFn: async () => new Map() };

test("Phase B allocates for a DEAL row", async () => {
  const state = { calls: 0, requested: 0 };
  const rows = [makeRow()];

  await allocateContractIdsForInsertableRows(rows, {
    sequenceOptions: SEQUENCE_OPTIONS,
    allocateContractIdsFn: makeAllocator(state),
    ...emptyDealSheetIdFetch,
  });

  assert.equal(rows[0].CONTRACT_ID, "CHC23000");
  assert.equal(state.requested, 1);
});

test("Phase B never allocates for an EXTENSION row", async () => {
  const state = { calls: 0, requested: 0 };
  const rows = [makeRow({ DEAL_TYPE: "EXTENSION", CONTRACT_ID: null })];

  await allocateContractIdsForInsertableRows(rows, {
    sequenceOptions: SEQUENCE_OPTIONS,
    allocateContractIdsFn: makeAllocator(state),
    ...emptyDealSheetIdFetch,
  });

  assert.equal(rows[0].CONTRACT_ID, null);
  assert.equal(state.calls, 0, "no allocation call should be made for EXTENSION-only batches");
});

test("Phase B allocates only for the DEAL rows in a mixed batch", async () => {
  const state = { calls: 0, requested: 0 };
  const dealRow = makeRow({ DEAL_SHEET_ID: 1, PLACEMENT_ID: 1 });
  const extensionRow = makeRow({
    DEAL_TYPE: "EXTENSION",
    DEAL_SHEET_ID: 2,
    PLACEMENT_ID: 2,
    // Different identity, so it cannot inherit from the DEAL row above either.
    CANDIDATE_ID: 999,
    CLIENT_ID: 88,
    CONTRACT_ID: null,
  });
  const rows = [dealRow, extensionRow];

  await allocateContractIdsForInsertableRows(rows, {
    sequenceOptions: SEQUENCE_OPTIONS,
    allocateContractIdsFn: makeAllocator(state),
    ...emptyDealSheetIdFetch,
  });

  assert.equal(dealRow.CONTRACT_ID, "CHC23000");
  assert.equal(extensionRow.CONTRACT_ID, null);
  assert.equal(state.requested, 1, "exactly one id for the one DEAL row");
});

test("Phase B leaves an already-set CONTRACT_ID alone", async () => {
  const state = { calls: 0, requested: 0 };
  const rows = [makeRow({ CONTRACT_ID: "CHC12345" })];

  await allocateContractIdsForInsertableRows(rows, {
    sequenceOptions: SEQUENCE_OPTIONS,
    allocateContractIdsFn: makeAllocator(state),
    ...emptyDealSheetIdFetch,
  });

  assert.equal(rows[0].CONTRACT_ID, "CHC12345");
  assert.equal(state.calls, 0);
});

test("Phase A with skipAllocation defers instead of minting", async () => {
  const state = { calls: 0, requested: 0 };
  const rows = [makeRow()];

  await resolveContractIdsForRows(rows, {
    skipAllocation: true,
    sequenceOptions: SEQUENCE_OPTIONS,
    allocateContractIdsFn: makeAllocator(state),
    fetchContractIdsByDealSheetIdsFn: async () => new Map(),
    fetchContractIdsForExtensionsFn: async () => new Map(),
  });

  assert.equal(rows[0].CONTRACT_ID, null);
  assert.equal(state.calls, 0, "skipAllocation must defer every mint to Phase B");
});

test("Phase A never mints for an EXTENSION, even with allocation enabled", async () => {
  const state = { calls: 0, requested: 0 };
  const rows = [makeRow({ DEAL_TYPE: "EXTENSION" })];

  await resolveContractIdsForRows(rows, {
    sequenceOptions: SEQUENCE_OPTIONS,
    allocateContractIdsFn: makeAllocator(state),
    fetchContractIdsByDealSheetIdsFn: async () => new Map(),
    // Nothing to inherit from anywhere.
    fetchContractIdsForExtensionsFn: async () => new Map(),
  });

  assert.equal(rows[0].CONTRACT_ID ?? null, null);
  assert.equal(state.calls, 0, "EXTENSION rows must never mint a CONTRACT_ID");
});

test("an EXTENSION still inherits an existing id from BigQuery", async () => {
  const state = { calls: 0, requested: 0 };
  const rows = [makeRow({ DEAL_TYPE: "EXTENSION", PLACEMENT_ID: 7 })];

  await resolveContractIdsForRows(rows, {
    sequenceOptions: SEQUENCE_OPTIONS,
    allocateContractIdsFn: makeAllocator(state),
    fetchContractIdsByDealSheetIdsFn: async () => new Map(),
    fetchContractIdsForExtensionsFn: async () => new Map([["7", "CHC23456"]]),
  });

  assert.equal(rows[0].CONTRACT_ID, "CHC23456");
  assert.equal(state.calls, 0);
});

test("an in-batch EXTENSION inherits from its parent DEAL, not a fresh id", async () => {
  const state = { calls: 0, requested: 0 };
  // Same candidate+client identity, so the EXTENSION matches the DEAL in-batch.
  const dealRow = makeRow({ DEAL_SHEET_ID: 1, PLACEMENT_ID: 1, START_DATE: "2026-01-01" });
  const extensionRow = makeRow({
    DEAL_TYPE: "EXTENSION",
    DEAL_SHEET_ID: 2,
    PLACEMENT_ID: 2,
    START_DATE: "2026-06-01",
  });
  const rows = [dealRow, extensionRow];

  await resolveContractIdsForRows(rows, {
    sequenceOptions: SEQUENCE_OPTIONS,
    allocateContractIdsFn: makeAllocator(state),
    fetchContractIdsByDealSheetIdsFn: async () => new Map(),
    fetchContractIdsForExtensionsFn: async () => new Map(),
  });

  assert.equal(dealRow.CONTRACT_ID, "CHC23000");
  assert.equal(extensionRow.CONTRACT_ID, "CHC23000", "extension shares its parent DEAL's id");
  assert.equal(state.requested, 1, "one id for the DEAL; the extension inherited it");
});

test("Phase B reuses existing CONTRACT_ID from BigQuery by DEAL_SHEET_ID and does not mint", async () => {
  const state = { calls: 0, requested: 0 };
  const rows = [makeRow({ DEAL_SHEET_ID: 5102931, CONTRACT_ID: null })];

  await allocateContractIdsForInsertableRows(rows, {
    sequenceOptions: SEQUENCE_OPTIONS,
    allocateContractIdsFn: makeAllocator(state),
    fetchContractIdsByDealSheetIdsFn: async () => new Map([["5102931", "CHC23325"]]),
  });

  assert.equal(rows[0].CONTRACT_ID, "CHC23325");
  assert.equal(state.calls, 0, "must not mint when BQ already has a CONTRACT_ID for this deal sheet");
});

test("Phase B still mints when BigQuery has no CONTRACT_ID for the deal sheet", async () => {
  const state = { calls: 0, requested: 0 };
  const rows = [makeRow({ DEAL_SHEET_ID: 9999999, CONTRACT_ID: null })];

  await allocateContractIdsForInsertableRows(rows, {
    sequenceOptions: SEQUENCE_OPTIONS,
    allocateContractIdsFn: makeAllocator(state),
    fetchContractIdsByDealSheetIdsFn: async () => new Map(),
  });

  assert.equal(rows[0].CONTRACT_ID, "CHC23000");
  assert.equal(state.requested, 1);
});
