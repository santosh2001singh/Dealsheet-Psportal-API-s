const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildOwnershipChangeLogRowsForHierarchyMoves,
  fetchRecruiterHierarchyReconciliation,
} = require("./bigQueryClient");

const NOW = "2026-07-07T05:00:00.000Z";

function moveReconResult(moves) {
  return {
    PLACEMENT_ID: "1456183",
    CANDIDATE_NAME: "Carone J Mohr",
    latestScanRow: {
      PLACEMENT_ID: "1456183",
      CANDIDATE_NAME: "Carone J Mohr",
      CANDIDATE_EMAIL: "caronephillips@gmail.com",
      CONTRACT_ID: "CHC1165",
      SKU_NUMBER: "H1165",
      START_DATE: "2026-05-26",
      INITIAL_START_DATE: "2025-11-02",
      TENTATIVE_END_DATE: "2026-08-22",
    },
    moves,
  };
}

const udit = { fromRole: "TEAM_LEAD", toRole: "ASSOCIATE_DELIVERY_DIRECTOR", name: "Udit Sharma", empNoRaw: "CY4978", displacedName: null, displacedEmpNoRaw: null };

test("hierarchy move -> exactly two ownership rows (vacate old role NA, fill new role), dates populated", () => {
  const rows = buildOwnershipChangeLogRowsForHierarchyMoves(moveReconResult([udit]), NOW);
  assert.equal(rows.length, 2);

  const vacate = rows.find((r) => r.OWNERSHIP_ROLE === "TEAM_LEAD");
  assert.equal(vacate.PREVIOUS_OWNER_NAME, "Udit Sharma");
  assert.equal(vacate.PREVIOUS_OWNER_EMP_NO, "CY4978");
  assert.equal(vacate.NEW_OWNER_NAME, "NA");
  assert.equal(vacate.NEW_OWNER_EMP_NO, "NA");

  const fill = rows.find((r) => r.OWNERSHIP_ROLE === "ASSOCIATE_DELIVERY_DIRECTOR");
  assert.equal(fill.NEW_OWNER_NAME, "Udit Sharma");
  assert.equal(fill.NEW_OWNER_EMP_NO, "CY4978");
  assert.equal(fill.PREVIOUS_OWNER_NAME, "NA"); // target field was empty
  assert.equal(fill.PREVIOUS_OWNER_EMP_NO, "NA");

  // Dates must be populated (regression guard for the BigQuery {value}-wrapper date bug).
  for (const r of rows) {
    assert.equal(r.START_DATE, "2026-05-26");
    assert.equal(r.INITIAL_START_DATE, "2025-11-02");
    assert.equal(r.END_DATE_PREVIOUS_OWNER, "2026-08-22"); // tentative date
    assert.equal(r.OWNERSHIP_EFFECTIVE_DATE, "2026-08-23"); // tentative + 1, until an extension exists
    assert.equal(r.EFFECTIVE_DATE_SOURCE, "TENTATIVE_PLUS_1");
    assert.equal(r.EFFECTIVE_DATE_PLACEMENT_ID, "1456183");
    assert.equal(r.CONTRACT_ID, "CHC1165");
    assert.equal(r.SKU_NO, "H1165");
    assert.equal(r.PLACEMENT_ID, "1456183");
  }
});

test("collision move -> fill row's PREVIOUS_OWNER is the displaced occupant (not NA)", () => {
  const rows = buildOwnershipChangeLogRowsForHierarchyMoves(
    moveReconResult([{ ...udit, displacedName: "Amandeep Singh", displacedEmpNoRaw: "CY1753" }]),
    NOW
  );
  const fill = rows.find((r) => r.OWNERSHIP_ROLE === "ASSOCIATE_DELIVERY_DIRECTOR");
  assert.equal(fill.PREVIOUS_OWNER_NAME, "Amandeep Singh");
  assert.equal(fill.PREVIOUS_OWNER_EMP_NO, "CY1753");
  assert.equal(fill.NEW_OWNER_NAME, "Udit Sharma");
});

test("a move whose person already held the new role when the placement was frozen is not logged", () => {
  // Maneet Gupta: frozen in VP, title AVP the whole time -> a correction, not a promotion.
  const correction = { ...udit, heldNewRoleAtFreeze: true };
  assert.deepEqual(buildOwnershipChangeLogRowsForHierarchyMoves(moveReconResult([correction]), NOW), []);
  const rows = buildOwnershipChangeLogRowsForHierarchyMoves(moveReconResult([correction, { ...udit, empNoRaw: "CY1", name: "Other" }]), NOW);
  assert.equal(rows.length, 2, "only the real promotion's two rows");
});

test("no moves -> no rows", () => {
  assert.deepEqual(buildOwnershipChangeLogRowsForHierarchyMoves(moveReconResult([]), NOW), []);
  assert.deepEqual(buildOwnershipChangeLogRowsForHierarchyMoves(null, NOW), []);
});

// ---------------------------------------------------------------------------------------------
// fetchRecruiterHierarchyReconciliation: heldNewRoleAtFreeze from the chain at the freeze date
// ---------------------------------------------------------------------------------------------

function reconDeps({ titleAtFreeze }) {
  const calls = [];
  return {
    calls,
    deps: {
      queryFn: async () => [
        {
          DEAL_SHEET_ID: 1,
          PLACEMENT_ID: 1454327,
          DEAL_TYPE: "EXTENSION",
          PLACEMENT_STATUS: "STARTED",
          START_DATE: { value: "2026-05-31" },
          NEW_HIRE_DATE: { value: "2025-01-10" },
          ASSIGNMENT_RECRUITER_EMAIL: "rec@cynethealth.com",
          VP: "Maneet Gupta",
          VP_EMP_NO: "CY2088",
          AVP: "NA",
          AVP_EMP_NO: null,
        },
      ],
      directoryFetchFn: async () => new Map([["rec@cynethealth.com", { externalId: "EXT1" }]]),
      hierarchyFetchFn: async (targets, options) => {
        calls.push({ targets, options });
        const title = options.direction === "on_or_before" ? titleAtFreeze : "Associate Vice President - Delivery";
        return new Map(
          targets.map((t) => [t.key, [{ hierarchy_level: "1", manager_title: title, manager_name: "Maneet Gupta", manager_employee_id: "CY2088" }]])
        );
      },
    },
  };
}

test("reconciliation: the person already had the new title at the freeze date -> heldNewRoleAtFreeze", async () => {
  const { calls, deps } = reconDeps({ titleAtFreeze: "AVP - Delivery" });
  const [result] = await fetchRecruiterHierarchyReconciliation({ datasetId: "rr_project_data", domain: "health" }, deps);
  assert.equal(result.moves.length, 1);
  assert.deepEqual([result.moves[0].fromRole, result.moves[0].toRole], ["VP", "AVP"]);
  assert.equal(result.moves[0].heldNewRoleAtFreeze, true);
  // EXTENSION freezes on START_DATE, looked up on/before it.
  const freeze = calls.find((c) => c.options.direction === "on_or_before");
  assert.equal(freeze.targets[0].anchorDate, "2026-05-31");
});

test("reconciliation: the person was in the old role at the freeze date -> a real promotion", async () => {
  const { deps } = reconDeps({ titleAtFreeze: "VP" });
  const [result] = await fetchRecruiterHierarchyReconciliation({ datasetId: "rr_project_data", domain: "health" }, deps);
  assert.equal(result.moves[0].heldNewRoleAtFreeze, false);
});
