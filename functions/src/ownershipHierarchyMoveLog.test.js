const test = require("node:test");
const assert = require("node:assert/strict");

const { buildOwnershipChangeLogRowsForHierarchyMoves } = require("./bigQueryClient");

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
      START_DATE: "2026-05-26",
      TENTATIVE_END_DATE: "2026-08-22",
    },
    moves,
  };
}

test("hierarchy move -> exactly two ownership rows (vacate old role NA, fill new role), dates populated", () => {
  const rows = buildOwnershipChangeLogRowsForHierarchyMoves(
    moveReconResult([
      { fromRole: "TEAM_LEAD", toRole: "ASSOCIATE_DELIVERY_DIRECTOR", name: "Udit Sharma", empNoRaw: "CY4978", displacedName: null, displacedEmpNoRaw: null },
    ]),
    NOW
  );
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
    assert.equal(r.END_DATE_PREVIOUS_OWNER, "2026-08-22"); // tentative date
    assert.equal(r.OWNERSHIP_EFFECTIVE_DATE, "2026-08-23");          // tentative + 1
    assert.equal(r.CONTRACT_ID, "CHC1165");
    assert.equal(r.PLACEMENT_ID, "1456183");
  }
});

test("collision move -> fill row's PREVIOUS_OWNER is the displaced occupant (not NA)", () => {
  const rows = buildOwnershipChangeLogRowsForHierarchyMoves(
    moveReconResult([
      { fromRole: "TEAM_LEAD", toRole: "ASSOCIATE_DELIVERY_DIRECTOR", name: "Udit Sharma", empNoRaw: "CY4978", displacedName: "Amandeep Singh", displacedEmpNoRaw: "CY1753" },
    ]),
    NOW
  );
  const fill = rows.find((r) => r.OWNERSHIP_ROLE === "ASSOCIATE_DELIVERY_DIRECTOR");
  assert.equal(fill.PREVIOUS_OWNER_NAME, "Amandeep Singh");
  assert.equal(fill.PREVIOUS_OWNER_EMP_NO, "CY1753");
  assert.equal(fill.NEW_OWNER_NAME, "Udit Sharma");
});

test("no moves -> no rows", () => {
  assert.deepEqual(buildOwnershipChangeLogRowsForHierarchyMoves(moveReconResult([]), NOW), []);
  assert.deepEqual(buildOwnershipChangeLogRowsForHierarchyMoves(null, NOW), []);
});
