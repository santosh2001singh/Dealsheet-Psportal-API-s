const test = require("node:test");
const assert = require("node:assert/strict");

const {
  rowNeedsDealRecruiterHierarchyBackfill,
  applyDealRecruiterHierarchyForInsertRows,
} = require("./bigQueryClient");
const { resolveHierarchyColumnForTitle } = require("./recruiterHierarchyDesignations");

test("resolveHierarchyColumnForTitle maps known designations, case/whitespace-insensitive", () => {
  assert.equal(resolveHierarchyColumnForTitle("ATL"), "ATL");
  assert.equal(resolveHierarchyColumnForTitle("  associate team lead "), "ATL");
  assert.equal(resolveHierarchyColumnForTitle("Secondary Recruitment Manager"), "SECONDARY_RECRUITER");
  assert.equal(resolveHierarchyColumnForTitle("Sr. Team Lead"), "TEAM_LEAD");
  assert.equal(resolveHierarchyColumnForTitle("Recruitment Manager"), "RM");
  assert.equal(resolveHierarchyColumnForTitle("Secondary Delivery Manager"), "SECONDARY_AM");
  assert.equal(resolveHierarchyColumnForTitle("Associate Delivery Manager"), "ASSOCIATE_AM");
  assert.equal(resolveHierarchyColumnForTitle("Sr. Delivery Manager"), "ACCOUNT_MANAGER");
  assert.equal(resolveHierarchyColumnForTitle("Delivery Director"), "DELIVERY_DIRECTOR");
  assert.equal(resolveHierarchyColumnForTitle("Associate Group Director"), "GRP_DIR_ASSOC_GRP_DIR");
  assert.equal(resolveHierarchyColumnForTitle("Associate Vice President - Delivery"), "VP_SRVP");
  assert.equal(resolveHierarchyColumnForTitle("SrVP"), "VP_SRVP");
  assert.equal(resolveHierarchyColumnForTitle("Chief Growth Officer (CGO)"), null);
  assert.equal(resolveHierarchyColumnForTitle(null), null);
  assert.equal(resolveHierarchyColumnForTitle(""), null);
});

test("rowNeedsDealRecruiterHierarchyBackfill requires DEAL_TYPE=DEAL, recruiter email, PLACEMENT_ID, and an empty hierarchy field", () => {
  const base = {
    DEAL_TYPE: "DEAL",
    ASSIGNMENT_RECRUITER_EMAIL: "recruiter@cynethealth.com",
    PLACEMENT_ID: 1,
    TEAM_LEAD: null,
  };
  assert.equal(rowNeedsDealRecruiterHierarchyBackfill(base), true);
  assert.equal(rowNeedsDealRecruiterHierarchyBackfill({ ...base, DEAL_TYPE: "EXTENSION" }), false);
  assert.equal(rowNeedsDealRecruiterHierarchyBackfill({ ...base, ASSIGNMENT_RECRUITER_EMAIL: null }), false);
  assert.equal(rowNeedsDealRecruiterHierarchyBackfill({ ...base, PLACEMENT_ID: null }), false);
  assert.equal(rowNeedsDealRecruiterHierarchyBackfill(null), false);

  const fullyFilled = {
    DEAL_TYPE: "DEAL",
    ASSIGNMENT_RECRUITER_EMAIL: "recruiter@cynethealth.com",
    PLACEMENT_ID: 1,
    ATL: "A", ATL_EMP_NO: "1",
    SECONDARY_RECRUITER: "A", SECONDARY_RECRUITER_EMP_NO: "1",
    TEAM_LEAD: "A", TEAM_LEAD_EMP_NO: "1",
    RM: "A", RM_EMP_NO: "1",
    SECONDARY_AM: "A", SECONDARY_AM_EMP_NO: "1",
    ASSOCIATE_AM: "A", ASSOCIATE_AM_EMP_NO: "1",
    ACCOUNT_MANAGER: "A", ACCOUNT_MANAGER_EMP_NO: "1",
    DELIVERY_DIRECTOR: "A", DELIVERY_DIRECTOR_EMP_NO: "1",
    GRP_DIR_ASSOC_GRP_DIR: "A", GRP_DIR_ASSOC_GRP_DIR_EMP_NO: "1",
    VP_SRVP: "A", VP_SRVP_EMP_NO: "1",
  };
  assert.equal(rowNeedsDealRecruiterHierarchyBackfill(fullyFilled), false);
});

test("applyDealRecruiterHierarchyForInsertRows fills empty hierarchy fields on eligible DEAL rows only", async () => {
  const rows = [
    {
      DEAL_TYPE: "DEAL",
      PLACEMENT_ID: 111,
      ASSIGNMENT_RECRUITER_EMAIL: "divya.j@cynethealth.com",
      NEW_HIRE_DATE: "2026-01-01T00:00:00.000Z",
      TEAM_LEAD: null,
      TEAM_LEAD_EMP_NO: null,
      RM: null,
      RM_EMP_NO: null,
    },
    {
      DEAL_TYPE: "EXTENSION",
      PLACEMENT_ID: 222,
      ASSIGNMENT_RECRUITER_EMAIL: "divya.j@cynethealth.com",
      TEAM_LEAD: null,
    },
  ];

  const fetchFn = async (eligible) => {
    assert.equal(eligible.length, 1);
    assert.equal(eligible[0].PLACEMENT_ID, 111);
    return new Map([
      [
        "111",
        {
          TEAM_LEAD: "Ajay Kumar",
          TEAM_LEAD_EMP_NO: "CY2393",
          RM: "Nikhil Sharma",
          RM_EMP_NO: "CY2431",
        },
      ],
    ]);
  };

  const out = await applyDealRecruiterHierarchyForInsertRows(rows, {}, { fetchFn });
  assert.equal(out[0].TEAM_LEAD, "Ajay Kumar");
  assert.equal(out[0].TEAM_LEAD_EMP_NO, "CY2393");
  assert.equal(out[0].RM, "Nikhil Sharma");
  assert.equal(out[0].RM_EMP_NO, "CY2431");
  assert.equal(out[1].TEAM_LEAD, null);
});

test("applyDealRecruiterHierarchyForInsertRows never overwrites an already-present value", async () => {
  const rows = [
    {
      DEAL_TYPE: "DEAL",
      PLACEMENT_ID: 111,
      ASSIGNMENT_RECRUITER_EMAIL: "divya.j@cynethealth.com",
      TEAM_LEAD: "Manually Set Lead",
      TEAM_LEAD_EMP_NO: null,
      RM: null,
    },
  ];

  const fetchFn = async () =>
    new Map([
      [
        "111",
        {
          TEAM_LEAD: "Directory Lead",
          TEAM_LEAD_EMP_NO: "CY9999",
          RM: "Directory RM",
        },
      ],
    ]);

  const out = await applyDealRecruiterHierarchyForInsertRows(rows, {}, { fetchFn });
  assert.equal(out[0].TEAM_LEAD, "Manually Set Lead");
  assert.equal(out[0].TEAM_LEAD_EMP_NO, "CY9999");
  assert.equal(out[0].RM, "Directory RM");
});

test("applyDealRecruiterHierarchyForInsertRows is a no-op when no rows are eligible (fetchFn never called)", async () => {
  const rows = [
    {
      DEAL_TYPE: "DEAL",
      PLACEMENT_ID: 111,
      ASSIGNMENT_RECRUITER_EMAIL: "divya.j@cynethealth.com",
      TEAM_LEAD: "Already Set",
      ATL: "Already Set", ATL_EMP_NO: "1",
      SECONDARY_RECRUITER: "Already Set", SECONDARY_RECRUITER_EMP_NO: "1",
      TEAM_LEAD_EMP_NO: "1",
      RM: "Already Set", RM_EMP_NO: "1",
      SECONDARY_AM: "Already Set", SECONDARY_AM_EMP_NO: "1",
      ASSOCIATE_AM: "Already Set", ASSOCIATE_AM_EMP_NO: "1",
      ACCOUNT_MANAGER: "Already Set", ACCOUNT_MANAGER_EMP_NO: "1",
      DELIVERY_DIRECTOR: "Already Set", DELIVERY_DIRECTOR_EMP_NO: "1",
      GRP_DIR_ASSOC_GRP_DIR: "Already Set", GRP_DIR_ASSOC_GRP_DIR_EMP_NO: "1",
      VP_SRVP: "Already Set", VP_SRVP_EMP_NO: "1",
    },
  ];
  let called = false;
  const fetchFn = async () => {
    called = true;
    return new Map();
  };
  const out = await applyDealRecruiterHierarchyForInsertRows(rows, {}, { fetchFn });
  assert.equal(called, false);
  assert.equal(out[0].TEAM_LEAD, "Already Set");
});
