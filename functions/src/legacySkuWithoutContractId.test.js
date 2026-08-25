const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyLegacyContractIdentityToDealRows,
} = require("./contractIdResolver");

/**
 * A matched run-rate row may carry a SKU and the manual ops columns but NO CONTRACT_ID.
 *
 * The whole canada run-rate table is exactly that shape: 0 of 620 rows have a contract id, while
 * 498 have a SKU. The resolver used to `continue` as soon as the contract id was missing, so every
 * canada row landed with a blank SKU_NUMBER / ENTITY / CLIENT_RECRUITER / TYPE_OF_CLIENT even
 * though it matched a run-rate row cleanly — 240 rows should have had a SKU, only 2 did.
 */

/** Deal row shaped like a real canada placement. */
function dealRow(overrides) {
  return {
    DEAL_TYPE: "DEAL",
    CANDIDATE_ID: 31062757,
    CANDIDATE_EMAIL: "someone@example.com",
    FACILITY_NAME: "Elk Valley Hospital",
    PARENT_CLIENT_NAME: "Interior Health Authority",
    START_DATE: "2026-06-29",
    TENTATIVE_END_DATE: "2026-09-15",
    PLACEMENT_STATUS: "STARTED",
    ...overrides,
  };
}

/** A fetch stub that answers every lookup with the same legacy identity. */
function identityStub(identity) {
  return async () => ({ get: () => identity, size: 1 });
}

test("a legacy row with NO contract id still fills SKU and manual columns", () => {
  const rows = [dealRow()];
  return applyLegacyContractIdentityToDealRows(rows, {
    tableId: "cynet_health_canada_deal_sheet",
    fetchLegacyContractIdentityFn: identityStub({
      CONTRACT_ID: null,
      SKU_NUMBER: "CH1458",
      ENTITY: "CANADA HEALTH",
      CLIENT_RECRUITER: "Sophie Fehst",
      TYPE_OF_CLIENT: "Canada Government",
    }),
  }).then(() => {
    assert.equal(rows[0].SKU_NUMBER, "CH1458");
    assert.equal(rows[0].ENTITY, "CANADA HEALTH");
    assert.equal(rows[0].CLIENT_RECRUITER, "Sophie Fehst");
    assert.equal(rows[0].TYPE_OF_CLIENT, "Canada Government");
    // No contract id on the legacy row means none is reused — one is minted later instead.
    assert.equal(rows[0].CONTRACT_ID, undefined);
  });
});

test("a legacy row WITH a contract id behaves exactly as before", async () => {
  const rows = [dealRow()];
  await applyLegacyContractIdentityToDealRows(rows, {
    tableId: "cynet_health_deal_sheet",
    fetchLegacyContractIdentityFn: identityStub({
      CONTRACT_ID: "CHC22144",
      SKU_NUMBER: "CH999",
      ENTITY: "CYNET HEALTH",
    }),
  });
  assert.equal(rows[0].CONTRACT_ID, "CHC22144");
  assert.equal(rows[0].SKU_NUMBER, "CH999");
  assert.equal(rows[0].ENTITY, "CYNET HEALTH");
});

test("no match at all leaves the row untouched", async () => {
  const rows = [dealRow()];
  await applyLegacyContractIdentityToDealRows(rows, {
    tableId: "cynet_health_canada_deal_sheet",
    fetchLegacyContractIdentityFn: async () => ({ get: () => undefined, size: 1 }),
  });
  assert.equal(rows[0].SKU_NUMBER, undefined);
  assert.equal(rows[0].CONTRACT_ID, undefined);
  assert.equal(rows[0].ENTITY, undefined);
});

test("a row that already has a contract id is skipped entirely", async () => {
  // Ids are immutable: a row that took one earlier in the chain must not be re-derived.
  const rows = [dealRow({ CONTRACT_ID: "CAC1043" })];
  await applyLegacyContractIdentityToDealRows(rows, {
    tableId: "cynet_health_canada_deal_sheet",
    fetchLegacyContractIdentityFn: identityStub({ CONTRACT_ID: null, SKU_NUMBER: "CH1458" }),
  });
  assert.equal(rows[0].CONTRACT_ID, "CAC1043");
  assert.equal(rows[0].SKU_NUMBER, undefined, "skipped rows are not touched");
});

test("SKU is withheld from placements that never ran", async () => {
  // DID NOT START / DID NOT ACCEPT never became a working assignment, so no SKU — but the manual
  // ops columns still describe the contract and must come across.
  for (const status of ["DID NOT START", "DID NOT ACCEPT"]) {
    const rows = [dealRow({ PLACEMENT_STATUS: status })];
    await applyLegacyContractIdentityToDealRows(rows, {
      tableId: "cynet_health_canada_deal_sheet",
      fetchLegacyContractIdentityFn: identityStub({
        CONTRACT_ID: null,
        SKU_NUMBER: "CH1458",
        ENTITY: "CANADA HEALTH",
      }),
    });
    assert.equal(rows[0].SKU_NUMBER, undefined, status);
    assert.equal(rows[0].ENTITY, "CANADA HEALTH", `${status} still gets manual columns`);
  }
});

test("manual columns are fill-if-empty; an existing value wins", async () => {
  const rows = [dealRow({ ENTITY: "HAND EDITED" })];
  await applyLegacyContractIdentityToDealRows(rows, {
    tableId: "cynet_health_canada_deal_sheet",
    fetchLegacyContractIdentityFn: identityStub({
      CONTRACT_ID: null,
      ENTITY: "CANADA HEALTH",
      CLIENT_RECRUITER: "Sophie Fehst",
    }),
  });
  assert.equal(rows[0].ENTITY, "HAND EDITED", "a value already on the row is never overwritten");
  assert.equal(rows[0].CLIENT_RECRUITER, "Sophie Fehst", "blank columns are still filled");
});

test("blank legacy values do not overwrite anything", async () => {
  const rows = [dealRow()];
  await applyLegacyContractIdentityToDealRows(rows, {
    tableId: "cynet_health_canada_deal_sheet",
    fetchLegacyContractIdentityFn: identityStub({
      CONTRACT_ID: null,
      SKU_NUMBER: "   ",
      ENTITY: "",
      CLIENT_RECRUITER: null,
    }),
  });
  assert.equal(rows[0].SKU_NUMBER, undefined);
  assert.equal(rows[0].ENTITY, undefined);
  assert.equal(rows[0].CLIENT_RECRUITER, undefined);
});

// --------------------------------------------------------------------------
// The SQL side of the same bug.
//
// Fixing the JS apply loop was not enough: the lookup QUERY also required a contract id, so canada
// rows never came back from BigQuery at all. Live check at the time: the old predicate matched 0
// deal rows, the fixed one matches 209 — every one of which has a SKU.
// --------------------------------------------------------------------------

const fs = require("node:fs");
const path = require("node:path");

const BQ_SRC = fs.readFileSync(path.join(__dirname, "bigQueryClient.js"), "utf8");

test("the legacy lookup accepts a run-rate row with a SKU but no contract id", () => {
  // Both tiers (span-key and nexus-key) must allow it.
  const guarded = BQ_SRC.match(
    /\(r\.CONTRACT_ID IS NOT NULL AND TRIM\(r\.CONTRACT_ID\) != ''\)\s*\n\s*OR \(r\.SKU_NUMBER IS NOT NULL AND TRIM\(r\.SKU_NUMBER\) != ''\)/g
  );
  assert.equal(guarded?.length, 2, "both lookup tiers must accept SKU-only rows");
});

test("no lookup tier still requires a contract id on its own", () => {
  // The exact old predicate must be gone — it filtered every canada row out.
  assert.ok(
    !/WHERE r\.CONTRACT_ID IS NOT NULL AND TRIM\(r\.CONTRACT_ID\) != ''/.test(BQ_SRC),
    "a bare contract-id requirement would zero out canada again"
  );
});
