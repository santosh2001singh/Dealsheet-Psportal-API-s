const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const path = require("node:path");

const {
  HIERARCHY_FROZEN_STATUS_PREFIXES,
  isHierarchyFrozenStatus,
  hierarchyOpenStatusSqlPredicate,
} = require("./hierarchyFrozenStatus");
const {
  fetchRecruiterHierarchyReconciliation,
  applyLiveRecruiterHierarchyToDealSheet,
  fetchActiveExtensionRowsForInorganic,
  applyFrozenStatusCsmCarryForward,
  applyOnsiteAmCsmHierarchyForRows,
  applyPreviousRecruiterIntoNewRecruiterHierarchyForRows,
} = require("./bigQueryClient");

const FROZEN = ["ENDED", "ENDED<30", "DID NOT START", "DID NOT ACCEPT"];
const OPEN = ["STARTED", "BOOKED", "ACTIVE", "OFFERED", "", null];

// ENDED / ENDED<30 / DID NOT START / DID NOT ACCEPT all stop the hierarchy scans the same way ENDED
// always has: judged on the placement's LATEST row, so a placement back to STARTED/BOOKED re-enters.

const FROZEN_CLAUSES = [
  "NOT LIKE 'ENDED%'",
  "NOT LIKE 'DID NOT START%'",
  "NOT LIKE 'DID NOT ACCEPT%'",
];

function assertFrozenGateAfterLatestRow(sql) {
  for (const clause of FROZEN_CLAUSES) {
    assert.ok(sql.includes(clause), `missing ${clause}`);
    assert.ok(sql.indexOf("rn = 1") < sql.indexOf(clause), `${clause} must apply to the latest row`);
  }
}

test("frozen statuses are ENDED (incl. ENDED<30), DID NOT START, DID NOT ACCEPT", () => {
  assert.deepEqual([...HIERARCHY_FROZEN_STATUS_PREFIXES], ["ENDED", "DID NOT START", "DID NOT ACCEPT"]);
  const sql = hierarchyOpenStatusSqlPredicate();
  for (const clause of FROZEN_CLAUSES) assert.ok(sql.includes(clause));
  assert.match(sql, /UPPER\(TRIM\(IFNULL\(PLACEMENT_STATUS, ''\)\)\)/);
});

test("health reconciliation (inorganic newPersons + organic MOVES) skips all frozen statuses", async () => {
  let sql = null;
  const out = await fetchRecruiterHierarchyReconciliation(
    { datasetId: "rr_project_data", domain: "health" },
    {
      queryFn: async (q) => {
        sql = q;
        return [];
      },
    }
  );
  assert.deepEqual(out, []);
  assertFrozenGateAfterLatestRow(sql);
});

for (const domain of ["canada", "locums"]) {
  test(`${domain} live-chain scan skips all frozen statuses`, async () => {
    let sql = null;
    const out = await applyLiveRecruiterHierarchyToDealSheet(
      { datasetId: "rr_project_data", domain },
      {
        queryFn: async (q) => {
          sql = q;
          return [];
        },
      }
    );
    assert.equal(out.checked, 0);
    assertFrozenGateAfterLatestRow(sql);
  });
}

test("isHierarchyFrozenStatus: only the four terminal statuses", () => {
  for (const st of FROZEN) assert.equal(isHierarchyFrozenStatus(st), true, st);
  assert.equal(isHierarchyFrozenStatus("  ended<30 "), true);
  for (const st of OPEN) assert.equal(isHierarchyFrozenStatus(st), false, String(st));
});

test("extension run-rate inorganic seed skips frozen statuses on the latest row", async () => {
  let sql = null;
  await fetchActiveExtensionRowsForInorganic(
    { datasetId: "rr_project_data", domain: "health" },
    {
      queryFn: async (q) => {
        sql = q;
        return [];
      },
    }
  );
  assertFrozenGateAfterLatestRow(sql);
});

test("recruiter-change inorganic pairs are gated on the LATEST row's status", () => {
  const src = fs.readFileSync(path.join(__dirname, "bigQueryClient.js"), "utf8");
  const start = src.indexOf("async function fetchDealSheetRecruiterChangePairsFromActive(");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  assert.ok(body.includes('hierarchyOpenStatusSqlPredicate("l.PLACEMENT_STATUS")'));
  assert.ok(body.indexOf("changed_keys AS") < body.indexOf("hierarchyOpenStatusSqlPredicate"));
});

// ---- LEVEL_2/3/4_CSM ----

const STORED_CSM = { LEVEL_2_CSM: "Old L2", LEVEL_3_CSM: "Old L3", LEVEL_4_CSM: null };
const LIVE_CSM = { LEVEL_2_CSM: "New L2", LEVEL_3_CSM: "New L3", LEVEL_4_CSM: "New L4" };
const csmFetch = (rows) => async () => new Map(rows.map((_, i) => [String(i), LIVE_CSM]));

for (const status of FROZEN) {
  test(`${status} update-append keeps the stored LEVEL_*_CSM`, async () => {
    const row = applyFrozenStatusCsmCarryForward(
      { PLACEMENT_STATUS: status, ONSITE_AM_EMAIL: "new.am@client.com", __CARRIED_FORWARD_UPDATE: true },
      { ...STORED_CSM, PLACEMENT_STATUS: "STARTED" }
    );
    assert.equal(row.LEVEL_2_CSM, "Old L2");
    const [out] = await applyOnsiteAmCsmHierarchyForRows([row], {}, { fetchFn: csmFetch([row]) });
    assert.deepEqual(
      [out.LEVEL_2_CSM, out.LEVEL_3_CSM, out.LEVEL_4_CSM],
      [STORED_CSM.LEVEL_2_CSM, STORED_CSM.LEVEL_3_CSM, STORED_CSM.LEVEL_4_CSM]
    );
    assert.equal(out.ONSITE_AM_EMAIL, "new.am@client.com", "the onsite AM itself still updates");
  });
}

test("STARTED update-append and any fresh insert still recompute LEVEL_*_CSM", async () => {
  const started = applyFrozenStatusCsmCarryForward(
    { PLACEMENT_STATUS: "STARTED", ONSITE_AM_EMAIL: "am@client.com", __CARRIED_FORWARD_UPDATE: true },
    STORED_CSM
  );
  const insertedEnded = applyFrozenStatusCsmCarryForward({ PLACEMENT_STATUS: "ENDED", ONSITE_AM_EMAIL: "am@client.com" }, null);
  const rows = [started, insertedEnded];
  const out = await applyOnsiteAmCsmHierarchyForRows(rows, {}, { fetchFn: csmFetch(rows) });
  for (const r of out) assert.equal(r.LEVEL_2_CSM, "New L2");
});

// ---- previous recruiter into the new recruiter's chain ----

test("frozen-status recruiter change does not fill a seat from the new chain", async () => {
  for (const status of FROZEN) {
    const row = {
      PLACEMENT_ID: "1",
      DEAL_TYPE: "DEAL",
      PLACEMENT_STATUS: status,
      ASSIGNMENT_RECRUITER_EMAIL: "new@cynethealth.com",
      RECRUITER_EMP_NO: "CY2",
      RM: null,
      __PREV_RECRUITER_NAME: "Old Rec",
      __PREV_RECRUITER_EMP_NO: "CY1",
      __CARRIED_FORWARD_UPDATE: true,
    };
    const fail = async () => {
      throw new Error("directory must not be read for a frozen status");
    };
    const [out] = await applyPreviousRecruiterIntoNewRecruiterHierarchyForRows([row], {
      directoryFetchFn: fail,
      chainFetchFn: fail,
      titleColumnFetchFn: fail,
    });
    assert.equal(out, row);
  }
});
