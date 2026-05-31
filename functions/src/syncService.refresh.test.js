const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseBooleanLike,
  computeChangedFields,
  resolvePreferredCandidateRow,
  buildActiveUpdateRefreshParams,
  buildRefreshAdditionalCostLogsSummary,
} = require("./syncService");
const {
  resolveFirstInsertPlacementAllowlist,
  placementStatusAllowsFirstInsert,
} = require("./bigQueryClient");

/** Matches ACTIVE_EXPANDED_FIRST_INSERT_PLACEMENT_STATUSES in index.js */
const REFRESH_EXPANDED_FIRST_INSERT_STATUSES =
  "STARTED,BOOKED,ENDED,ENDED<30,DID NOT START,DID NOT ACCEPT";

test("parseBooleanLike parses true-ish values", () => {
  assert.equal(parseBooleanLike(true), true);
  assert.equal(parseBooleanLike("true"), true);
  assert.equal(parseBooleanLike("YES"), true);
  assert.equal(parseBooleanLike("1"), true);
});

test("parseBooleanLike parses false-ish values", () => {
  assert.equal(parseBooleanLike(false), false);
  assert.equal(parseBooleanLike("false"), false);
  assert.equal(parseBooleanLike("No"), false);
  assert.equal(parseBooleanLike("0"), false);
});

test("parseBooleanLike returns null for unknown values", () => {
  assert.equal(parseBooleanLike(""), null);
  assert.equal(parseBooleanLike("maybe"), null);
  assert.equal(parseBooleanLike(null), null);
});

test("resolvePreferredCandidateRow prefers candidate+deal-sheet exact match", () => {
  const rows = [
    { candidate: 1, deal_sheet: 100 },
    { candidate: 2, deal_sheet: 200 },
    { candidate: 2, deal_sheet: 300 },
  ];
  const picked = resolvePreferredCandidateRow(rows, "2", "300");
  assert.deepEqual(picked, rows[2]);
});

test("resolvePreferredCandidateRow falls back to candidate match", () => {
  const rows = [
    { candidate: 1, deal_sheet: 100 },
    { candidate: 2, deal_sheet: 200 },
  ];
  const picked = resolvePreferredCandidateRow(rows, "2", "999");
  assert.deepEqual(picked, rows[1]);
});

test("computeChangedFields returns business-only changed keys", () => {
  const existing = {
    DEAL_SHEET_ID: 11,
    PLACEMENT_ID: 22,
    PLACEMENT_STATUS: "STARTED",
    CANDIDATE_STATUS: "ACTIVE",
    ID: "old",
    DATE_AND_TIME: "2026-05-08T00:00:00Z",
  };
  const incoming = {
    DEAL_SHEET_ID: 11,
    PLACEMENT_ID: 22,
    PLACEMENT_STATUS: "ENDED",
    CANDIDATE_STATUS: "BOOKED",
    ID: "new",
    DATE_AND_TIME: "2026-05-08T01:00:00Z",
  };
  const diff = computeChangedFields(incoming, existing, ["ID", "DATE_AND_TIME"]);
  assert.deepEqual(diff, ["CANDIDATE_STATUS", "PLACEMENT_STATUS"]);
});

test("buildActiveUpdateRefreshParams passes deal_sheet_id and placement_id together", () => {
  const { params, skipReason } = buildActiveUpdateRefreshParams(
    { deal_sheet_id: "1", placement_id: "2", table_id: "cynet_health_deal_sheet" },
    { bq_dataset: "rr_project_data", apply_update: true }
  );
  assert.equal(skipReason, null);
  assert.equal(params.deal_sheet_id, "1");
  assert.equal(params.placement_id, "2");
  assert.equal(params.bq_dataset, "rr_project_data");
  assert.equal(params.apply_update, true);
});

test("buildActiveUpdateRefreshParams passes placement_id only for fallback targets", () => {
  const { params, skipReason } = buildActiveUpdateRefreshParams(
    { deal_sheet_id: null, placement_id: "2" },
    { bq_table: "cynet_health_deal_sheet" }
  );
  assert.equal(skipReason, null);
  assert.equal(params.deal_sheet_id, undefined);
  assert.equal(params.placement_id, "2");
});

test("buildActiveUpdateRefreshParams passes deal_sheet_id only when placement missing", () => {
  const { params, skipReason } = buildActiveUpdateRefreshParams(
    { deal_sheet_id: "1", placement_id: null },
    {}
  );
  assert.equal(skipReason, null);
  assert.equal(params.deal_sheet_id, "1");
  assert.equal(params.placement_id, undefined);
});

test("buildActiveUpdateRefreshParams returns skip when no identifiers", () => {
  const { params, skipReason } = buildActiveUpdateRefreshParams(
    { deal_sheet_id: "", placement_id: "" },
    {}
  );
  assert.equal(params, null);
  assert.match(skipReason, /No deal_sheet_id or placement_id/);
});

test("computeChangedFields ignores IS_REJECTED when configured", () => {
  const existing = {
    DEAL_SHEET_ID: 11,
    PLACEMENT_ID: 22,
    IS_REJECTED: "True",
  };
  const incoming = {
    DEAL_SHEET_ID: 11,
    PLACEMENT_ID: 22,
    IS_REJECTED: "False",
  };
  const diff = computeChangedFields(incoming, existing, ["ID", "DATE_AND_TIME", "IS_REJECTED"]);
  assert.deepEqual(diff, []);
});

test("refresh expanded allowlist allows ENDED for first insert", () => {
  const allowSet = resolveFirstInsertPlacementAllowlist({
    first_insert_placement_status_allowlist: REFRESH_EXPANDED_FIRST_INSERT_STATUSES,
  });
  assert.equal(placementStatusAllowsFirstInsert("ENDED", allowSet), true);
  assert.equal(placementStatusAllowsFirstInsert("ENDED<30", allowSet), true);
  assert.equal(placementStatusAllowsFirstInsert("DID NOT START", allowSet), true);
  assert.equal(placementStatusAllowsFirstInsert("DID NOT ACCEPT", allowSet), true);
});

test("buildRefreshAdditionalCostLogsSummary: INSERTED with log write result", () => {
  const summary = buildRefreshAdditionalCostLogsSummary(
    "INSERTED",
    [{ DEAL_SHEET_ID: 1 }],
    { inserted: 1, errorBatches: 0 }
  );
  assert.deepEqual(summary, { attempted: 1, inserted: 1, errorBatches: 0 });
});

test("buildRefreshAdditionalCostLogsSummary: non-INSERTED with pending log rows", () => {
  const summary = buildRefreshAdditionalCostLogsSummary("NO_CHANGE", [{}, {}], null);
  assert.deepEqual(summary, {
    attempted: 2,
    inserted: 0,
    skipped_reason: "not inserted",
  });
});

test("buildRefreshAdditionalCostLogsSummary: empty when no log rows", () => {
  const summary = buildRefreshAdditionalCostLogsSummary("NOT_FOUND", [], null);
  assert.deepEqual(summary, { attempted: 0, inserted: 0, errorBatches: 0 });
});

test("computeChangedFields ignores manual columns like SKU_NUMBER", () => {
  const existing = {
    DEAL_SHEET_ID: 11,
    PLACEMENT_ID: 22,
    SKU_NUMBER: "23243",
    BGC_AGENCY_NAME: "Acme",
    PLACEMENT_STATUS: "STARTED",
  };
  const incoming = {
    DEAL_SHEET_ID: 11,
    PLACEMENT_ID: 22,
    SKU_NUMBER: null,
    BGC_AGENCY_NAME: null,
    PLACEMENT_STATUS: "STARTED",
  };
  const diff = computeChangedFields(incoming, existing, ["ID", "DATE_AND_TIME", "IS_REJECTED"]);
  assert.deepEqual(diff, []);
});
