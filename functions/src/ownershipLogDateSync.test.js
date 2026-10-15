const test = require("node:test");
const assert = require("node:assert/strict");

const config = require("./config");
const { syncStoredOwnershipChangeLogDates, buildOwnershipLogDateMergeSql } = require("./bigQueryClient");

/**
 * syncStoredOwnershipChangeLogDates re-dates the system's ownership rows against the current deal
 * sheet (rules in ownershipChangeLogRules.resolveStoredOwnershipLogDates) and writes only the rows that
 * changed. The data team's rows are excluded both from the read and from the MERGE.
 */

async function withWrites(enabled, fn) {
  const before = config.ownershipLogWritesEnabled;
  config.ownershipLogWritesEnabled = enabled;
  try {
    return await fn();
  } finally {
    config.ownershipLogWritesEnabled = before;
  }
}

const v = (pid, t, o = {}) => ({
  PLACEMENT_ID: pid,
  CONTRACT_ID: "CHC12569",
  DEAL_TYPE: "EXTENSION",
  PLACEMENT_STATUS: "STARTED",
  LAST_UPDATED: t,
  INITIAL_START_DATE: "2023-09-24",
  ...o,
});
const versions = [
  v("1466112", "2026-08-19T09:51:50Z", { START_DATE: "2026-09-13", TENTATIVE_END_DATE: "2026-10-17" }),
  v("1466705", "2026-08-19T20:03:05Z", { START_DATE: "2026-11-19", TENTATIVE_END_DATE: "2026-12-09", PLACEMENT_STATUS: "BOOKED" }),
];
const provisional = {
  ID: "a'1",
  PLACEMENT_ID: "1466112",
  EDITED_BY: null,
  START_DATE: "2026-09-13",
  INITIAL_START_DATE: "2023-09-24",
  OWNERSHIP_EFFECTIVE_DATE: "2026-10-18",
  END_DATE_PREVIOUS_OWNER: "2026-10-17",
  EFFECTIVE_DATE_SOURCE: "TENTATIVE_PLUS_1",
  EFFECTIVE_DATE_PLACEMENT_ID: "1466112",
};
const settled = {
  ...provisional,
  ID: "b2",
  OWNERSHIP_EFFECTIVE_DATE: "2026-11-19",
  END_DATE_PREVIOUS_OWNER: "2026-11-18",
  EFFECTIVE_DATE_SOURCE: "EXTENSION_START",
  EFFECTIVE_DATE_PLACEMENT_ID: "1466705",
};

test("date sync does nothing while OWNERSHIP_LOG_WRITES_ENABLED is off", async () => {
  let called = false;
  const result = await withWrites(false, () =>
    syncStoredOwnershipChangeLogDates({ versions }, { queryFn: async () => { called = true; return []; }, runDmlFn: async () => { called = true; return 0; } })
  );
  assert.equal(result.disabled, true);
  assert.equal(called, false);
});

test("date sync: only the row whose dates changed is written; data team rows are never read", async () => {
  const reads = [];
  const merges = [];
  const result = await withWrites(true, () =>
    syncStoredOwnershipChangeLogDates(
      { versions },
      {
        queryFn: async (sql) => { reads.push(sql); return [provisional, settled]; },
        runDmlFn: async (sql) => { merges.push(sql); return 1; },
      }
    )
  );
  assert.equal(result.checked, 2);
  assert.equal(result.updated, 1);
  assert.equal(reads.length, 1);
  assert.ok(reads[0].includes("EDITED_BY IS DISTINCT FROM 'DATA_TEAM_SYNC'"));
  assert.ok(reads[0].includes(`.${config.ownershipChangeLogTableId}\``));
  assert.equal(merges.length, 1);
  assert.ok(merges[0].includes("'a\\'1'"), "the changed row, ID escaped");
  assert.ok(!merges[0].includes("'b2'"), "the settled row is not written");
  assert.ok(merges[0].includes("DATE '2026-11-19'"));
  assert.ok(merges[0].includes("'EXTENSION_START'"));
});

test("date sync: steady state issues no DML", async () => {
  let merges = 0;
  const result = await withWrites(true, () =>
    syncStoredOwnershipChangeLogDates({ versions }, { queryFn: async () => [settled], runDmlFn: async () => { merges++; return 0; } })
  );
  assert.equal(result.updated, 0);
  assert.equal(merges, 0);
});

test("the MERGE never matches a data team row and writes exactly the synced columns", () => {
  const sql = buildOwnershipLogDateMergeSql(
    { datasetId: "rr_project_data", tableId: "ownership_change_logs" },
    [{ ID: "x", START_DATE: null, INITIAL_START_DATE: "2023-09-24", OWNERSHIP_EFFECTIVE_DATE: null, END_DATE_PREVIOUS_OWNER: null, EFFECTIVE_DATE_SOURCE: null, EFFECTIVE_DATE_PLACEMENT_ID: "1" }]
  );
  assert.ok(sql.includes("ON o.ID = u.ID AND o.EDITED_BY IS DISTINCT FROM 'DATA_TEAM_SYNC'"));
  assert.ok(sql.includes("CAST(NULL AS DATE)"));
  assert.ok(sql.includes("CAST(NULL AS STRING)"));
  for (const col of ["START_DATE", "INITIAL_START_DATE", "OWNERSHIP_EFFECTIVE_DATE", "END_DATE_PREVIOUS_OWNER", "EFFECTIVE_DATE_SOURCE", "EFFECTIVE_DATE_PLACEMENT_ID"]) {
    assert.ok(sql.includes(`${col} = u.${col}`), col);
  }
  assert.ok(!/CANDIDATE|OWNER_NAME|OWNERSHIP_ROLE/.test(sql.split("WHEN MATCHED")[1]), "no other column is written");
});
