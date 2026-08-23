const test = require("node:test");
const assert = require("node:assert/strict");

const {
  insertContractChainOwnershipLogsForInsertedRows,
  buildContractOwnershipChangeLogRows,
  OWNERSHIP_CHANGE_REASON_CONTRACT_CHAIN,
} = require("./bigQueryClient");

/**
 * The Abigail Cleary shape that motivated this: a run-rate segment already in BigQuery, and an
 * EXTENSION on the same CONTRACT_ID inserted now with a different ONSITE_AM / LEVEL_2_CSM.
 */
function storedSegment(overrides) {
  return {
    DEAL_SHEET_ID: 900,
    PLACEMENT_ID: "1400000",
    CONTRACT_ID: "CHC22109",
    SKU_NUMBER: "H134596_H15172",
    CANDIDATE_NAME: "Abigail Cleary",
    CANDIDATE_EMAIL: "clearyabbey@gmail.com",
    START_DATE: "2026-05-25",
    TENTATIVE_END_DATE: "2026-08-22",
    ASSIGNMENT_RECRUITER: "Mac Singh",
    ASSIGNMENT_RECRUITER_EMAIL: "mac.s@cynethealth.com",
    RECRUITER_EMP_NO: "CY4193",
    ONSITE_AM: "Arjay Gabriel",
    ONSITE_AM_EMAIL: "arjay.g@cynethealth.com",
    LEVEL_2_CSM: "Katie Nubel",
    LEVEL_3_CSM: null,
    LEVEL_4_CSM: null,
    ...overrides,
  };
}

function insertedSegment(overrides) {
  return {
    DEAL_SHEET_ID: 5260086,
    PLACEMENT_ID: "1466877",
    CONTRACT_ID: "CHC22109",
    SKU_NUMBER: "H134596_H15172",
    CANDIDATE_NAME: "Abigail Cleary",
    CANDIDATE_EMAIL: "Clearyabbey@gmail.com",
    START_DATE: "2026-08-23",
    TENTATIVE_END_DATE: "2026-11-22",
    LAST_UPDATED: "2026-08-21T14:38:03.215Z",
    ASSIGNMENT_RECRUITER: "Mac Singh (R3N)",
    ASSIGNMENT_RECRUITER_EMAIL: "mac.s@cynethealth.com",
    RECRUITER_EMP_NO: "CY4193",
    ONSITE_AM: "Vish Singh",
    ONSITE_AM_EMAIL: "vish.s2@cynethealth.com",
    LEVEL_2_CSM: "Jodi Stanton",
    LEVEL_3_CSM: null,
    LEVEL_4_CSM: null,
    ...overrides,
  };
}

/** deps stub: stored rows come from a fixed list, inserts are captured instead of written. */
function makeDeps(storedRows) {
  const calls = { fetchArgs: [], inserted: [] };
  return {
    calls,
    deps: {
      fetchLatestOwnershipRowsForContractIds: async (contractIds) => {
        calls.fetchArgs.push(contractIds);
        return storedRows;
      },
      insertOwnershipChangeLogBatch: async (rows) => {
        calls.inserted.push(...rows);
        return { inserted: rows.length, attempted: rows.length, errorBatches: 0 };
      },
    },
  };
}

test("insert-time chain: new extension vs stored segment -> ONSITE_AM + LEVEL_2_CSM rows, in the same run", async () => {
  const { calls, deps } = makeDeps([storedSegment({})]);
  const res = await insertContractChainOwnershipLogsForInsertedRows([insertedSegment({})], {}, deps);

  assert.equal(res.contractIds, 1);
  assert.equal(res.built, 2);
  assert.equal(res.inserted, 2);
  assert.equal(res.errorBatches, 0);

  const byRole = new Map(calls.inserted.map((r) => [r.OWNERSHIP_ROLE, r]));
  assert.deepEqual([...byRole.keys()].sort(), ["LEVEL_2_CSM", "ONSITE_AM"]);

  const am = byRole.get("ONSITE_AM");
  assert.equal(am.NEW_OWNER_NAME, "Vish Singh");
  assert.equal(am.PREVIOUS_OWNER_NAME, "Arjay Gabriel");
  // Row is stamped with the NEW placement, dated from its START_DATE.
  assert.equal(am.PLACEMENT_ID, "1466877");
  assert.equal(am.CONTRACT_ID, "CHC22109");
  assert.equal(am.SKU_NO, "H134596_H15172");
  assert.equal(am.START_DATE, "2026-08-23");
  assert.equal(am.OWNERSHIP_EFFECTIVE_DATE, "2026-08-23");
  assert.equal(am.END_DATE_PREVIOUS_OWNER, "2026-08-22");
  assert.equal(am.CHANGE_REASON_NOTES, OWNERSHIP_CHANGE_REASON_CONTRACT_CHAIN);

  const csm = byRole.get("LEVEL_2_CSM");
  assert.equal(csm.NEW_OWNER_NAME, "Jodi Stanton");
  assert.equal(csm.PREVIOUS_OWNER_NAME, "Katie Nubel");
});

test("insert-time chain: log LAST_UPDATED equals the deal row's LAST_UPDATED (no timestamp drift)", async () => {
  const { calls, deps } = makeDeps([storedSegment({})]);
  await insertContractChainOwnershipLogsForInsertedRows([insertedSegment({})], {}, deps);

  assert.ok(calls.inserted.length > 0);
  for (const row of calls.inserted) {
    assert.equal(row.LAST_UPDATED, "2026-08-21T14:38:03.215Z");
  }
});

test("insert-time chain: BigQuery LAST_UPDATED wrapper object ({value}) is unwrapped", async () => {
  const { calls, deps } = makeDeps([storedSegment({})]);
  await insertContractChainOwnershipLogsForInsertedRows(
    [insertedSegment({ LAST_UPDATED: { value: "2026-08-21T14:38:03.215Z" } })],
    {},
    deps
  );
  for (const row of calls.inserted) {
    assert.equal(row.LAST_UPDATED, "2026-08-21T14:38:03.215Z");
  }
});

test("insert-time chain: no ownership diff -> nothing built, log batch never called", async () => {
  const { calls, deps } = makeDeps([storedSegment({})]);
  const sameOwners = insertedSegment({
    ONSITE_AM: "Arjay Gabriel",
    ONSITE_AM_EMAIL: "arjay.g@cynethealth.com",
    LEVEL_2_CSM: "Katie Nubel",
  });
  const res = await insertContractChainOwnershipLogsForInsertedRows([sameOwners], {}, deps);

  assert.equal(res.built, 0);
  assert.equal(res.inserted, 0);
  assert.equal(calls.inserted.length, 0);
});

test("insert-time chain: rows without CONTRACT_ID or PLACEMENT_ID are skipped (no lookup at all)", async () => {
  const { calls, deps } = makeDeps([storedSegment({})]);
  const res = await insertContractChainOwnershipLogsForInsertedRows(
    [
      insertedSegment({ CONTRACT_ID: null }),
      insertedSegment({ PLACEMENT_ID: null }),
      insertedSegment({ CONTRACT_ID: "   " }),
    ],
    {},
    deps
  );

  assert.equal(res.built, 0);
  assert.equal(res.contractIds, 0);
  assert.equal(calls.fetchArgs.length, 0, "no CONTRACT_ID lookup should be issued");
});

test("insert-time chain: only the inserted placement's pair is logged, not older pairs on the same contract", async () => {
  // Three segments: A -> B is an older handover already covered by the scheduled scan; B -> C is
  // the one being inserted now. Only C's pair may be written here.
  const segA = storedSegment({
    PLACEMENT_ID: "1400000",
    START_DATE: "2026-01-01",
    TENTATIVE_END_DATE: "2026-03-31",
    ONSITE_AM: "Old AM",
    ONSITE_AM_EMAIL: "old.am@cynethealth.com",
    LEVEL_2_CSM: "Old CSM",
  });
  const segB = storedSegment({
    PLACEMENT_ID: "1450000",
    START_DATE: "2026-05-25",
    TENTATIVE_END_DATE: "2026-08-22",
    ONSITE_AM: "Arjay Gabriel",
    ONSITE_AM_EMAIL: "arjay.g@cynethealth.com",
    LEVEL_2_CSM: "Katie Nubel",
  });
  const { calls, deps } = makeDeps([segA, segB]);

  const res = await insertContractChainOwnershipLogsForInsertedRows([insertedSegment({})], {}, deps);

  assert.equal(res.built, 2, "only the B -> C pair (ONSITE_AM + LEVEL_2_CSM)");
  for (const row of calls.inserted) {
    assert.equal(row.PLACEMENT_ID, "1466877");
    assert.equal(row.PREVIOUS_OWNER_NAME !== "Old AM", true);
  }
});

test("insert-time chain: stored row wins over the in-memory copy of the same placement", async () => {
  // The same placement is both stored and in the inserted batch. The stored row must not be
  // duplicated into the chain (which would pair a placement against itself).
  const stored = insertedSegment({ ONSITE_AM: "Stored AM", ONSITE_AM_EMAIL: "stored@cynethealth.com" });
  const { calls, deps } = makeDeps([storedSegment({}), stored]);

  const res = await insertContractChainOwnershipLogsForInsertedRows([insertedSegment({})], {}, deps);

  assert.equal(res.built, 2);
  const am = calls.inserted.find((r) => r.OWNERSHIP_ROLE === "ONSITE_AM");
  assert.equal(am.NEW_OWNER_NAME, "Stored AM", "stored row is the authority for that placement");
  assert.equal(am.PREVIOUS_OWNER_NAME, "Arjay Gabriel");
});

test("insert-time chain: first placement of a contract (no previous segment) logs nothing", async () => {
  const { calls, deps } = makeDeps([]);
  const res = await insertContractChainOwnershipLogsForInsertedRows([insertedSegment({})], {}, deps);

  assert.equal(res.built, 0);
  assert.equal(res.inserted, 0);
  assert.equal(calls.inserted.length, 0);
});

test("insert-time chain: several contracts in one batch are looked up together", async () => {
  const other = insertedSegment({
    CONTRACT_ID: "CHC99999",
    PLACEMENT_ID: "1500000",
    SKU_NUMBER: "H1_H2",
    ONSITE_AM: "Other New AM",
    ONSITE_AM_EMAIL: "other.new@cynethealth.com",
    LEVEL_2_CSM: "Katie Nubel",
  });
  const otherStored = storedSegment({
    CONTRACT_ID: "CHC99999",
    PLACEMENT_ID: "1499000",
    SKU_NUMBER: "H1_H2",
    START_DATE: "2026-04-01",
    ONSITE_AM: "Other Old AM",
    ONSITE_AM_EMAIL: "other.old@cynethealth.com",
    LEVEL_2_CSM: "Katie Nubel",
  });
  const { calls, deps } = makeDeps([storedSegment({}), otherStored]);

  const res = await insertContractChainOwnershipLogsForInsertedRows(
    [insertedSegment({}), other],
    {},
    deps
  );

  assert.equal(res.contractIds, 2);
  assert.equal(calls.fetchArgs.length, 1, "one batched lookup, not one per contract");
  assert.deepEqual([...calls.fetchArgs[0]].sort(), ["CHC22109", "CHC99999"]);
  // CHC22109 -> ONSITE_AM + LEVEL_2_CSM; CHC99999 -> ONSITE_AM only (CSM unchanged).
  assert.equal(res.built, 3);
});

test("insert-time chain: CONTRACT_ID casing/whitespace does not split a chain", async () => {
  const { calls, deps } = makeDeps([storedSegment({ CONTRACT_ID: "chc22109" })]);
  const res = await insertContractChainOwnershipLogsForInsertedRows(
    [insertedSegment({ CONTRACT_ID: "  CHC22109 " })],
    {},
    deps
  );

  assert.equal(res.built, 2);
  assert.equal(calls.inserted.length, 2);
});

test("insert-time chain: empty input is a no-op", async () => {
  const { calls, deps } = makeDeps([storedSegment({})]);
  const res = await insertContractChainOwnershipLogsForInsertedRows([], {}, deps);
  assert.deepEqual(res, { built: 0, inserted: 0, contractIds: 0, errorBatches: 0 });
  assert.equal(calls.fetchArgs.length, 0);
});

test("buildContractOwnershipChangeLogRows: falls back to scan time when no LAST_UPDATED is passed", () => {
  const before = new Date().toISOString();
  const rows = buildContractOwnershipChangeLogRows(insertedSegment({}), storedSegment({}));
  const after = new Date().toISOString();

  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok(row.LAST_UPDATED >= before && row.LAST_UPDATED <= after);
  }
});

test("buildContractOwnershipChangeLogRows: blank LAST_UPDATED override is ignored", () => {
  const rows = buildContractOwnershipChangeLogRows(insertedSegment({}), storedSegment({}), "   ");
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.notEqual(row.LAST_UPDATED.trim(), "");
  }
});
