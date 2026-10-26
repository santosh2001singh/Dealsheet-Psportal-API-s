const test = require("node:test");
const assert = require("node:assert/strict");

const {
  findPreviousRecruiterSeatInChain,
  applyPreviousRecruiterIntoNewRecruiterHierarchyForRows,
} = require("./bigQueryClient");

/**
 * Placement 1472372 (Oct 2026): recruiter Alex Smith (Recruitment Manager, CY3248) -> Kartik Gupta
 * (CY5372), who reports to Alex. The append carried RM empty; Alex belongs in RM.
 */
const KARTIK_CHAIN = [
  { hierarchy_level: "1", manager_name: "Alex Smith", manager_employee_id: "CY3248", manager_title: "Recruitment Manager" },
  { hierarchy_level: "2", manager_name: "Neelesh Vijay", manager_employee_id: "CY1615", manager_title: "Sr. Delivery Manager" },
  { hierarchy_level: "3", manager_name: "Deepti Sharma", manager_employee_id: "CY1166", manager_title: "Delivery Director" },
  { hierarchy_level: "4", manager_name: "Amy Gupta", manager_employee_id: "CY788", manager_title: "Vice President - Delivery" },
];

function appendRow(overrides) {
  return {
    PLACEMENT_ID: "1472372",
    DEAL_TYPE: "DEAL",
    ASSIGNMENT_RECRUITER: "Kartik Gupta (R1N)",
    ASSIGNMENT_RECRUITER_EMAIL: "kartik.g@cynethealth.com",
    RECRUITER_EMP_NO: "CY5372",
    RM: null,
    RM_EMP_NO: null,
    ACCOUNT_MANAGER: "Neelesh Vijay",
    ACCOUNT_MANAGER_EMP_NO: "CY1615",
    __PREV_RECRUITER_NAME: "Alex Smith (R1N)",
    __PREV_RECRUITER_EMAIL: "alex.s2@cynethealth.com",
    __PREV_RECRUITER_EMP_NO: "CY3248",
    __CARRIED_FORWARD_UPDATE: true,
    ...overrides,
  };
}

function deps(chain = KARTIK_CHAIN, titleColumns = new Map()) {
  const calls = { chain: 0 };
  return {
    calls,
    directoryFetchFn: async () => new Map([["kartik.g@cynethealth.com", { externalId: "104861822205443648023" }]]),
    chainFetchFn: async (targets) => {
      calls.chain++;
      return new Map(targets.map((t) => [t.key, chain]));
    },
    titleColumnFetchFn: async () => titleColumns,
  };
}

test("previous recruiter is the new recruiter's RM -> RM filled with them", async () => {
  const [row] = await applyPreviousRecruiterIntoNewRecruiterHierarchyForRows([appendRow({})], deps());
  assert.equal(row.RM, "Alex Smith");
  assert.equal(row.RM_EMP_NO, "CY3248");
  assert.equal(row.ACCOUNT_MANAGER, "Neelesh Vijay");
});

test("chain is read on/before NEW_HIRE_DATE, like the insert-time hierarchy", async () => {
  const seen = [];
  const d = deps();
  d.chainFetchFn = async (targets, opts) => {
    for (const t of targets) seen.push({ anchorDate: t.anchorDate, direction: opts.direction });
    return new Map(targets.map((t) => [t.key, KARTIK_CHAIN]));
  };
  const nhd = "2026-10-21T20:18:11.000Z";
  const [row] = await applyPreviousRecruiterIntoNewRecruiterHierarchyForRows([appendRow({ NEW_HIRE_DATE: nhd })], d);
  assert.deepEqual(seen, [{ anchorDate: nhd, direction: "on_or_before" }]);
  assert.equal(row.RM, "Alex Smith");
});

test("overwrites a different frozen holder of that seat", async () => {
  const [row] = await applyPreviousRecruiterIntoNewRecruiterHierarchyForRows(
    [appendRow({ RM: "Old Rm", RM_EMP_NO: "CY1" })],
    deps()
  );
  assert.equal(row.RM, "Alex Smith");
  assert.equal(row.RM_EMP_NO, "CY3248");
});

test("previous recruiter not in the new chain -> row unchanged", async () => {
  const input = appendRow({ __PREV_RECRUITER_NAME: "Someone Else", __PREV_RECRUITER_EMP_NO: "CY42" });
  const [row] = await applyPreviousRecruiterIntoNewRecruiterHierarchyForRows([input], deps());
  assert.equal(row, input);
});

test("no recruiter change (first insert / no __PREV_*) -> no lookup at all", async () => {
  const d = deps();
  const input = appendRow({ __PREV_RECRUITER_NAME: undefined, __PREV_RECRUITER_EMP_NO: undefined });
  const [row] = await applyPreviousRecruiterIntoNewRecruiterHierarchyForRows([input], d);
  assert.equal(row, input);
  assert.equal(d.calls.chain, 0);
});

test("first insert (not a carried-forward update) is left to the normal backfill", async () => {
  const d = deps();
  const input = appendRow({ __CARRIED_FORWARD_UPDATE: undefined });
  await applyPreviousRecruiterIntoNewRecruiterHierarchyForRows([input], d);
  assert.equal(d.calls.chain, 0);
});

test("NULL title on the snapshot -> designation from the directory title", () => {
  const chain = [{ ...KARTIK_CHAIN[0], manager_title: null }, ...KARTIK_CHAIN.slice(1)];
  const seat = findPreviousRecruiterSeatInChain(appendRow({}), chain, new Map([["CY3248", "RM"]]));
  assert.deepEqual(seat, { column: "RM", empNoColumn: "RM_EMP_NO", name: "Alex Smith", empNo: "CY3248" });
});

test("unresolvable title -> no seat", () => {
  const chain = [{ ...KARTIK_CHAIN[0], manager_title: null }];
  assert.equal(findPreviousRecruiterSeatInChain(appendRow({}), chain, new Map()), null);
});

test("matches on name (cluster suffix stripped) when the previous emp-no is missing", () => {
  const seat = findPreviousRecruiterSeatInChain(appendRow({ __PREV_RECRUITER_EMP_NO: null }), KARTIK_CHAIN);
  assert.equal(seat?.column, "RM");
  assert.equal(seat?.empNo, "CY3248");
});

test("manual designations (SECONDARY_AM) are never auto-filled", () => {
  const chain = [{ ...KARTIK_CHAIN[0], manager_title: "Secondary AM" }];
  assert.equal(findPreviousRecruiterSeatInChain(appendRow({}), chain), null);
});
