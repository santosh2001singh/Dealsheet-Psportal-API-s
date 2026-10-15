const test = require("node:test");
const assert = require("node:assert/strict");

const config = require("./config");

const { insertContractChainOwnershipLogsForInsertedRows } = require("./bigQueryClient");

// These fixtures predate the data-team cutoff; the cutoff has its own tests
// (ownershipChangeLogRules.test.js "data team cutoff").
config.ownershipLogDataTeamCutoff = "2000-01-01T00:00:00Z";

/**
 * Insert-time ownership logs: the rows just written are logged in the same run instead of on the next
 * scheduled scan. The contract's full version history is read (the insert already landed — load job),
 * and only changes FIRST seen on an inserted placement are logged.
 *
 * The Abigail Cleary shape that motivated this: a segment already in BigQuery, and an EXTENSION on
 * the same CONTRACT_ID inserted now with a different ONSITE_AM / LEVEL_2_CSM.
 */
function storedSegment(overrides) {
  return {
    DEAL_SHEET_ID: 900,
    PLACEMENT_ID: "1400000",
    CONTRACT_ID: "CHC22109",
    SKU_NUMBER: "H134596_H15172",
    DEAL_TYPE: "DEAL",
    PLACEMENT_STATUS: "ENDED",
    CANDIDATE_NAME: "Abigail Cleary",
    CANDIDATE_EMAIL: "clearyabbey@gmail.com",
    START_DATE: "2026-05-25",
    TENTATIVE_END_DATE: "2026-08-22",
    INITIAL_START_DATE: "2026-05-25",
    LAST_UPDATED: "2026-08-19T09:00:00Z",
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
    DEAL_TYPE: "EXTENSION",
    PLACEMENT_STATUS: "BOOKED",
    CANDIDATE_NAME: "Abigail Cleary",
    CANDIDATE_EMAIL: "Clearyabbey@gmail.com",
    START_DATE: "2026-08-23",
    TENTATIVE_END_DATE: "2026-11-22",
    INITIAL_START_DATE: "2026-05-25",
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

/** deps stub: versions come from a fixed list, inserts are captured instead of written. */
function makeDeps(versions) {
  const calls = { fetchArgs: [], inserted: [] };
  return {
    calls,
    deps: {
      fetchOwnershipScanVersions: async (opts) => {
        calls.fetchArgs.push(opts);
        return versions;
      },
      insertOwnershipChangeLogBatch: async (rows) => {
        calls.inserted.push(...rows);
        return { inserted: rows.length, attempted: rows.length, errorBatches: 0 };
      },
    },
  };
}

test("insert-time: new extension vs stored segment -> ONSITE_AM + LEVEL_2_CSM rows, in the same run", async () => {
  const inserted = insertedSegment({});
  const { calls, deps } = makeDeps([storedSegment({}), inserted]);
  const res = await insertContractChainOwnershipLogsForInsertedRows([inserted], { dealSheetDatasetId: "rr_project_data" }, deps);

  assert.equal(res.contractIds, 1);
  assert.equal(res.built, 2);
  assert.equal(res.inserted, 2);
  assert.equal(res.errorBatches, 0);
  assert.deepEqual(calls.fetchArgs, [{ datasetId: "rr_project_data", contractIds: ["CHC22109"] }]);

  const byRole = new Map(calls.inserted.map((r) => [r.OWNERSHIP_ROLE, r]));
  assert.deepEqual([...byRole.keys()].sort(), ["LEVEL_2_CSM", "ONSITE_AM"]);

  const am = byRole.get("ONSITE_AM");
  assert.equal(am.NEW_OWNER_NAME, "Vish Singh");
  assert.equal(am.PREVIOUS_OWNER_NAME, "Arjay Gabriel");
  // Stamped with the NEW placement; the new extension started with the new owner -> its START_DATE.
  assert.equal(am.PLACEMENT_ID, "1466877");
  assert.equal(am.CONTRACT_ID, "CHC22109");
  assert.equal(am.SKU_NO, "H134596_H15172");
  assert.equal(am.START_DATE, "2026-08-23");
  assert.equal(am.INITIAL_START_DATE, "2026-05-25");
  assert.equal(am.OWNERSHIP_EFFECTIVE_DATE, "2026-08-23");
  assert.equal(am.END_DATE_PREVIOUS_OWNER, "2026-08-22");
  assert.equal(am.EFFECTIVE_DATE_SOURCE, "EXTENSION_START");
  assert.equal(am.EFFECTIVE_DATE_PLACEMENT_ID, "1466877");
  assert.equal(am.CHANGE_REASON_NOTES, "CONTRACT_CHAIN");

  const csm = byRole.get("LEVEL_2_CSM");
  assert.equal(csm.NEW_OWNER_NAME, "Jodi Stanton");
  assert.equal(csm.PREVIOUS_OWNER_NAME, "Katie Nubel");
});

test("insert-time: no ownership diff -> nothing built, log batch never called", async () => {
  const same = insertedSegment({ ONSITE_AM: "Arjay Gabriel", ONSITE_AM_EMAIL: "arjay.g@cynethealth.com", LEVEL_2_CSM: "Katie Nubel" });
  const { calls, deps } = makeDeps([storedSegment({}), same]);
  const res = await insertContractChainOwnershipLogsForInsertedRows([same], {}, deps);
  assert.equal(res.built, 0);
  assert.equal(res.inserted, 0);
  assert.equal(calls.inserted.length, 0);
});

test("insert-time: rows without CONTRACT_ID or PLACEMENT_ID are skipped (no lookup at all)", async () => {
  const { calls, deps } = makeDeps([]);
  const res = await insertContractChainOwnershipLogsForInsertedRows(
    [insertedSegment({ CONTRACT_ID: null }), insertedSegment({ PLACEMENT_ID: "  " })],
    {},
    deps
  );
  assert.deepEqual(res, { built: 0, inserted: 0, contractIds: 0, errorBatches: 0 });
  assert.equal(calls.fetchArgs.length, 0);
});

test("insert-time: only changes first seen on the inserted placement, not older ones on the contract", async () => {
  // 1300000 -> 1400000 already changed the recruiter; that is the scheduled scan's job.
  const older = storedSegment({ PLACEMENT_ID: "1300000", START_DATE: "2026-02-01", ASSIGNMENT_RECRUITER: "Old Rec", ASSIGNMENT_RECRUITER_EMAIL: "old@cynethealth.com", RECRUITER_EMP_NO: "CY1" });
  const inserted = insertedSegment({});
  const { calls, deps } = makeDeps([older, storedSegment({}), inserted]);
  await insertContractChainOwnershipLogsForInsertedRows([inserted], {}, deps);
  assert.ok(calls.inserted.length > 0);
  for (const r of calls.inserted) assert.equal(r.PLACEMENT_ID, "1466877");
  assert.ok(!calls.inserted.some((r) => r.OWNERSHIP_ROLE === "RECRUITER"));
});

test("insert-time: a change first seen on an older placement is not re-logged when it reaches the new one", async () => {
  // Kayann Roopchan: the onsite AM changed on the running extension; the same update then reached
  // the booked one. Only the running extension's row is the change.
  const running = storedSegment({ PLACEMENT_ID: "1466112", DEAL_TYPE: "EXTENSION", PLACEMENT_STATUS: "STARTED", START_DATE: "2026-08-23", LAST_UPDATED: "2026-08-19T09:00:00Z" });
  const runningChanged = { ...running, LAST_UPDATED: "2026-09-15T15:59:07Z", ONSITE_AM: "Vish Singh", ONSITE_AM_EMAIL: "vish.s2@cynethealth.com" };
  const booked = insertedSegment({ PLACEMENT_ID: "1466705", START_DATE: "2026-11-23", LAST_UPDATED: "2026-08-19T20:03:05Z", ONSITE_AM: "Arjay Gabriel", ONSITE_AM_EMAIL: "arjay.g@cynethealth.com", LEVEL_2_CSM: "Katie Nubel" });
  const bookedChanged = { ...booked, LAST_UPDATED: "2026-09-15T17:13:22Z", ONSITE_AM: "Vish Singh", ONSITE_AM_EMAIL: "vish.s2@cynethealth.com" };
  const { calls, deps } = makeDeps([running, runningChanged, booked, bookedChanged]);
  const res = await insertContractChainOwnershipLogsForInsertedRows([bookedChanged], {}, deps);
  assert.equal(res.built, 0);
  assert.equal(calls.inserted.length, 0);
});

test("insert-time: several contracts in one batch are looked up together", async () => {
  const a = insertedSegment({});
  const b = insertedSegment({ PLACEMENT_ID: "2000002", CONTRACT_ID: "CHC9" });
  const { calls, deps } = makeDeps([storedSegment({}), a, storedSegment({ PLACEMENT_ID: "2000001", CONTRACT_ID: "CHC9" }), b]);
  const res = await insertContractChainOwnershipLogsForInsertedRows([a, b], {}, deps);
  assert.equal(calls.fetchArgs.length, 1);
  assert.deepEqual(calls.fetchArgs[0].contractIds.sort(), ["CHC22109", "CHC9"]);
  assert.equal(res.contractIds, 2);
  assert.deepEqual([...new Set(calls.inserted.map((r) => r.PLACEMENT_ID))].sort(), ["1466877", "2000002"]);
});

test("insert-time: CONTRACT_ID casing/whitespace does not split a chain", async () => {
  const inserted = insertedSegment({ CONTRACT_ID: "  chc22109 " });
  const { calls, deps } = makeDeps([storedSegment({}), inserted]);
  await insertContractChainOwnershipLogsForInsertedRows([inserted], {}, deps);
  assert.deepEqual(calls.fetchArgs[0].contractIds, ["CHC22109"]);
  assert.equal(calls.inserted.length, 2);
});

test("insert-time: empty input is a no-op", async () => {
  const { calls, deps } = makeDeps([]);
  assert.deepEqual(await insertContractChainOwnershipLogsForInsertedRows([], {}, deps), {
    built: 0,
    inserted: 0,
    contractIds: 0,
    errorBatches: 0,
  });
  assert.deepEqual(await insertContractChainOwnershipLogsForInsertedRows(null, {}, deps), {
    built: 0,
    inserted: 0,
    contractIds: 0,
    errorBatches: 0,
  });
  assert.equal(calls.fetchArgs.length, 0);
});
