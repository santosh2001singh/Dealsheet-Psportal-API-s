const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyLegacyContractIdentityToDealRows,
} = require("./contractIdResolver");
const { buildLegacyContractLookupKey } = require("./bigQueryClient");

/**
 * A DEAL row already tracked in the legacy run-rate table must keep that CONTRACT_ID instead of
 * minting a second id for the same contract. Fixtures mirror the real Nexus/run-rate pair that
 * exposed this: run-rate CHC22144 vs the freshly minted CHC23016.
 */

function dealRow(overrides = {}) {
  return {
    DEAL_TYPE: "DEAL",
    PLACEMENT_STATUS: "STARTED",
    DEAL_SHEET_ID: 5213876,
    PLACEMENT_ID: 1457038,
    CANDIDATE_ID: 8629683,
    INTERNAL_JOB_ID: 35450411,
    CANDIDATE_EMAIL: "wesbyq@aol.com",
    START_DATE: "2026-06-01",
    CONTRACT_ID: null,
    SKU_NUMBER: null,
    ...overrides,
  };
}

/** Stub standing in for the BigQuery run-rate lookup. */
function fetchStub(entries, spy) {
  return async (rows, options) => {
    if (spy) spy.push({ rowCount: rows.length, options });
    return new Map(entries);
  };
}

test("buildLegacyContractLookupKey: builds all three tiers when the row has full identity", () => {
  const key = buildLegacyContractLookupKey(dealRow({ VMS_JOB_ID: "1092950" }));
  assert.equal(key.nexusKey, "8629683|35450411");
  assert.equal(key.emailKey, "wesbyq@aol.com|2026-06-01");
  assert.equal(key.vmsKey, "8629683|1092950");
  assert.equal(key.rowKey, "ds:5213876");
});

test("buildLegacyContractLookupKey: no VMS_JOB_ID leaves the tier 3 key null", () => {
  assert.equal(buildLegacyContractLookupKey(dealRow()).vmsKey, null);
});

test("buildLegacyContractLookupKey: VMS key alone is enough to attempt a lookup", () => {
  const key = buildLegacyContractLookupKey(
    dealRow({ INTERNAL_JOB_ID: null, CANDIDATE_EMAIL: null, VMS_JOB_ID: "1092950" })
  );
  assert.equal(key.nexusKey, null);
  assert.equal(key.emailKey, null);
  assert.equal(key.vmsKey, "8629683|1092950");
});

test("buildLegacyContractLookupKey: tier 4 range key needs only candidate id + start date", () => {
  const key = buildLegacyContractLookupKey(
    dealRow({ INTERNAL_JOB_ID: null, CANDIDATE_EMAIL: null, VMS_JOB_ID: null })
  );
  assert.equal(key.nexusKey, null);
  assert.equal(key.emailKey, null);
  assert.equal(key.vmsKey, null);
  assert.equal(key.rangeKey, "8629683|2026-06-01", "candidate + start date still keys tier 4");
});

test("buildLegacyContractLookupKey: no candidate id leaves every key null", () => {
  assert.equal(
    buildLegacyContractLookupKey(
      dealRow({ CANDIDATE_ID: null, INTERNAL_JOB_ID: null, VMS_JOB_ID: null })
    )?.rangeKey ?? null,
    null
  );
});

test("buildLegacyContractLookupKey: a malformed START_DATE cannot form the range key", () => {
  const key = buildLegacyContractLookupKey(
    dealRow({ INTERNAL_JOB_ID: null, CANDIDATE_EMAIL: null, VMS_JOB_ID: null, START_DATE: "06/01/2026" })
  );
  assert.equal(key, null);
});

test("buildLegacyContractLookupKey: tier 2 only when Nexus ids are missing", () => {
  const key = buildLegacyContractLookupKey(
    dealRow({ CANDIDATE_ID: null, INTERNAL_JOB_ID: null })
  );
  assert.equal(key.nexusKey, null);
  assert.equal(key.emailKey, "wesbyq@aol.com|2026-06-01");
});

test("buildLegacyContractLookupKey: null when nothing usable is present", () => {
  const key = buildLegacyContractLookupKey(
    dealRow({ CANDIDATE_ID: null, INTERNAL_JOB_ID: null, CANDIDATE_EMAIL: null })
  );
  assert.equal(key, null);
});

test("buildLegacyContractLookupKey: a malformed START_DATE cannot form the email key", () => {
  const key = buildLegacyContractLookupKey(
    dealRow({ CANDIDATE_ID: null, INTERNAL_JOB_ID: null, START_DATE: "06/01/2026" })
  );
  assert.equal(key, null);
});

test("buildLegacyContractLookupKey: falls back to PLACEMENT_ID when no deal sheet id", () => {
  const key = buildLegacyContractLookupKey(dealRow({ DEAL_SHEET_ID: null }));
  assert.equal(key.rowKey, "pl:1457038");
});

test("legacy CONTRACT_ID is reused instead of minting a new one", async () => {
  const row = dealRow();
  const reused = await applyLegacyContractIdentityToDealRows([row], {
    tableId: "cynet_health_deal_sheet",
    fetchLegacyContractIdentityFn: fetchStub([
      ["ds:5213876", { CONTRACT_ID: "CHC22144", SKU_NUMBER: "H134597_H15175" }],
    ]),
  });
  assert.equal(reused, 1);
  assert.equal(row.CONTRACT_ID, "CHC22144");
  assert.equal(row.SKU_NUMBER, "H134597_H15175");
});

test("a run-rate row with no SKU leaves SKU_NUMBER null (never blanks a real one)", async () => {
  const row = dealRow();
  await applyLegacyContractIdentityToDealRows([row], {
    tableId: "cynet_health_deal_sheet",
    fetchLegacyContractIdentityFn: fetchStub([
      ["ds:5213876", { CONTRACT_ID: "CHC22144", SKU_NUMBER: null }],
    ]),
  });
  assert.equal(row.CONTRACT_ID, "CHC22144");
  assert.equal(row.SKU_NUMBER, null);
});

test("an existing SKU_NUMBER on the row is never overwritten", async () => {
  const row = dealRow({ SKU_NUMBER: "H99999" });
  await applyLegacyContractIdentityToDealRows([row], {
    tableId: "cynet_health_deal_sheet",
    fetchLegacyContractIdentityFn: fetchStub([
      ["ds:5213876", { CONTRACT_ID: "CHC22144", SKU_NUMBER: "H134597_H15175" }],
    ]),
  });
  assert.equal(row.SKU_NUMBER, "H99999");
});

test("no run-rate match leaves CONTRACT_ID null so Firestore mints a fresh id", async () => {
  const row = dealRow();
  const reused = await applyLegacyContractIdentityToDealRows([row], {
    tableId: "cynet_health_deal_sheet",
    fetchLegacyContractIdentityFn: fetchStub([]),
  });
  assert.equal(reused, 0);
  assert.equal(row.CONTRACT_ID, null);
});

test("a row that already has a CONTRACT_ID is left untouched", async () => {
  const row = dealRow({ CONTRACT_ID: "CHC23016" });
  await applyLegacyContractIdentityToDealRows([row], {
    tableId: "cynet_health_deal_sheet",
    fetchLegacyContractIdentityFn: fetchStub([
      ["ds:5213876", { CONTRACT_ID: "CHC22144", SKU_NUMBER: "H1" }],
    ]),
  });
  assert.equal(row.CONTRACT_ID, "CHC23016");
});

test("a lookup failure is non-fatal — rows fall through to a minted id", async () => {
  const row = dealRow();
  const reused = await applyLegacyContractIdentityToDealRows([row], {
    tableId: "cynet_health_deal_sheet",
    fetchLegacyContractIdentityFn: async () => {
      throw new Error("BigQuery unavailable");
    },
  });
  assert.equal(reused, 0);
  assert.equal(row.CONTRACT_ID, null);
});

test("the destination table is forwarded so the right domain run-rate table is queried", async () => {
  const spy = [];
  await applyLegacyContractIdentityToDealRows([dealRow()], {
    tableId: "cynet_locums_deal_sheet",
    fetchLegacyContractIdentityFn: fetchStub([], spy),
  });
  assert.equal(spy[0].options.tableId, "cynet_locums_deal_sheet");
});

test("only the rows that matched take a legacy id; the rest stay null", async () => {
  const matched = dealRow();
  const unmatched = dealRow({
    DEAL_SHEET_ID: 9999999,
    CANDIDATE_ID: 111,
    INTERNAL_JOB_ID: 222,
    CANDIDATE_EMAIL: "new.hire@example.com",
  });
  const reused = await applyLegacyContractIdentityToDealRows([matched, unmatched], {
    tableId: "cynet_health_deal_sheet",
    fetchLegacyContractIdentityFn: fetchStub([
      ["ds:5213876", { CONTRACT_ID: "CHC22144", SKU_NUMBER: null }],
    ]),
  });
  assert.equal(reused, 1);
  assert.equal(matched.CONTRACT_ID, "CHC22144");
  assert.equal(unmatched.CONTRACT_ID, null);
});

// A DID NOT START / DID NOT ACCEPT placement never became a working assignment, so it takes the
// legacy CONTRACT_ID (contract identity) but never the legacy SKU_NUMBER (assignment identity).
for (const status of ["DID NOT START", "DID NOT ACCEPT", "did not start"]) {
  test(`PLACEMENT_STATUS "${status}" takes CONTRACT_ID but not SKU_NUMBER`, async () => {
    const row = dealRow({ PLACEMENT_STATUS: status });
    await applyLegacyContractIdentityToDealRows([row], {
      tableId: "cynet_health_deal_sheet",
      fetchLegacyContractIdentityFn: fetchStub([
        ["ds:5213876", { CONTRACT_ID: "CHC22754", SKU_NUMBER: "ONB7016" }],
      ]),
    });
    assert.equal(row.CONTRACT_ID, "CHC22754");
    assert.equal(row.SKU_NUMBER, null);
  });
}

for (const status of ["STARTED", "BOOKED", "ENDED", "ENDED<30"]) {
  test(`PLACEMENT_STATUS "${status}" still takes the legacy SKU_NUMBER`, async () => {
    const row = dealRow({ PLACEMENT_STATUS: status });
    await applyLegacyContractIdentityToDealRows([row], {
      tableId: "cynet_health_deal_sheet",
      fetchLegacyContractIdentityFn: fetchStub([
        ["ds:5213876", { CONTRACT_ID: "CHC22754", SKU_NUMBER: "ONB7016" }],
      ]),
    });
    assert.equal(row.SKU_NUMBER, "ONB7016");
  });
}

test("a DID NOT START row keeps a SKU it already had (fill-if-empty, never clears)", async () => {
  const row = dealRow({ PLACEMENT_STATUS: "DID NOT START", SKU_NUMBER: "H12345" });
  await applyLegacyContractIdentityToDealRows([row], {
    tableId: "cynet_health_deal_sheet",
    fetchLegacyContractIdentityFn: fetchStub([
      ["ds:5213876", { CONTRACT_ID: "CHC22754", SKU_NUMBER: "ONB7016" }],
    ]),
  });
  assert.equal(row.SKU_NUMBER, "H12345");
});

test("empty input short-circuits without calling BigQuery", async () => {
  let called = false;
  const reused = await applyLegacyContractIdentityToDealRows([], {
    tableId: "cynet_health_deal_sheet",
    fetchLegacyContractIdentityFn: async () => {
      called = true;
      return new Map();
    },
  });
  assert.equal(reused, 0);
  assert.equal(called, false);
});
