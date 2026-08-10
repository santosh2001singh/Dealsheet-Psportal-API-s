const test = require("node:test");
const assert = require("node:assert/strict");

const { computeRecruiterHierarchyRoleChanges } = require("./recruiterHierarchyDesignations");

// Carone Mohr's frozen regular fields (hire-date snapshot 2026-03-17).
const CARONE_FROZEN = {
  TEAM_LEAD: "Udit Sharma", TEAM_LEAD_EMP_NO: "CY4978",
  ASSOCIATE_DELIVERY_DIRECTOR: "Amandeep Singh", ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO: "CY1753",
  DELIVERY_DIRECTOR: "Deepti Sharma", DELIVERY_DIRECTOR_EMP_NO: "CY1166",
  VP: "Amy Gupta", VP_EMP_NO: "CY788",
};

test("no change: current chain identical to frozen -> no moves, no new persons", () => {
  const current = {
    TEAM_LEAD: { name: "Udit Sharma", empNo: "CY4978" },
    ASSOCIATE_DELIVERY_DIRECTOR: { name: "Amandeep Singh", empNo: "CY1753" },
    DELIVERY_DIRECTOR: { name: "Deepti Sharma", empNo: "CY1166" },
    VP: { name: "Amy Gupta", empNo: "CY788" },
  };
  const out = computeRecruiterHierarchyRoleChanges(CARONE_FROZEN, current);
  assert.equal(out.changed, false);
  assert.deepEqual(out.moves, []);
  assert.deepEqual(out.newPersons, []);
  assert.deepEqual(out.updatedFields, {});
});

test("promotion into an EMPTY target field: Udit TEAM_LEAD -> ACCOUNT_MANAGER (user's example)", () => {
  const current = {
    ACCOUNT_MANAGER: { name: "Udit Sharma", empNo: "CY4978" }, // Udit is now Account Manager
    ASSOCIATE_DELIVERY_DIRECTOR: { name: "Amandeep Singh", empNo: "CY1753" },
    DELIVERY_DIRECTOR: { name: "Deepti Sharma", empNo: "CY1166" },
    VP: { name: "Amy Gupta", empNo: "CY788" },
  };
  const out = computeRecruiterHierarchyRoleChanges(CARONE_FROZEN, current);
  assert.equal(out.changed, true);
  assert.equal(out.moves.length, 1);
  assert.equal(out.moves[0].fromRole, "TEAM_LEAD");
  assert.equal(out.moves[0].toRole, "ACCOUNT_MANAGER");
  assert.equal(out.moves[0].name, "Udit Sharma");
  assert.equal(out.moves[0].empNoRaw, "CY4978");
  assert.equal(out.moves[0].displacedName, null); // target was empty
  // Regular fields: TEAM_LEAD vacated, ACCOUNT_MANAGER filled with Udit + emp-no.
  assert.equal(out.updatedFields.TEAM_LEAD, null);
  assert.equal(out.updatedFields.TEAM_LEAD_EMP_NO, null);
  assert.equal(out.updatedFields.ACCOUNT_MANAGER, "Udit Sharma");
  assert.equal(out.updatedFields.ACCOUNT_MANAGER_EMP_NO, "CY4978");
  assert.deepEqual(out.newPersons, []); // nobody new; Amandeep/Deepti/Amy unchanged
});

test("brand-new person appears in a role -> inorganic only, no move, no field change", () => {
  const current = {
    TEAM_LEAD: { name: "Udit Sharma", empNo: "CY4978" },
    RM: { name: "Deeksha Gaur", empNo: "CY5325" }, // NEW: RM was empty in frozen
    ASSOCIATE_DELIVERY_DIRECTOR: { name: "Amandeep Singh", empNo: "CY1753" },
    DELIVERY_DIRECTOR: { name: "Deepti Sharma", empNo: "CY1166" },
    VP: { name: "Amy Gupta", empNo: "CY788" },
  };
  const out = computeRecruiterHierarchyRoleChanges(CARONE_FROZEN, current);
  assert.equal(out.changed, false);
  assert.deepEqual(out.moves, []);
  assert.deepEqual(out.updatedFields, {});
  assert.equal(out.newPersons.length, 1);
  assert.equal(out.newPersons[0].designation, "RM");
  assert.equal(out.newPersons[0].name, "Deeksha Gaur");
  assert.equal(out.newPersons[0].empNoRaw, "CY5325");
});

test("move vacates a slot AND a new person fills the vacated slot -> one move + one inorganic", () => {
  const current = {
    ACCOUNT_MANAGER: { name: "Udit Sharma", empNo: "CY4978" }, // Udit promoted TL -> AM
    TEAM_LEAD: { name: "New Lead", empNo: "CY9999" },           // new person is now TL
    ASSOCIATE_DELIVERY_DIRECTOR: { name: "Amandeep Singh", empNo: "CY1753" },
    DELIVERY_DIRECTOR: { name: "Deepti Sharma", empNo: "CY1166" },
    VP: { name: "Amy Gupta", empNo: "CY788" },
  };
  const out = computeRecruiterHierarchyRoleChanges(CARONE_FROZEN, current);
  assert.equal(out.moves.length, 1);
  assert.equal(out.moves[0].fromRole, "TEAM_LEAD");
  assert.equal(out.moves[0].toRole, "ACCOUNT_MANAGER");
  // Udit's vacated TEAM_LEAD field is cleared (the new TL is inorganic, not written to regular).
  assert.equal(out.updatedFields.TEAM_LEAD, null);
  assert.equal(out.updatedFields.ACCOUNT_MANAGER, "Udit Sharma");
  assert.equal(out.newPersons.length, 1);
  assert.equal(out.newPersons[0].designation, "TEAM_LEAD");
  assert.equal(out.newPersons[0].empNoRaw, "CY9999");
});

test("collision: mover targets an occupied field -> new wins, displaced frozen person -> inorganic", () => {
  // Udit (frozen TEAM_LEAD) promoted to GROUP DIRECTOR, where Amandeep already sits (frozen).
  // Amandeep is NOT elsewhere in the current chain (disappeared from it) -> displaced.
  const current = {
    ASSOCIATE_DELIVERY_DIRECTOR: { name: "Udit Sharma", empNo: "CY4978" }, // Udit now Group Director
    DELIVERY_DIRECTOR: { name: "Deepti Sharma", empNo: "CY1166" },
    VP: { name: "Amy Gupta", empNo: "CY788" },
  };
  const out = computeRecruiterHierarchyRoleChanges(CARONE_FROZEN, current);
  assert.equal(out.moves.length, 1);
  assert.equal(out.moves[0].toRole, "ASSOCIATE_DELIVERY_DIRECTOR");
  assert.equal(out.moves[0].displacedName, "Amandeep Singh"); // Amandeep was there
  assert.equal(out.moves[0].displacedEmpNoRaw, "CY1753");
  // New wins: GRP_DIR field now holds Udit.
  assert.equal(out.updatedFields.ASSOCIATE_DELIVERY_DIRECTOR, "Udit Sharma");
  assert.equal(out.updatedFields.ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO, "CY4978");
  assert.equal(out.updatedFields.TEAM_LEAD, null); // Udit's old field vacated
  // Displaced Amandeep surfaced as inorganic under the contested role.
  assert.equal(out.newPersons.length, 1);
  assert.equal(out.newPersons[0].empNoRaw, "CY1753");
  assert.equal(out.newPersons[0].designation, "ASSOCIATE_DELIVERY_DIRECTOR");
});

test("frozen person disappears from chain (no new role) -> left frozen, no move, no vacate", () => {
  // Deepti Sharma (frozen DELIVERY_DIRECTOR) is simply gone from the live chain.
  const current = {
    TEAM_LEAD: { name: "Udit Sharma", empNo: "CY4978" },
    ASSOCIATE_DELIVERY_DIRECTOR: { name: "Amandeep Singh", empNo: "CY1753" },
    VP: { name: "Amy Gupta", empNo: "CY788" },
  };
  const out = computeRecruiterHierarchyRoleChanges(CARONE_FROZEN, current);
  assert.equal(out.changed, false);
  assert.deepEqual(out.moves, []);
  assert.deepEqual(out.updatedFields, {}); // DELIVERY_DIRECTOR stays frozen (not cleared)
  assert.deepEqual(out.newPersons, []);
});

test("emp-no compare is trim/case-insensitive (no false move on formatting)", () => {
  const current = {
    TEAM_LEAD: { name: "Udit Sharma", empNo: " cy4978 " },
    ASSOCIATE_DELIVERY_DIRECTOR: { name: "Amandeep Singh", empNo: "CY1753" },
    DELIVERY_DIRECTOR: { name: "Deepti Sharma", empNo: "CY1166" },
    VP: { name: "Amy Gupta", empNo: "CY788" },
  };
  const out = computeRecruiterHierarchyRoleChanges(CARONE_FROZEN, current);
  assert.equal(out.changed, false);
});

test("empty/blank inputs -> no-op", () => {
  assert.deepEqual(computeRecruiterHierarchyRoleChanges(null, null), {
    moves: [], updatedFields: {}, newPersons: [], changed: false,
  });
  assert.deepEqual(computeRecruiterHierarchyRoleChanges({}, {}), {
    moves: [], updatedFields: {}, newPersons: [], changed: false,
  });
});
