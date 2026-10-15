const test = require("node:test");
const assert = require("node:assert/strict");

const {
  OWNERSHIP_LOG_SOURCE,
  DATA_TEAM_EDITED_BY,
  CONTRACT_CHAIN_NOTE,
  normalizeOwnerName,
  isSameOwnershipChange,
  filterNewOwnershipLogRows,
  buildOwnershipPlacementIndex,
  resolveOwnershipEffectiveDate,
  changeFieldRoleSpec,
  hierarchySeatRoleSpec,
  buildOwnershipChangeLogRowsFromIndex,
  resolveStoredOwnershipLogDates,
} = require("./ownershipChangeLogRules");

/**
 * The ownership_change_logs rules agreed on 2026-10-02 (docs/OWNERSHIP_LOGS.md). The scenarios are the
 * real cases that produced duplicates before: one change logged on every open extension with a
 * different date each time (Kayann Roopchan, CHC12569), a new extension starting with the new owner
 * (Sumiko Braxton / Ramona), a placement that never started, and the data team's history.
 */

const ONSITE_AM = changeFieldRoleSpec({
  role: "ONSITE_AM",
  nameField: "ONSITE_AM",
  changeField: "ONSITE_AM_EMAIL",
  empField: null,
});
const RECRUITER = changeFieldRoleSpec({
  role: "RECRUITER",
  nameField: "ASSIGNMENT_RECRUITER",
  changeField: "ASSIGNMENT_RECRUITER_EMAIL",
  empField: "RECRUITER_EMP_NO",
});
const VP_SEAT = hierarchySeatRoleSpec({ column: "VP", empNoColumn: "VP_EMP_NO" });
const RM_TARGET = { column: "RM", empNoColumn: "RM_EMP_NO" };

const NOW = "2026-10-02T13:00:00.000Z";

function version(placementId, lastUpdated, overrides = {}) {
  return {
    PLACEMENT_ID: placementId,
    CONTRACT_ID: "CHC12569",
    SKU_NUMBER: "H9198",
    CANDIDATE_NAME: "Kayann Roopchan",
    DEAL_TYPE: "EXTENSION",
    PLACEMENT_STATUS: "STARTED",
    LAST_UPDATED: { value: lastUpdated },
    INITIAL_START_DATE: { value: "2023-09-24" },
    ONSITE_AM: "Elisa An",
    ONSITE_AM_EMAIL: "elisa@client.com",
    ASSIGNMENT_RECRUITER: "Jeet Singh (FED)",
    ASSIGNMENT_RECRUITER_EMAIL: "jeet@cynet.com",
    RECRUITER_EMP_NO: "CY100",
    ...overrides,
  };
}
const JESSICA = { ONSITE_AM: "Jessica Van Essen", ONSITE_AM_EMAIL: "jessica@client.com" };

function build(versions, specs = [ONSITE_AM], extra = {}) {
  return buildOwnershipChangeLogRowsFromIndex(buildOwnershipPlacementIndex(versions), {
    roleSpecsForContract: () => specs,
    nowIso: NOW,
    ...extra,
  });
}

// Kayann Roopchan, CHC12569: 1455684 ended 09-12, 1466112 ran 09-13..10-17, 1466705 booked from 11-19.
// On 09-15 the onsite AM changed and the update reached BOTH open placements.
const P1 = (t, o) => version("1455684", t, { START_DATE: "2026-06-07", END_DATE: "2026-09-12", TENTATIVE_END_DATE: "2026-09-12", PLACEMENT_STATUS: "ENDED", ...o });
const P2 = (t, o) => version("1466112", t, { START_DATE: "2026-09-13", TENTATIVE_END_DATE: "2026-10-17", ...o });
const P3 = (t, o) => version("1466705", t, { START_DATE: "2026-11-19", TENTATIVE_END_DATE: "2026-12-09", PLACEMENT_STATUS: "BOOKED", ...o });

const kayann = () => [
  P1("2026-08-19T09:54:55Z"),
  P2("2026-08-19T09:51:50Z"),
  P2("2026-09-15T15:59:07Z", JESSICA),
  P3("2026-08-19T20:03:05Z"),
  P3("2026-09-15T17:13:22Z", JESSICA),
];

test("one change applied to every open extension is ONE row, on the placement where it happened", () => {
  const rows = build(kayann());
  assert.equal(rows.length, 1);
  const [r] = rows;
  assert.equal(r.PLACEMENT_ID, "1466112");
  assert.equal(r.PREVIOUS_OWNER_NAME, "Elisa An");
  assert.equal(r.NEW_OWNER_NAME, "Jessica Van Essen");
  assert.equal(r.CHANGE_REASON_NOTES, null, "a mid-placement change is not a contract-chain handover");
});

test("mid-placement change: effective from the next extension's START_DATE once it is booked", () => {
  const [r] = build(kayann());
  assert.equal(r.OWNERSHIP_EFFECTIVE_DATE, "2026-11-19");
  assert.equal(r.END_DATE_PREVIOUS_OWNER, "2026-11-18");
  assert.equal(r.EFFECTIVE_DATE_SOURCE, OWNERSHIP_LOG_SOURCE.EXTENSION_START);
  assert.equal(r.EFFECTIVE_DATE_PLACEMENT_ID, "1466705");
});

test("mid-placement change with no extension yet: TENTATIVE_END_DATE + 1, provisional", () => {
  const [r] = build(kayann().filter((v) => v.PLACEMENT_ID !== "1466705"));
  assert.equal(r.OWNERSHIP_EFFECTIVE_DATE, "2026-10-18");
  assert.equal(r.END_DATE_PREVIOUS_OWNER, "2026-10-17");
  assert.equal(r.EFFECTIVE_DATE_SOURCE, OWNERSHIP_LOG_SOURCE.TENTATIVE_PLUS_1);
  assert.equal(r.EFFECTIVE_DATE_PLACEMENT_ID, "1466112");
});

test("END_DATE wins over TENTATIVE_END_DATE for the provisional date", () => {
  const versions = kayann()
    .filter((v) => v.PLACEMENT_ID !== "1466705")
    .map((v) => (v.PLACEMENT_ID === "1466112" ? { ...v, END_DATE: "2026-10-10" } : v));
  const [r] = build(versions);
  assert.equal(r.OWNERSHIP_EFFECTIVE_DATE, "2026-10-11");
  assert.equal(r.EFFECTIVE_DATE_SOURCE, OWNERSHIP_LOG_SOURCE.END_PLUS_1);
});

test("the row carries the placement's START_DATE, INITIAL_START_DATE, SKU and contract", () => {
  const [r] = build(kayann());
  assert.equal(r.START_DATE, "2026-09-13");
  assert.equal(r.INITIAL_START_DATE, "2023-09-24");
  assert.equal(r.SKU_NO, "H9198");
  assert.equal(r.CONTRACT_ID, "CHC12569");
  assert.equal(r.LAST_UPDATED, NOW);
  assert.equal(r.EDITED_BY, null);
});

test("a new extension that starts with the new owner: effective = that extension's START_DATE", () => {
  // Sumiko Braxton (CHC19648): 1443773 had Samantha, 1451178 started 04-01 with Julianna.
  const versions = [
    version("1443773", "2026-08-19T11:12:58Z", { CONTRACT_ID: "CHC19648", START_DATE: "2026-02-08", END_DATE: "2026-03-31", TENTATIVE_END_DATE: "2026-05-16", PLACEMENT_STATUS: "ENDED", ONSITE_AM: "Samantha Carter", ONSITE_AM_EMAIL: "sam@client.com" }),
    version("1451178", "2026-08-19T10:59:38Z", { CONTRACT_ID: "CHC19648", START_DATE: "2026-04-01", END_DATE: "2026-05-16", ONSITE_AM: "Julianna Shilliday", ONSITE_AM_EMAIL: "julianna@client.com" }),
  ];
  const [r] = build(versions);
  assert.equal(r.PLACEMENT_ID, "1451178");
  assert.equal(r.OWNERSHIP_EFFECTIVE_DATE, "2026-04-01");
  assert.equal(r.EFFECTIVE_DATE_SOURCE, OWNERSHIP_LOG_SOURCE.EXTENSION_START);
  assert.equal(r.EFFECTIVE_DATE_PLACEMENT_ID, "1451178");
  assert.equal(r.CHANGE_REASON_NOTES, CONTRACT_CHAIN_NOTE);
});

test("changed on a booked extension before it starts: effective from its START_DATE", () => {
  const versions = [
    P1("2026-08-19T09:54:55Z", { END_DATE: null, PLACEMENT_STATUS: "STARTED", TENTATIVE_END_DATE: "2026-09-12" }),
    P2("2026-08-19T09:51:50Z", { PLACEMENT_STATUS: "BOOKED" }),
    P2("2026-09-01T10:00:00Z", { PLACEMENT_STATUS: "BOOKED", ...JESSICA }),
  ];
  const [r] = build(versions);
  assert.equal(r.PLACEMENT_ID, "1466112");
  assert.equal(r.OWNERSHIP_EFFECTIVE_DATE, "2026-09-13");
  assert.equal(r.EFFECTIVE_DATE_SOURCE, OWNERSHIP_LOG_SOURCE.EXTENSION_START);
  assert.equal(r.CHANGE_REASON_NOTES, CONTRACT_CHAIN_NOTE);
});

test("DID NOT START: END_DATE + 1, never moved to a later extension", () => {
  const versions = [
    P1("2026-08-19T09:00:00Z"),
    P2("2026-08-19T09:10:00Z", { PLACEMENT_STATUS: "DID NOT START", END_DATE: "2026-09-13", TENTATIVE_END_DATE: null }),
    P2("2026-09-15T15:59:07Z", { PLACEMENT_STATUS: "DID NOT START", END_DATE: "2026-09-13", TENTATIVE_END_DATE: null, ...JESSICA }),
    P3("2026-08-19T20:03:05Z"),
    P3("2026-09-15T17:13:22Z", JESSICA),
  ];
  const [r] = build(versions);
  assert.equal(r.PLACEMENT_ID, "1466112");
  assert.equal(r.OWNERSHIP_EFFECTIVE_DATE, "2026-09-14");
  assert.equal(r.EFFECTIVE_DATE_SOURCE, OWNERSHIP_LOG_SOURCE.END_PLUS_1);
  assert.equal(r.EFFECTIVE_DATE_PLACEMENT_ID, "1466112");
});

test("a never-started extension is skipped when looking for the next extension", () => {
  const versions = [
    ...kayann().filter((v) => v.PLACEMENT_ID !== "1466705"),
    P3("2026-08-19T20:03:05Z", { PLACEMENT_STATUS: "DID NOT ACCEPT" }),
    P3("2026-09-15T17:13:22Z", { PLACEMENT_STATUS: "DID NOT ACCEPT", ...JESSICA }),
  ];
  const [r] = build(versions);
  assert.equal(r.EFFECTIVE_DATE_SOURCE, OWNERSHIP_LOG_SOURCE.TENTATIVE_PLUS_1);
  assert.equal(r.OWNERSHIP_EFFECTIVE_DATE, "2026-10-18");
});

test("an update that later reaches the previous placement too is not read as a switch back", () => {
  // The old ended placement is touched AFTER the new one was booked with the new owner.
  const versions = [
    P1("2026-08-01T00:00:00Z"),
    P2("2026-08-10T00:00:00Z", JESSICA),
    P1("2026-08-20T00:00:00Z", JESSICA),
  ];
  const rows = build(versions);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].NEW_OWNER_NAME, "Jessica Van Essen");
  assert.equal(rows[0].OWNERSHIP_EFFECTIVE_DATE, "2026-09-13");
});

test("a contract rebuilt in one go (same timestamp everywhere) still finds the handover", () => {
  const t = "2026-08-19T09:50:00Z";
  const rows = build([P1(t), P2(t, JESSICA), P3(t, JESSICA)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].PLACEMENT_ID, "1466112");
  assert.equal(rows[0].OWNERSHIP_EFFECTIVE_DATE, "2026-09-13");
});

test("the first owner of a contract is not a change", () => {
  assert.equal(build([P1("2026-08-01T00:00:00Z"), P2("2026-08-02T00:00:00Z")]).length, 0);
});

test("a blank value is unknown both ways: no removal, and filling it in is no handover", () => {
  const blank = { ONSITE_AM: null, ONSITE_AM_EMAIL: null };
  assert.equal(build([P2("2026-09-14T00:00:00Z"), P2("2026-09-15T00:00:00Z", blank)]).length, 0);
  assert.equal(
    build([P2("2026-09-14T00:00:00Z"), P2("2026-09-15T00:00:00Z", blank), P2("2026-09-16T00:00:00Z")]).length,
    0,
    "losing the value and getting the same owner back is no change"
  );
  // CSM levels backfilled on 2026-08-19: blank -> a name is not a change...
  assert.equal(build([P2("2026-09-14T00:00:00Z", blank), P2("2026-09-15T00:00:00Z", JESSICA)]).length, 0);
  // ...but a real handover after it still is.
  const [handover] = build([
    P2("2026-09-14T00:00:00Z", blank),
    P2("2026-09-15T00:00:00Z", JESSICA),
    P2("2026-09-20T00:00:00Z"),
  ]);
  assert.equal(handover.PREVIOUS_OWNER_NAME, "Jessica Van Essen");
  assert.equal(handover.NEW_OWNER_NAME, "Elisa An");
});

test("an email that differs only in case is the same owner", () => {
  const rows = build([P2("2026-09-14T00:00:00Z"), P2("2026-09-15T00:00:00Z", { ONSITE_AM_EMAIL: "ELISA@client.com" })]);
  assert.equal(rows.length, 0);
});

test("recruiter change: RECRUITER row with emp nos, plus the seat the new recruiter vacated", () => {
  const prev = P2("2026-09-14T00:00:00Z", { RM: "Rahul", RM_EMP_NO: "CY20" });
  const next = P2("2026-09-15T00:00:00Z", {
    ASSIGNMENT_RECRUITER: "Rahul",
    ASSIGNMENT_RECRUITER_EMAIL: "rahul@cynet.com",
    RECRUITER_EMP_NO: "CY20",
    RM: "Rahul",
    RM_EMP_NO: "CY20",
  });
  const rows = build([prev, next], [RECRUITER], { recruiterVacateTargetsForContract: () => [RM_TARGET] });
  const byRole = Object.fromEntries(rows.map((r) => [r.OWNERSHIP_ROLE, r]));
  assert.deepEqual(Object.keys(byRole).sort(), ["RECRUITER", "RM"]);
  assert.equal(byRole.RECRUITER.PREVIOUS_OWNER_EMP_NO, "CY100");
  assert.equal(byRole.RECRUITER.NEW_OWNER_EMP_NO, "CY20");
  assert.equal(byRole.RM.PREVIOUS_OWNER_NAME, "Rahul");
  assert.equal(byRole.RM.NEW_OWNER_NAME, "NA");
  assert.equal(byRole.RM.NEW_OWNER_EMP_NO, "NA");
});

test("hierarchy seat: NA placeholder equals an empty seat; a vacate is logged with NEW = NA", () => {
  const withVp = { VP: "Varun Gupta", VP_EMP_NO: "CY760" };
  assert.equal(build([P2("2026-09-14T00:00:00Z", { VP: "NA", VP_EMP_NO: "NA" }), P2("2026-09-15T00:00:00Z", { VP: null, VP_EMP_NO: null })], [VP_SEAT]).length, 0);
  const [vacate] = build([P2("2026-09-14T00:00:00Z", withVp), P2("2026-09-15T00:00:00Z", { VP: null, VP_EMP_NO: null })], [VP_SEAT]);
  assert.deepEqual([vacate.PREVIOUS_OWNER_NAME, vacate.PREVIOUS_OWNER_EMP_NO, vacate.NEW_OWNER_NAME, vacate.NEW_OWNER_EMP_NO], ["Varun Gupta", "CY760", "NA", "NA"]);
  assert.equal(
    build([P2("2026-09-14T00:00:00Z", withVp), P2("2026-09-15T00:00:00Z", { VP: "Varun Kumar Gupta", VP_EMP_NO: "CY760" })], [VP_SEAT]).length,
    0,
    "a re-spelled name with the same emp no is not a change"
  );
});

test("a placement belongs to the contract on its LATEST version (re-minted CONTRACT_ID)", () => {
  // 1453468 once carried CHC21460, now CHC23684: it must not join CHC21460's chain.
  const index = buildOwnershipPlacementIndex([
    version("1445652", "2026-08-19T11:09:23Z", { CONTRACT_ID: "CHC21460", START_DATE: "2026-03-16" }),
    version("1453468", "2026-08-19T09:00:00Z", { CONTRACT_ID: "CHC21460", START_DATE: "2026-04-01" }),
    version("1453468", "2026-09-01T09:00:00Z", { CONTRACT_ID: "CHC23684", START_DATE: "2026-04-01", ...JESSICA }),
  ]);
  assert.deepEqual(index.contracts.get("CHC21460").map((p) => p.pid), ["1445652"]);
  assert.deepEqual(index.contracts.get("CHC23684").map((p) => p.pid), ["1453468"]);
});

test("observedPlacementIds keeps only changes first seen on those placements", () => {
  assert.equal(build(kayann(), [ONSITE_AM], { observedPlacementIds: new Set(["1466705"]) }).length, 0);
  assert.equal(build(kayann(), [ONSITE_AM], { observedPlacementIds: new Set(["1466112"]) }).length, 1);
});

test("resolveOwnershipEffectiveDate: no dates at all -> null date, anchor kept", () => {
  const index = buildOwnershipPlacementIndex([P2("2026-09-14T00:00:00Z", { TENTATIVE_END_DATE: null })]);
  const p = index.byPid.get("1466112");
  assert.deepEqual(resolveOwnershipEffectiveDate(p, [p]), {
    effectiveDate: null,
    endDatePreviousOwner: null,
    source: null,
    placementId: "1466112",
  });
});

// ---------------------------------------------------------------------------------------------
// Dedupe (rule 2)
// ---------------------------------------------------------------------------------------------

const dataTeamRow = (overrides = {}) => ({
  SKU_NO: "H9198",
  CONTRACT_ID: null,
  PLACEMENT_ID: null,
  OWNERSHIP_ROLE: "ONSITE_AM",
  PREVIOUS_OWNER_NAME: "Elisa An",
  PREVIOUS_OWNER_EMP_NO: null,
  NEW_OWNER_NAME: "Jessica Van Essen",
  NEW_OWNER_EMP_NO: null,
  EDITED_BY: DATA_TEAM_EDITED_BY,
  ...overrides,
});

test("a change the data team already logged (same SKU, role, owners) is not inserted again", () => {
  const [candidate] = build(kayann());
  const { fresh, skippedExisting } = filterNewOwnershipLogRows([candidate], [dataTeamRow()]);
  assert.equal(fresh.length, 0);
  assert.equal(skippedExisting, 1);
});

test("names match without the recruiter team tag and with NA == empty", () => {
  assert.equal(normalizeOwnerName("Marco Mcneil (R5A)"), "marco mcneil");
  assert.equal(normalizeOwnerName("  Alan   Rai (SPA) "), "alan rai");
  assert.equal(normalizeOwnerName("NA"), "");
  const sys = { CONTRACT_ID: "CHC21460", SKU_NO: "H134380_H14794", OWNERSHIP_ROLE: "RECRUITER", PREVIOUS_OWNER_NAME: "Akriti Singh", NEW_OWNER_NAME: "Marco Mcneil (R5A)" };
  const dt = { SKU_NO: "H134380_H14794", OWNERSHIP_ROLE: "RECRUITER", PREVIOUS_OWNER_NAME: "Akriti Singh", NEW_OWNER_NAME: "Marco Mcneil" };
  assert.equal(isSameOwnershipChange(sys, dt), true);
  assert.equal(
    isSameOwnershipChange(
      { ...sys, OWNERSHIP_ROLE: "LEVEL_2_CSM", PREVIOUS_OWNER_NAME: null, NEW_OWNER_NAME: "Jodi Stanton" },
      { ...dt, OWNERSHIP_ROLE: "LEVEL_2_CSM", PREVIOUS_OWNER_NAME: "NA", NEW_OWNER_NAME: "Jodi Stanton" }
    ),
    true
  );
});

test("emp nos decide when both sides carry one; otherwise the name does", () => {
  const a = { CONTRACT_ID: "C1", OWNERSHIP_ROLE: "VP", PREVIOUS_OWNER_NAME: "Maneet Gupta", PREVIOUS_OWNER_EMP_NO: "CY2088", NEW_OWNER_NAME: "NA", NEW_OWNER_EMP_NO: "NA" };
  assert.equal(isSameOwnershipChange(a, { ...a, PREVIOUS_OWNER_NAME: "M. Gupta" }), true, "same emp no, different spelling");
  assert.equal(isSameOwnershipChange(a, { ...a, PREVIOUS_OWNER_EMP_NO: "CY9999" }), false, "same name, different emp no");
  assert.equal(isSameOwnershipChange(a, { ...a, PREVIOUS_OWNER_EMP_NO: null }), true, "one side has no emp no: name decides");
});

test("a different role, contract or SKU is a different change", () => {
  const a = { CONTRACT_ID: "C1", SKU_NO: "S1", OWNERSHIP_ROLE: "ONSITE_AM", PREVIOUS_OWNER_NAME: "A", NEW_OWNER_NAME: "B" };
  assert.equal(isSameOwnershipChange(a, { ...a, OWNERSHIP_ROLE: "RECRUITER" }), false);
  assert.equal(isSameOwnershipChange(a, { ...a, CONTRACT_ID: "C2", SKU_NO: "S2" }), false);
  assert.equal(isSameOwnershipChange(a, { ...a, CONTRACT_ID: "C2" }), true, "same SKU is the same scope");
  assert.equal(isSameOwnershipChange(a, { ...a, NEW_OWNER_NAME: "C" }), false);
});

test("the same person arriving on the same date is the same change, whoever is named as previous", () => {
  // H8503: the deal sheet never showed Heather Hoffman, the data team did.
  const dt = { SKU_NO: "H8503", OWNERSHIP_ROLE: "ONSITE_AM", PREVIOUS_OWNER_NAME: "Heather Hoffman", NEW_OWNER_NAME: "Derick Yi", OWNERSHIP_EFFECTIVE_DATE: "2026-05-03" };
  const sys = { CONTRACT_ID: "CHC1", SKU_NO: "H8503", OWNERSHIP_ROLE: "ONSITE_AM", PREVIOUS_OWNER_NAME: "Jodi Stanton", NEW_OWNER_NAME: "Derick Yi", OWNERSHIP_EFFECTIVE_DATE: "2026-05-03" };
  assert.equal(isSameOwnershipChange(sys, dt), true);
  assert.equal(isSameOwnershipChange({ ...sys, OWNERSHIP_EFFECTIVE_DATE: "2026-05-10" }, dt), true, "within 7 days");
  assert.equal(isSameOwnershipChange({ ...sys, OWNERSHIP_EFFECTIVE_DATE: "2026-08-02" }, dt), false, "months apart: a different arrival");
  assert.equal(isSameOwnershipChange({ ...sys, OWNERSHIP_EFFECTIVE_DATE: null }, dt), false, "no date: owners must match");
  const vacate = { ...sys, PREVIOUS_OWNER_NAME: "Derick Yi", NEW_OWNER_NAME: "NA" };
  assert.equal(isSameOwnershipChange(vacate, { ...vacate, PREVIOUS_OWNER_NAME: "Someone Else" }), false, "a vacate must match on who left");
});

test("repeats within one batch: the first (earliest) wins", () => {
  const a = { CONTRACT_ID: "C1", OWNERSHIP_ROLE: "ONSITE_AM", PREVIOUS_OWNER_NAME: "A", NEW_OWNER_NAME: "B", PLACEMENT_ID: "1" };
  const { fresh, skippedBatch, skippedExisting } = filterNewOwnershipLogRows([a, { ...a, PLACEMENT_ID: "2" }], []);
  assert.deepEqual(fresh.map((r) => r.PLACEMENT_ID), ["1"]);
  assert.equal(skippedBatch, 1);
  assert.equal(skippedExisting, 0);
});

// ---------------------------------------------------------------------------------------------
// Date sync for stored rows (rule 3 over time)
// ---------------------------------------------------------------------------------------------

const indexOf = (versions) => buildOwnershipPlacementIndex(versions);
const storedRow = (overrides = {}) => ({
  ID: "row-1",
  PLACEMENT_ID: "1466112",
  CONTRACT_ID: "CHC12569",
  EDITED_BY: null,
  START_DATE: { value: "2026-09-13" },
  INITIAL_START_DATE: { value: "2023-09-24" },
  OWNERSHIP_EFFECTIVE_DATE: { value: "2026-10-18" },
  END_DATE_PREVIOUS_OWNER: { value: "2026-10-17" },
  EFFECTIVE_DATE_SOURCE: OWNERSHIP_LOG_SOURCE.TENTATIVE_PLUS_1,
  EFFECTIVE_DATE_PLACEMENT_ID: "1466112",
  ...overrides,
});

test("date sync: a provisional row becomes final once the next extension is booked", () => {
  const change = resolveStoredOwnershipLogDates(storedRow(), indexOf(kayann()));
  assert.deepEqual(change, {
    ID: "row-1",
    START_DATE: "2026-09-13",
    INITIAL_START_DATE: "2023-09-24",
    OWNERSHIP_EFFECTIVE_DATE: "2026-11-19",
    END_DATE_PREVIOUS_OWNER: "2026-11-18",
    EFFECTIVE_DATE_SOURCE: OWNERSHIP_LOG_SOURCE.EXTENSION_START,
    EFFECTIVE_DATE_PLACEMENT_ID: "1466705",
  });
});

test("date sync: nothing changed -> null (no DML)", () => {
  const settled = storedRow({
    OWNERSHIP_EFFECTIVE_DATE: "2026-11-19",
    END_DATE_PREVIOUS_OWNER: "2026-11-18",
    EFFECTIVE_DATE_SOURCE: OWNERSHIP_LOG_SOURCE.EXTENSION_START,
    EFFECTIVE_DATE_PLACEMENT_ID: "1466705",
  });
  assert.equal(resolveStoredOwnershipLogDates(settled, indexOf(kayann())), null);
});

test("date sync: a final row follows its extension's START_DATE when that moves", () => {
  const moved = kayann().map((v) => (v.PLACEMENT_ID === "1466705" ? { ...v, START_DATE: "2026-11-23" } : v));
  const change = resolveStoredOwnershipLogDates(
    storedRow({ OWNERSHIP_EFFECTIVE_DATE: "2026-11-19", END_DATE_PREVIOUS_OWNER: "2026-11-18", EFFECTIVE_DATE_SOURCE: "EXTENSION_START", EFFECTIVE_DATE_PLACEMENT_ID: "1466705" }),
    indexOf(moved)
  );
  assert.equal(change.OWNERSHIP_EFFECTIVE_DATE, "2026-11-23");
  assert.equal(change.EFFECTIVE_DATE_PLACEMENT_ID, "1466705");
});

test("date sync: the extension it pointed at never started -> back to the anchor's end + 1", () => {
  const cancelled = kayann().map((v) => (v.PLACEMENT_ID === "1466705" ? { ...v, PLACEMENT_STATUS: "DID NOT START" } : v));
  const change = resolveStoredOwnershipLogDates(
    storedRow({ OWNERSHIP_EFFECTIVE_DATE: "2026-11-19", END_DATE_PREVIOUS_OWNER: "2026-11-18", EFFECTIVE_DATE_SOURCE: "EXTENSION_START", EFFECTIVE_DATE_PLACEMENT_ID: "1466705" }),
    indexOf(cancelled)
  );
  assert.equal(change.EFFECTIVE_DATE_SOURCE, OWNERSHIP_LOG_SOURCE.TENTATIVE_PLUS_1);
  assert.equal(change.OWNERSHIP_EFFECTIVE_DATE, "2026-10-18");
  assert.equal(change.EFFECTIVE_DATE_PLACEMENT_ID, "1466112");
});

test("date sync: the anchor's tentative end moves -> the provisional date follows", () => {
  const extended = kayann()
    .filter((v) => v.PLACEMENT_ID !== "1466705")
    .map((v) => (v.PLACEMENT_ID === "1466112" ? { ...v, TENTATIVE_END_DATE: "2026-10-31" } : v));
  const change = resolveStoredOwnershipLogDates(storedRow(), indexOf(extended));
  assert.equal(change.OWNERSHIP_EFFECTIVE_DATE, "2026-11-01");
  assert.equal(change.END_DATE_PREVIOUS_OWNER, "2026-10-31");
});

test("date sync never touches a data team row or a placement outside the index", () => {
  assert.equal(resolveStoredOwnershipLogDates(storedRow({ EDITED_BY: DATA_TEAM_EDITED_BY }), indexOf(kayann())), null);
  assert.equal(resolveStoredOwnershipLogDates(storedRow({ PLACEMENT_ID: null }), indexOf(kayann())), null);
  assert.equal(resolveStoredOwnershipLogDates(storedRow({ PLACEMENT_ID: "999" }), indexOf(kayann())), null);
});

// ---------------------------------------------------------------------------------------------
// Data team cutoff: their reload (2026-10-02 12:50 UTC) is the history; the sync logs only what it
// first sees after that.
// ---------------------------------------------------------------------------------------------

const CUTOFF = Date.parse("2026-10-02T12:50:26Z");

test("data team cutoff: a change first seen before it is the data team's, not logged", () => {
  // H13017_H13231: the 2026-08-19 table reload stamped the extension with that day's CSM (Damian),
  // so "Briana -> Damian" was read on the data team's date, skipping Jodi in between.
  const BRIANA = { ONSITE_AM: "Briana Silva", ONSITE_AM_EMAIL: "briana@client.com" };
  const DAMIAN = { ONSITE_AM: "Damian Florio", ONSITE_AM_EMAIL: "damian@client.com" };
  const versions = [P1("2026-08-19T11:12:58Z", BRIANA), P2("2026-08-19T10:59:38Z", DAMIAN)];
  assert.equal(build(versions).length, 1, "without the cutoff it would be logged");
  assert.deepEqual(build(versions, [ONSITE_AM], { seenAfterMsForContract: () => CUTOFF }), []);
});

test("data team cutoff: a change first seen after it is logged", () => {
  // H15370 / CHC22424: the extension was booked with Sonam on 10-02 18:01 and moved to Sid on 10-08.
  const sonam = { ASSIGNMENT_RECRUITER: "Sonam Chaudhary (R4A)", ASSIGNMENT_RECRUITER_EMAIL: "sonam.c@cynethealth.com", RECRUITER_EMP_NO: "CY3474" };
  const sid = { ASSIGNMENT_RECRUITER: "Sid Kumar (R4A)", ASSIGNMENT_RECRUITER_EMAIL: "sid.k@cynethealth.com", RECRUITER_EMP_NO: "CY4758" };
  const versions = [
    version("1460710", "2026-08-19T10:07:30Z", { DEAL_TYPE: "DEAL", START_DATE: "2026-07-13", TENTATIVE_END_DATE: "2026-10-10", ...sonam }),
    version("1470924", "2026-10-02T18:01:09Z", { START_DATE: "2026-10-11", TENTATIVE_END_DATE: "2027-01-07", PLACEMENT_STATUS: "OFFERED", ...sonam }),
    version("1470924", "2026-10-08T15:49:26Z", { START_DATE: "2026-10-11", TENTATIVE_END_DATE: "2027-01-07", PLACEMENT_STATUS: "Offer Sent", ...sid }),
  ];
  const rows = build(versions, [RECRUITER], { seenAfterMsForContract: () => CUTOFF });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].PREVIOUS_OWNER_NAME, "Sonam Chaudhary (R4A)");
  assert.equal(rows[0].NEW_OWNER_NAME, "Sid Kumar (R4A)");
  assert.equal(rows[0].OWNERSHIP_EFFECTIVE_DATE, "2026-10-11");
});

test("data team cutoff: a pre-cutoff change re-seen after it (reached another placement) stays dropped", () => {
  // Kayann: the 09-15 change also reached the booked extension; pretend that second sighting came
  // after the cutoff. Only the FIRST sighting decides.
  const versions = [P1("2026-08-19T09:54:55Z"), P2("2026-08-19T09:51:50Z"), P2("2026-09-15T15:59:07Z", JESSICA), P3("2026-08-19T20:03:05Z"), P3("2026-10-05T10:00:00Z", JESSICA)];
  assert.deepEqual(build(versions, [ONSITE_AM], { seenAfterMsForContract: () => CUTOFF }), []);
});

test("data team cutoff: a version with no LAST_UPDATED is treated as before it", () => {
  const versions = [P1("2026-08-19T09:54:55Z"), version("1466112", null, { START_DATE: "2026-09-13", ...JESSICA })];
  assert.deepEqual(build(versions, [ONSITE_AM], { seenAfterMsForContract: () => CUTOFF }), []);
});
