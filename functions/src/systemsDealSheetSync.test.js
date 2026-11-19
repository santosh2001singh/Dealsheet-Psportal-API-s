const test = require("node:test");
const assert = require("node:assert/strict");
const { runSystemsDealSheetSync, comparable } = require("./systemsDealSheetSync");

const base = {
  PlacementCode: "PLC-1", Email: "a@x.com", ApplicantName: "A", PlacementType: "Recurring Revenue",
  PlacementStatus: "Active", ProfileStatus: "Placed", ActualStartDate: "01/05/26", ActualEndDate: "",
  ClientBillRate: "$50", PayRateSalary: "$30", PerDiemHour: "$0.00", TaxTerms: "W-2", VMSMSPFee: "2%",
  RecruiterSalesExecutive: "Rec One", RecruiterSalesExecutiveEmailId: "rec@cynetsystems.com",
  SubmittedByRecruiterEmployeeID: "CY9", TeamLeader: "Ceipal TL", SKUNumber: "S1", Client: "Acme",
  State: "Texas", ModifiedOn: "11/01/26 10:00:00",
};

/**
 * In-memory stand-ins: a paged CEIPAL report, a BigQuery table that sees its own writes, a Firestore
 * checkpoint, and a clock that can be advanced to exhaust the time budget.
 */
function deps({ records, latest = [], nextSeq = 1000, pageSize = 100, table, checkpoints, failCheckpointOnce = false }) {
  const written = [];
  const minted = [];
  const stored = table ?? [...latest];
  const cps = checkpoints ?? new Map();
  const fetchedPages = [];
  let seq = nextSeq;
  let failNext = failCheckpointOnce;
  const clock = { ms: 0 };
  return {
    written,
    minted,
    stored,
    cps,
    fetchedPages,
    clock,
    d: {
      nowMs: () => clock.ms,
      allocateContractIds: async (n, opts) => {
        assert.equal(opts.prefix, "CSC");
        const ids = Array.from({ length: n }, () => `CSC${seq++}`);
        minted.push(...ids);
        return ids;
      },
      fetchPage: async (page) => {
        fetchedPages.push(page);
        const recs = records.slice((page - 1) * pageSize, page * pageSize);
        return { records: recs, hasNext: page * pageSize < records.length, recordCount: records.length };
      },
      checkpoint: {
        get: async (k) => cps.get(k) ?? null,
        set: async (k, v) => {
          if (failNext) {
            failNext = false;
            throw new Error("killed before the checkpoint was saved");
          }
          cps.set(k, { ...(cps.get(k) || {}), ...v });
        },
        clear: async (k) => cps.delete(k),
      },
      // Latest-row lookups only return rows whose PLACEMENT_ID the query names, like the real IN (...).
      queryObjects: async (sql) => stored.filter((r) => sql.includes(`'${r.PLACEMENT_ID}'`)),
      insertAll: async (rows) => {
        written.push(...rows);
        stored.push(...rows);
        return { inserted: rows.length };
      },
      fetchEmployeeDirectoryByEmails: async () => new Map([["rec@cynetsystems.com", { employeeId: "CY100", externalId: "X1" }]]),
      fetchDealRecruiterHierarchyByPlacementId: async () => new Map([["PLC-1", { RM: "WS RM", RM_EMP_NO: "CY200" }]]),
    },
  };
}

const many = (n) => Array.from({ length: n }, (_, i) => ({ ...base, PlacementCode: `PLC-${i + 1}` }));

test("new placements (all entities) are inserted with Workspace hierarchy, CEIPAL fallback and stamps", async () => {
  const { d, written } = deps({ records: [base, { ...base, PlacementCode: "PLC-2", Client: "LabCorp" }] });
  const s = await runSystemsDealSheetSync({ mode: "insert", todayIso: "2026-11-18" }, d);
  assert.equal(s.inserts, 2, "Health placements are written too");
  assert.equal(s.health, 1);
  assert.equal(written.length, 2);
  assert.deepEqual(written.map((w) => w.ENTITY).sort(), ["HEALTH", "SYSTEMS"]);
  const r = written.find((w) => w.PLACEMENT_ID === "PLC-1");
  assert.equal(r.PLACEMENT_ID, "PLC-1");
  assert.equal(r.RM, "WS RM");
  assert.equal(r.RM_EMP_NO, "CY200");
  assert.equal(r.TEAM_LEAD, "Ceipal TL", "Workspace had no TL -> CEIPAL value");
  assert.equal(r.RECRUITER_EMP_NO, "CY100", "Workspace emp no preferred over CEIPAL's");
  assert.equal(r.UPDATED_BY, "CEIPAL_SYNC");
  assert.match(r.CONTRACT_ID, /^CSC\d+$/);
  assert.equal(new Set(written.map((w) => w.CONTRACT_ID)).size, 2, "one CONTRACT_ID per placement");
  assert.equal(s.contractIdsMinted, 2);
  assert.ok(r.ID);
  assert.equal(r.__CEIPAL_HIERARCHY, undefined);
});

test("unchanged placement appends nothing; a CEIPAL change appends and carries manual columns", async () => {
  const first = deps({ records: [base] });
  await runSystemsDealSheetSync({ mode: "insert", todayIso: "2026-11-18" }, first.d);
  // What BigQuery hands back: DATE/DATETIME as wrapper objects, plus a manual column.
  const stored = Object.fromEntries(
    Object.entries(first.written[0]).map(([k, v]) => [k, typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? { value: v.replace(" ", "T") } : v])
  );
  stored.COMMENTS = "manual note";
  stored.RM = "Manually fixed RM";

  const same = deps({ records: [{ ...base, ModifiedOn: "11/02/26 09:00:00" }], latest: [stored] });
  const s1 = await runSystemsDealSheetSync({ mode: "update", todayIso: "2026-11-18" }, same.d);
  assert.equal(s1.appends, 0, "ModifiedOn alone is not a change");

  const changed = deps({ records: [{ ...base, PayRateSalary: "$32" }], latest: [stored] });
  const s2 = await runSystemsDealSheetSync({ mode: "update", todayIso: "2026-11-18" }, changed.d);
  assert.equal(s2.appends, 1);
  const r = changed.written[0];
  assert.equal(r.PAY_RATE, 32);
  assert.equal(r.CONTRACT_ID, first.written[0].CONTRACT_ID, "append keeps the placement's CONTRACT_ID");
  assert.equal(changed.minted.length, 0, "nothing re-minted on append");
  assert.equal(r.COMMENTS, "manual note");
  assert.equal(r.RM, "Manually fixed RM", "hierarchy is never overwritten on append");
  assert.ok(s2.changedColumnCounts.PAY_RATE >= 1);
});

test("dry run writes nothing", async () => {
  const { d, written } = deps({ records: [base] });
  const s = await runSystemsDealSheetSync({ mode: "all", dryRun: true, todayIso: "2026-11-18" }, d);
  assert.equal(s.inserts, 1);
  assert.equal(written.length, 0);
  assert.equal(s.sample.length, 1);
  assert.equal(s.contractIdsNeeded, 1);
  assert.equal(s.contractIdsMinted, 0, "dry run never touches the CONTRACT_ID counter");
});

test("comparable normalises BigQuery wrappers, dates and numbers", () => {
  assert.equal(comparable({ value: "2026-01-05" }), comparable("2026-01-05"));
  assert.equal(comparable({ value: "2025-07-11T11:03:00" }), comparable("2025-07-11 11:03:00"));
  assert.equal(comparable(22.515000000000001), comparable("22.515"));
  assert.equal(comparable(null), comparable(""));
});

test("each page is written as it goes; a run out of time saves the checkpoint and the next run resumes", async () => {
  const table = [];
  const checkpoints = new Map();
  const records = many(5);

  const run1 = deps({ records, pageSize: 2, table, checkpoints });
  // Spend the whole budget on page 1.
  run1.d.fetchPage = ((orig) => async (p) => { const r = await orig(p); run1.clock.ms += 10_000; return r; })(run1.d.fetchPage);
  const s1 = await runSystemsDealSheetSync({ mode: "insert", todayIso: "2026-11-18", timeBudgetMs: 5_000 }, run1.d);
  assert.equal(s1.stoppedBy, "timeBudget");
  assert.equal(s1.completedCycle, false);
  assert.equal(s1.written, 2, "page 1 was written before stopping");
  assert.equal(checkpoints.get("systems-insert").nextPage, 2);

  const run2 = deps({ records, pageSize: 2, table, checkpoints, nextSeq: 2000 });
  const s2 = await runSystemsDealSheetSync({ mode: "insert", todayIso: "2026-11-18" }, run2.d);
  assert.equal(s2.startPage, 2);
  assert.deepEqual(run2.fetchedPages, [2, 3], "resumed where run 1 stopped");
  assert.equal(s2.completedCycle, true);
  assert.equal(checkpoints.has("systems-insert"), false, "checkpoint cleared at the end of the cycle");
  assert.equal(table.length, 5);
  assert.equal(new Set(table.map((r) => r.PLACEMENT_ID)).size, 5, "no placement written twice");
  assert.equal(new Set(table.map((r) => r.CONTRACT_ID)).size, 5);
});

test("killed after writing a page but before saving the checkpoint: the rerun inserts nothing twice", async () => {
  const table = [];
  const checkpoints = new Map();
  const records = many(4);
  const run1 = deps({ records, pageSize: 2, table, checkpoints, failCheckpointOnce: true });
  await assert.rejects(() => runSystemsDealSheetSync({ mode: "insert", todayIso: "2026-11-18" }, run1.d));
  assert.equal(table.length, 2, "page 1 landed");

  const run2 = deps({ records, pageSize: 2, table, checkpoints });
  const s2 = await runSystemsDealSheetSync({ mode: "insert", todayIso: "2026-11-18" }, run2.d);
  assert.deepEqual(run2.fetchedPages, [1, 2], "no checkpoint, so it started over");
  assert.equal(s2.inserts, 2, "only page 2 was new");
  assert.equal(table.length, 4);
  assert.equal(new Set(table.map((r) => r.PLACEMENT_ID)).size, 4);
});

test("a checkpoint past the end of a shrunken report restarts at page 1 in the same run", async () => {
  const checkpoints = new Map([["systems-all", { nextPage: 80 }]]);
  const run = deps({ records: many(3), pageSize: 2, checkpoints });
  const s = await runSystemsDealSheetSync({ mode: "all", todayIso: "2026-11-18" }, run.d);
  assert.deepEqual(run.fetchedPages, [80, 1, 2]);
  assert.equal(s.inserts, 3);
  assert.equal(s.completedCycle, true);
});

test("dry run neither reads nor writes the checkpoint, and max_pages limits it", async () => {
  const checkpoints = new Map([["systems-all", { nextPage: 2 }]]);
  const run = deps({ records: many(6), pageSize: 2, checkpoints });
  const s = await runSystemsDealSheetSync({ mode: "all", dryRun: true, maxPages: 1, todayIso: "2026-11-18" }, run.d);
  assert.deepEqual(run.fetchedPages, [1]);
  assert.equal(s.stoppedBy, "maxPages");
  assert.equal(checkpoints.get("systems-all").nextPage, 2, "untouched");
  assert.equal(run.written.length, 0);
});
