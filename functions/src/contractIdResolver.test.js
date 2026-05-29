const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveContractIdsForRows,
  allocateContractIdsForInsertableRows,
} = require("./contractIdResolver");

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
    allocateContractIdsFn: async () => {
      throw new Error("allocate should not be called");
    },
    fetchContractIdsByDealSheetIdsFn: async () => new Map(),
    fetchContractIdsForExtensionsFn: async () => new Map(),
    ...overrides,
  };
}

test("DEAL row allocates next id when no existing and no in-batch match", async () => {
  let allocated = 0;
  const rows = [row({ DEAL_TYPE: "DEAL", DEAL_SHEET_ID: 70001 })];
  await resolveContractIdsForRows(
    rows,
    noopDeps({
      allocateContractIdsFn: async (count) => {
        allocated = count;
        return [100000];
      },
    })
  );
  assert.equal(rows[0].CONTRACT_ID, 100000);
  assert.equal(allocated, 1);
});

test("DEAL re-sync reuses existing CONTRACT_ID by DEAL_SHEET_ID", async () => {
  let allocated = 0;
  const rows = [row({ DEAL_SHEET_ID: 70001 })];
  await resolveContractIdsForRows(
    rows,
    noopDeps({
      fetchContractIdsByDealSheetIdsFn: async () => new Map([["70001", 99999]]),
      allocateContractIdsFn: async (count) => {
        allocated = count;
        return [];
      },
    })
  );
  assert.equal(rows[0].CONTRACT_ID, 99999);
  assert.equal(allocated, 0);
});

test("DEAL + EXTENSION same batch reuses DEAL contract id without BQ extension lookup", async () => {
  let extLookupCalled = false;
  const rows = [
    row({ PLACEMENT_ID: 1437555, DEAL_TYPE: "DEAL", DEAL_SHEET_ID: 70001 }),
    row({
      PLACEMENT_ID: 1458621,
      DEAL_TYPE: "EXTENSION",
      DEAL_SHEET_ID: 70128,
      START_DATE: "2026-04-05",
    }),
  ];
  await resolveContractIdsForRows(
    rows,
    noopDeps({
      allocateContractIdsFn: async () => [100000],
      fetchContractIdsForExtensionsFn: async () => {
        extLookupCalled = true;
        return new Map();
      },
    })
  );
  assert.equal(rows[0].CONTRACT_ID, 100000);
  assert.equal(rows[1].CONTRACT_ID, 100000);
  assert.equal(extLookupCalled, false);
});

test("two DEALs same match key in batch allocate once and second reuses", async () => {
  let allocated = 0;
  const rows = [
    row({ DEAL_SHEET_ID: 70001, PLACEMENT_ID: 1000 }),
    row({ DEAL_SHEET_ID: 70002, PLACEMENT_ID: 1001 }),
  ];
  await resolveContractIdsForRows(
    rows,
    noopDeps({
      allocateContractIdsFn: async (count) => {
        allocated = count;
        return [100000];
      },
    })
  );
  assert.equal(allocated, 1);
  assert.equal(rows[0].CONTRACT_ID, 100000);
  assert.equal(rows[1].CONTRACT_ID, 100000);
});

test("two DEALs same candidate different CLIENT_ID get two allocations", async () => {
  let allocated = 0;
  const rows = [
    row({ DEAL_SHEET_ID: 70001, CLIENT_ID: 200 }),
    row({ DEAL_SHEET_ID: 70002, CLIENT_ID: 300 }),
  ];
  await resolveContractIdsForRows(
    rows,
    noopDeps({
      allocateContractIdsFn: async (count) => {
        allocated = count;
        return [100000, 100001];
      },
    })
  );
  assert.equal(allocated, 2);
  assert.equal(rows[0].CONTRACT_ID, 100000);
  assert.equal(rows[1].CONTRACT_ID, 100001);
});

test("EXTENSION uses BQ lookup when no in-batch DEAL", async () => {
  const rows = [
    row({
      PLACEMENT_ID: 1458621,
      DEAL_TYPE: "EXTENSION",
      DEAL_SHEET_ID: 70128,
    }),
  ];
  await resolveContractIdsForRows(
    rows,
    noopDeps({
      fetchContractIdsForExtensionsFn: async (input) => {
        assert.equal(input.length, 1);
        assert.equal(input[0].clientId, 200);
        return new Map([["1458621", 100050]]);
      },
    })
  );
  assert.equal(rows[0].CONTRACT_ID, 100050);
});

test("EXTENSION orphan leaves CONTRACT_ID null", async () => {
  const rows = [
    row({
      PLACEMENT_ID: 1458621,
      DEAL_TYPE: "EXTENSION",
      DEAL_SHEET_ID: 70128,
    }),
  ];
  await resolveContractIdsForRows(
    rows,
    noopDeps({
      fetchContractIdsForExtensionsFn: async () => new Map([["1458621", null]]),
    })
  );
  assert.equal(rows[0].CONTRACT_ID, null);
});

test("EXTENSION reuses existing CONTRACT_ID by DEAL_SHEET_ID", async () => {
  let extLookupCalled = false;
  const rows = [
    row({
      PLACEMENT_ID: 1458621,
      DEAL_TYPE: "EXTENSION",
      DEAL_SHEET_ID: 70128,
    }),
  ];
  await resolveContractIdsForRows(
    rows,
    noopDeps({
      fetchContractIdsByDealSheetIdsFn: async () => new Map([["70128", 88888]]),
      fetchContractIdsForExtensionsFn: async () => {
        extLookupCalled = true;
        return new Map();
      },
    })
  );
  assert.equal(rows[0].CONTRACT_ID, 88888);
  assert.equal(extLookupCalled, false);
});

test("EXTENSION without CANDIDATE_NEXUS_ID leaves CONTRACT_ID null", async () => {
  const rows = [
    row({
      PLACEMENT_ID: 1458621,
      DEAL_TYPE: "EXTENSION",
      CANDIDATE_NEXUS_ID: null,
    }),
  ];
  let extLookupCalled = false;
  await resolveContractIdsForRows(
    rows,
    noopDeps({
      fetchContractIdsForExtensionsFn: async () => {
        extLookupCalled = true;
        return new Map();
      },
    })
  );
  assert.equal(rows[0].CONTRACT_ID, null);
  assert.equal(extLookupCalled, false);
});

test("three DEALs needing ids get sequential allocation in row order", async () => {
  const rows = [
    row({ DEAL_SHEET_ID: 70001, CLIENT_ID: 201 }),
    row({ DEAL_SHEET_ID: 70002, CLIENT_ID: 202 }),
    row({ DEAL_SHEET_ID: 70003, CLIENT_ID: 203 }),
  ];
  await resolveContractIdsForRows(
    rows,
    noopDeps({
      allocateContractIdsFn: async (count) => {
        assert.equal(count, 3);
        return [100000, 100001, 100002];
      },
    })
  );
  assert.deepEqual(
    rows.map((r) => r.CONTRACT_ID),
    [100000, 100001, 100002]
  );
});

test("skipAllocation: DEAL needing new id stays null and Firestore is not touched", async () => {
  let allocateCalled = false;
  const rows = [row({ DEAL_TYPE: "DEAL", DEAL_SHEET_ID: 70001 })];
  await resolveContractIdsForRows(rows, {
    skipAllocation: true,
    allocateContractIdsFn: async () => {
      allocateCalled = true;
      return [100000];
    },
    fetchContractIdsByDealSheetIdsFn: async () => new Map(),
    fetchContractIdsForExtensionsFn: async () => new Map(),
  });
  assert.equal(rows[0].CONTRACT_ID, null);
  assert.equal(allocateCalled, false);
});

test("skipAllocation: existing BQ id is still reused (no allocation)", async () => {
  let allocateCalled = false;
  const rows = [row({ DEAL_TYPE: "DEAL", DEAL_SHEET_ID: 70001 })];
  await resolveContractIdsForRows(rows, {
    skipAllocation: true,
    allocateContractIdsFn: async () => {
      allocateCalled = true;
      return [];
    },
    fetchContractIdsByDealSheetIdsFn: async () => new Map([["70001", 99999]]),
    fetchContractIdsForExtensionsFn: async () => new Map(),
  });
  assert.equal(rows[0].CONTRACT_ID, 99999);
  assert.equal(allocateCalled, false);
});

test("skipAllocation: EXTENSION still resolved via BQ lookup (no allocation)", async () => {
  let allocateCalled = false;
  const rows = [
    row({ DEAL_TYPE: "EXTENSION", PLACEMENT_ID: 1458621, DEAL_SHEET_ID: 70128 }),
  ];
  await resolveContractIdsForRows(rows, {
    skipAllocation: true,
    allocateContractIdsFn: async () => {
      allocateCalled = true;
      return [];
    },
    fetchContractIdsByDealSheetIdsFn: async () => new Map(),
    fetchContractIdsForExtensionsFn: async () => new Map([["1458621", 100050]]),
  });
  assert.equal(rows[0].CONTRACT_ID, 100050);
  assert.equal(allocateCalled, false);
});

test("allocateContractIdsForInsertableRows: allocates only for rows passed in", async () => {
  let allocatedCount = 0;
  const rows = [row({ DEAL_TYPE: "DEAL", DEAL_SHEET_ID: 70001 })];
  await allocateContractIdsForInsertableRows(rows, {
    allocateContractIdsFn: async (count) => {
      allocatedCount = count;
      return [101040];
    },
  });
  assert.equal(allocatedCount, 1);
  assert.equal(rows[0].CONTRACT_ID, 101040);
});

test("allocateContractIdsForInsertableRows: leaves rows already having CONTRACT_ID untouched", async () => {
  let allocateCalled = false;
  const rows = [row({ DEAL_TYPE: "DEAL", DEAL_SHEET_ID: 70001, CONTRACT_ID: 99999 })];
  await allocateContractIdsForInsertableRows(rows, {
    allocateContractIdsFn: async () => {
      allocateCalled = true;
      return [];
    },
  });
  assert.equal(allocateCalled, false);
  assert.equal(rows[0].CONTRACT_ID, 99999);
});

test("allocateContractIdsForInsertableRows: groups DEALs by match key and allocates one id per key", async () => {
  let allocatedCount = 0;
  const rows = [
    row({ DEAL_SHEET_ID: 70001, PLACEMENT_ID: 1000 }),
    row({ DEAL_SHEET_ID: 70002, PLACEMENT_ID: 1001 }),
    row({ DEAL_SHEET_ID: 70003, PLACEMENT_ID: 1002, CLIENT_ID: 999 }),
  ];
  await allocateContractIdsForInsertableRows(rows, {
    allocateContractIdsFn: async (count) => {
      allocatedCount = count;
      return [101040, 101041];
    },
  });
  assert.equal(allocatedCount, 2);
  assert.equal(rows[0].CONTRACT_ID, 101040);
  assert.equal(rows[1].CONTRACT_ID, 101040);
  assert.equal(rows[2].CONTRACT_ID, 101041);
});

test("allocateContractIdsForInsertableRows: propagates new DEAL id to in-batch EXTENSION via match key", async () => {
  const rows = [
    row({ DEAL_TYPE: "DEAL", DEAL_SHEET_ID: 70001, PLACEMENT_ID: 1000 }),
    row({
      DEAL_TYPE: "EXTENSION",
      DEAL_SHEET_ID: 70002,
      PLACEMENT_ID: 2000,
      START_DATE: "2026-04-05",
    }),
  ];
  await allocateContractIdsForInsertableRows(rows, {
    allocateContractIdsFn: async () => [101040],
  });
  assert.equal(rows[0].CONTRACT_ID, 101040);
  assert.equal(rows[1].CONTRACT_ID, 101040);
});

test("allocateContractIdsForInsertableRows: empty/no-allocation batches do not call Firestore", async () => {
  let allocateCalled = false;
  const rows = [row({ DEAL_TYPE: "DEAL", DEAL_SHEET_ID: 70001, CONTRACT_ID: 100200 })];
  await allocateContractIdsForInsertableRows(rows, {
    allocateContractIdsFn: async () => {
      allocateCalled = true;
      return [];
    },
  });
  assert.equal(allocateCalled, false);
});

test("end-to-end: Phase A (skipAllocation) + Phase B mimics single-pass output for new DEAL+EXTENSION batch", async () => {
  const rows = [
    row({ DEAL_TYPE: "DEAL", DEAL_SHEET_ID: 70001, PLACEMENT_ID: 1000 }),
    row({
      DEAL_TYPE: "EXTENSION",
      DEAL_SHEET_ID: 70002,
      PLACEMENT_ID: 2000,
      START_DATE: "2026-04-05",
    }),
  ];
  await resolveContractIdsForRows(rows, {
    skipAllocation: true,
    fetchContractIdsByDealSheetIdsFn: async () => new Map(),
    fetchContractIdsForExtensionsFn: async () => new Map(),
  });
  assert.equal(rows[0].CONTRACT_ID, null);
  assert.equal(rows[1].CONTRACT_ID, null);

  await allocateContractIdsForInsertableRows(rows, {
    allocateContractIdsFn: async () => [101040],
  });
  assert.equal(rows[0].CONTRACT_ID, 101040);
  assert.equal(rows[1].CONTRACT_ID, 101040);
});

test("end-to-end: Phase B does NOT allocate when DEAL is filtered out of insert batch (EXTENSION-only stays null)", async () => {
  // Simulate: enricher produced 2 rows, but the append-on-change filter
  // dropped the DEAL row. Only EXTENSION reaches Phase B.
  const dealRow = row({ DEAL_TYPE: "DEAL", DEAL_SHEET_ID: 70001, PLACEMENT_ID: 1000 });
  const extRow = row({
    DEAL_TYPE: "EXTENSION",
    DEAL_SHEET_ID: 70002,
    PLACEMENT_ID: 2000,
    START_DATE: "2026-04-05",
  });

  await resolveContractIdsForRows([dealRow, extRow], {
    skipAllocation: true,
    fetchContractIdsByDealSheetIdsFn: async () => new Map(),
    fetchContractIdsForExtensionsFn: async () => new Map(),
  });

  // Caller filters out the DEAL row; only EXTENSION goes into Phase B.
  let allocateCalled = false;
  await allocateContractIdsForInsertableRows([extRow], {
    allocateContractIdsFn: async () => {
      allocateCalled = true;
      return [];
    },
  });

  // No DEAL with null id present, so allocator does nothing — this avoids
  // burning an id when the DEAL won't actually be inserted.
  assert.equal(allocateCalled, false);
  assert.equal(extRow.CONTRACT_ID, null);
});

test("extension picks latest DEAL contract on or before start when multiple DEAL entries in batch map", async () => {
  const rows = [
    row({ PLACEMENT_ID: 1000, DEAL_TYPE: "DEAL", START_DATE: "2024-01-05", DEAL_SHEET_ID: 70001 }),
    row({ PLACEMENT_ID: 3000, DEAL_TYPE: "DEAL", START_DATE: "2026-03-01", DEAL_SHEET_ID: 70002, CLIENT_ID: 201 }),
    row({
      PLACEMENT_ID: 3100,
      DEAL_TYPE: "EXTENSION",
      START_DATE: "2027-01-01",
      DEAL_SHEET_ID: 70003,
      CLIENT_ID: 200,
    }),
  ];
  await resolveContractIdsForRows(
    rows,
    noopDeps({
      allocateContractIdsFn: async (count) => {
        const ids = [];
        for (let i = 0; i < count; i++) ids.push(100000 + i);
        return ids;
      },
    })
  );
  assert.equal(rows[0].CONTRACT_ID, 100000);
  assert.equal(rows[1].CONTRACT_ID, 100001);
  assert.equal(rows[2].CONTRACT_ID, 100000);
});
