const test = require("node:test");
const assert = require("node:assert/strict");

const config = require("./config");
const {
  buildLegacyContractLookupKey,
  legacyRunrateWindowStartSql,
  legacyWindowCoversAnyOwnDate,
} = require("./bigQueryClient");

// Live case (CANDIDATE_ID 23541963 "Linda Anyachebelu", Nov 2026): run-rate row CHC22241 started
// 2026-06-08. Approving extension 1465535 rewrote it in place to START_DATE 2026-09-13, so DEAL
// 1458001 (2026-06-08..2026-09-12) fell before the window, matched nothing and minted CHC23640.
const lindaDeal = {
  DEAL_SHEET_ID: "5218694",
  PLACEMENT_ID: "1458001",
  DEAL_TYPE: "DEAL",
  CANDIDATE_ID: "23541963",
  CANDIDATE_EMAIL: "lindacany@yahoo.com",
  INTERNAL_JOB_ID: "35456497",
  FACILITY_NAME: "NYC Health + Hospitals / Bellevue",
  PARENT_CLIENT_NAME: "NYC Health + Hospitals",
  CLIENT_ID: "1017672",
  NEXUS_PARENT_CLIENT_ID: "1017587",
  START_DATE: "2026-06-08",
  TENTATIVE_END_DATE: "2026-09-12",
  END_DATE: "2026-09-12",
};

test("health run-rate window opens at INITIAL_START_DATE", () => {
  const { windowStartSql, exactStartHitSql } = legacyRunrateWindowStartSql(config.runrateTableId);
  assert.equal(windowStartSql, "LEAST(COALESCE(r.INITIAL_START_DATE, r.START_DATE), r.START_DATE)");
  assert.match(exactStartHitSql, /INITIAL_START_DATE/);
  assert.match(exactStartHitSql, /r\.START_DATE IN UNNEST\(w\.probe_dates\)/);
});

test("canada and locums run-rate windows still open at START_DATE", () => {
  for (const tableId of [config.runrateCanadaTableId, config.runrateLocumsTableId]) {
    assert.deepEqual(legacyRunrateWindowStartSql(tableId), {
      windowStartSql: "r.START_DATE",
      exactStartHitSql: "r.START_DATE IN UNNEST(w.probe_dates)",
    });
  }
});

test("the DEAL passes the new-contract guard against the initial-start window", () => {
  const key = buildLegacyContractLookupKey(lindaDeal);
  assert.equal(
    legacyWindowCoversAnyOwnDate(key.spanKey, {
      __WINDOW_START_DATE: "2026-06-08",
      __WINDOW_END_DATE: "2026-11-07",
    }),
    true
  );
  // The old START_DATE window rejected it.
  assert.equal(
    legacyWindowCoversAnyOwnDate(key.spanKey, {
      __WINDOW_START_DATE: "2026-09-13",
      __WINDOW_END_DATE: "2026-11-07",
    }),
    false
  );
});
