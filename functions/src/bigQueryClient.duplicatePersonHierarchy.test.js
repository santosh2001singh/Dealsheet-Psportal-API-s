const test = require("node:test");
const assert = require("node:assert/strict");

const { vacateDuplicatePersonHierarchyRoles } = require("./bigQueryClient");

/**
 * Placement 1466750 (Aug 2026): Mohit Arora was promoted from Associate Delivery Director to
 * Delivery Director. Run-rate supplied the old designation, the live directory the new one, so the
 * insert put the same emp-no in both columns.
 */
function mohitRow(overrides) {
  return {
    PLACEMENT_ID: "1466750",
    SKU_NUMBER: "H15237",
    DEAL_TYPE: "EXTENSION",
    ASSIGNMENT_RECRUITER: "Some Recruiter",
    RECRUITER_EMP_NO: "CY9999",
    ASSOCIATE_DELIVERY_DIRECTOR: "Mohit Arora",
    ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO: "CY1500",
    DELIVERY_DIRECTOR: "Mohit Arora",
    DELIVERY_DIRECTOR_EMP_NO: "CY1500",
    ...overrides,
  };
}

test("promoted person in two columns -> stale junior seat vacated, senior seat kept", () => {
  const { row, changed, vacatedColumns } = vacateDuplicatePersonHierarchyRoles(mohitRow({}));

  assert.equal(changed, true);
  assert.deepEqual(vacatedColumns, ["ASSOCIATE_DELIVERY_DIRECTOR"]);
  assert.equal(row.ASSOCIATE_DELIVERY_DIRECTOR, "NA");
  assert.equal(row.ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO, null);
  // DELIVERY_DIRECTOR is more senior in DEAL_RECRUITER_HIERARCHY_TARGETS order — it survives.
  assert.equal(row.DELIVERY_DIRECTOR, "Mohit Arora");
  assert.equal(row.DELIVERY_DIRECTOR_EMP_NO, "CY1500");
});

test("input row is not mutated", () => {
  const input = mohitRow({});
  const { row } = vacateDuplicatePersonHierarchyRoles(input);

  assert.notEqual(row, input);
  assert.equal(input.ASSOCIATE_DELIVERY_DIRECTOR, "Mohit Arora");
  assert.equal(input.ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO, "CY1500");
});

test("distinct people in adjacent roles are left alone", () => {
  const input = mohitRow({
    ASSOCIATE_DELIVERY_DIRECTOR: "Someone Else",
    ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO: "CY1600",
  });
  const { row, changed } = vacateDuplicatePersonHierarchyRoles(input);

  assert.equal(changed, false);
  assert.equal(row, input, "unchanged rows are returned by reference");
  assert.equal(row.ASSOCIATE_DELIVERY_DIRECTOR, "Someone Else");
  assert.equal(row.DELIVERY_DIRECTOR, "Mohit Arora");
});

test("emp-no comparison ignores case and surrounding whitespace", () => {
  const { row, changed } = vacateDuplicatePersonHierarchyRoles(
    mohitRow({ ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO: "  cy1500 " })
  );

  assert.equal(changed, true);
  assert.equal(row.ASSOCIATE_DELIVERY_DIRECTOR, "NA");
  assert.equal(row.DELIVERY_DIRECTOR, "Mohit Arora");
});

test("same name but different emp-no is NOT merged (two people can share a name)", () => {
  const { row, changed } = vacateDuplicatePersonHierarchyRoles(
    mohitRow({ ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO: "CY7777" })
  );

  assert.equal(changed, false);
  assert.equal(row.ASSOCIATE_DELIVERY_DIRECTOR, "Mohit Arora");
  assert.equal(row.DELIVERY_DIRECTOR, "Mohit Arora");
});

test("a missing emp-no on either side leaves both seats alone", () => {
  const noJuniorEmp = vacateDuplicatePersonHierarchyRoles(
    mohitRow({ ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO: null })
  );
  assert.equal(noJuniorEmp.changed, false);
  assert.equal(noJuniorEmp.row.ASSOCIATE_DELIVERY_DIRECTOR, "Mohit Arora");

  const noSeniorEmp = vacateDuplicatePersonHierarchyRoles(
    mohitRow({ DELIVERY_DIRECTOR_EMP_NO: "   " })
  );
  assert.equal(noSeniorEmp.changed, false);
  assert.equal(noSeniorEmp.row.ASSOCIATE_DELIVERY_DIRECTOR, "Mohit Arora");
});

test("an already-vacated NA seat is not counted or re-vacated", () => {
  const { row, changed } = vacateDuplicatePersonHierarchyRoles(
    mohitRow({ ASSOCIATE_DELIVERY_DIRECTOR: "NA", ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO: "NA" })
  );

  assert.equal(changed, false);
  assert.equal(row.DELIVERY_DIRECTOR, "Mohit Arora");
});

test("three seats for one person -> only the most senior survives", () => {
  const { row, changed, vacatedColumns } = vacateDuplicatePersonHierarchyRoles(
    mohitRow({
      RM: "Mohit Arora",
      RM_EMP_NO: "CY1500",
    })
  );

  assert.equal(changed, true);
  assert.deepEqual(vacatedColumns.sort(), ["ASSOCIATE_DELIVERY_DIRECTOR", "RM"]);
  assert.equal(row.RM, "NA");
  assert.equal(row.RM_EMP_NO, null);
  assert.equal(row.ASSOCIATE_DELIVERY_DIRECTOR, "NA");
  assert.equal(row.DELIVERY_DIRECTOR, "Mohit Arora");
});

test("two different duplicated people are resolved independently", () => {
  const { row, changed, vacatedColumns } = vacateDuplicatePersonHierarchyRoles(
    mohitRow({
      TEAM_LEAD: "Other Person",
      TEAM_LEAD_EMP_NO: "CY2000",
      ACCOUNT_MANAGER: "Other Person",
      ACCOUNT_MANAGER_EMP_NO: "CY2000",
    })
  );

  assert.equal(changed, true);
  assert.deepEqual(vacatedColumns.sort(), ["ASSOCIATE_DELIVERY_DIRECTOR", "TEAM_LEAD"]);
  assert.equal(row.DELIVERY_DIRECTOR, "Mohit Arora");
  assert.equal(row.ACCOUNT_MANAGER, "Other Person");
  assert.equal(row.TEAM_LEAD, "NA");
  assert.equal(row.TEAM_LEAD_EMP_NO, null);
});

test("VP is the most senior seat and wins over DELIVERY_DIRECTOR", () => {
  const { row, vacatedColumns } = vacateDuplicatePersonHierarchyRoles(
    mohitRow({
      ASSOCIATE_DELIVERY_DIRECTOR: null,
      ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO: null,
      VP: "Mohit Arora",
      VP_EMP_NO: "CY1500",
    })
  );

  assert.deepEqual(vacatedColumns, ["DELIVERY_DIRECTOR"]);
  assert.equal(row.DELIVERY_DIRECTOR, "NA");
  assert.equal(row.VP, "Mohit Arora");
});

test("a clean row with no duplicates is returned untouched", () => {
  const input = {
    PLACEMENT_ID: "1",
    TEAM_LEAD: "A Person",
    TEAM_LEAD_EMP_NO: "CY1",
    ACCOUNT_MANAGER: "B Person",
    ACCOUNT_MANAGER_EMP_NO: "CY2",
    DELIVERY_DIRECTOR: "C Person",
    DELIVERY_DIRECTOR_EMP_NO: "CY3",
  };
  const { row, changed, vacatedColumns } = vacateDuplicatePersonHierarchyRoles(input);

  assert.equal(changed, false);
  assert.equal(row, input);
  assert.deepEqual(vacatedColumns, []);
});

test("non-object input is handled safely", () => {
  for (const bad of [null, undefined, "x", 42]) {
    const res = vacateDuplicatePersonHierarchyRoles(bad);
    assert.equal(res.changed, false);
    assert.deepEqual(res.vacatedColumns, []);
  }
});

test("is idempotent — a second pass changes nothing", () => {
  const first = vacateDuplicatePersonHierarchyRoles(mohitRow({}));
  const second = vacateDuplicatePersonHierarchyRoles(first.row);

  assert.equal(second.changed, false);
  assert.equal(second.row.ASSOCIATE_DELIVERY_DIRECTOR, "NA");
  assert.equal(second.row.DELIVERY_DIRECTOR, "Mohit Arora");
});
