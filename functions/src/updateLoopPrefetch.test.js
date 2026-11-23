const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createUpdateLoopPrefetcher,
  resolveUpdatePrefetchTtlMs,
  resolveUpdatePrefetchChunk,
} = require("./updateLoopPrefetch");

/**
 * The scheduled update loop ran two BigQuery jobs per placement (stored CONTRACT_ID + baseline row),
 * ~130k jobs / ~$35 in 2026-11-01..23 because BigQuery bills >= 10 MB per table per query. The
 * read-ahead cache batches those lookups. These tests pin that it only ever makes a refresh cheaper:
 * same answers as the live query, single-use, short-lived, and verifiable before any write.
 */

const DS = "rr_project_data";
const HEALTH = "cynet_health_deal_sheet";
const CANADA = "cynet_health_canada_deal_sheet";

function makeFakes(db) {
  const calls = { latest: [], contract: [] };
  const fetchLatestRowsFn = async (ids, options) => {
    calls.latest.push({ ids: [...ids], options: { ...options } });
    const out = new Map();
    for (const id of ids) {
      const row = db.rows[`${options.tableId}|${id}`];
      if (row) out.set(String(id), { ...row });
    }
    return out;
  };
  const fetchContractIdsFn = async (ids, options = {}) => {
    calls.contract.push({ ids: [...ids], options: { ...options } });
    const out = new Map();
    for (const id of ids) {
      if (options.matchPlacement) {
        for (const [pid, cid] of Object.entries(db.keyed[id] || {})) out.set(`${id}|${pid}`, cid);
      } else if (db.plain[id]) {
        out.set(String(id), db.plain[id]);
      }
    }
    return out;
  };
  return { calls, fetchLatestRowsFn, fetchContractIdsFn };
}

function makeDb() {
  return {
    rows: {
      [`${HEALTH}|1`]: { ID: "a", DEAL_SHEET_ID: 1, LAST_UPDATED: "t1", CONTRACT_ID: "CHC1" },
      [`${HEALTH}|2`]: { ID: "b", DEAL_SHEET_ID: 2, LAST_UPDATED: "t1", CONTRACT_ID: "CHC2" },
      [`${CANADA}|9`]: { ID: "z", DEAL_SHEET_ID: 9, LAST_UPDATED: "t1", CONTRACT_ID: "CA9" },
    },
    keyed: { 1: { 100: "CHC1" }, 2: { 200: "CHC2", 201: "CHC3" } },
    plain: { 9: "CA9" },
  };
}

function make(db, opts = {}) {
  const fakes = makeFakes(db);
  let clock = 1000;
  const pf = createUpdateLoopPrefetcher({
    datasetId: DS,
    contractDatasetId: DS,
    fetchLatestRowsFn: fakes.fetchLatestRowsFn,
    fetchContractIdsFn: fakes.fetchContractIdsFn,
    isPlacementKeyedTable: (t) => t === HEALTH,
    ttlMs: opts.ttlMs ?? 120000,
    now: () => clock,
  });
  return { pf, fakes, tick: (ms) => (clock += ms) };
}

const targets = [
  { deal_sheet_id: "1", table_id: HEALTH },
  { deal_sheet_id: "2", table_id: HEALTH },
  { deal_sheet_id: "9", table_id: CANADA },
];

test("ttl 0 disables the cache entirely (kill switch)", () => {
  const { fetchLatestRowsFn, fetchContractIdsFn } = makeFakes(makeDb());
  const pf = createUpdateLoopPrefetcher({
    datasetId: DS,
    contractDatasetId: DS,
    fetchLatestRowsFn,
    fetchContractIdsFn,
    isPlacementKeyedTable: () => true,
    ttlMs: 0,
  });
  assert.equal(pf, null);
});

test("env: UPDATE_PREFETCH_TTL_MS=0 turns it off, default is 2 min, capped at 10 min", () => {
  delete process.env.UPDATE_PREFETCH_TTL_MS;
  assert.equal(resolveUpdatePrefetchTtlMs(), 120000);
  process.env.UPDATE_PREFETCH_TTL_MS = "0";
  assert.equal(resolveUpdatePrefetchTtlMs(), 0);
  process.env.UPDATE_PREFETCH_TTL_MS = "99999999";
  assert.equal(resolveUpdatePrefetchTtlMs(), 600000);
  process.env.UPDATE_PREFETCH_TTL_MS = "junk";
  assert.equal(resolveUpdatePrefetchTtlMs(), 120000);
  delete process.env.UPDATE_PREFETCH_TTL_MS;
  delete process.env.UPDATE_PREFETCH_CHUNK;
  assert.equal(resolveUpdatePrefetchChunk(), 60);
});

test("one read-ahead serves every placement in the window with the live query's answers", async () => {
  const db = makeDb();
  const { pf, fakes } = make(db);
  await pf.ensure(targets.slice(0, 1), targets);
  // One baseline query per table + one contract query per key mode — not two per placement.
  assert.equal(fakes.calls.latest.length, 2);
  assert.equal(fakes.calls.contract.length, 2);
  const before = { latest: fakes.calls.latest.length, contract: fakes.calls.contract.length };

  const live = makeFakes(db);
  for (const t of targets) {
    const scope = pf.scope();
    const opts = { datasetId: DS, tableId: t.table_id };
    const got = await scope.fetchLatestRowsByDealSheetIds([t.deal_sheet_id], opts);
    const want = await live.fetchLatestRowsFn([t.deal_sheet_id], opts);
    assert.deepEqual([...got], [...want]);

    const cOpts = t.table_id === HEALTH ? { matchPlacement: true } : undefined;
    const gotC = await scope.fetchContractIdsByDealSheetIds([t.deal_sheet_id], cOpts);
    const wantC = await live.fetchContractIdsFn([t.deal_sheet_id], cOpts);
    assert.deepEqual(new Map([...gotC].sort()), new Map([...wantC].sort()));
    assert.equal(scope.usedCache, true);
  }
  assert.equal(fakes.calls.latest.length, before.latest, "no extra baseline queries");
  assert.equal(fakes.calls.contract.length, before.contract, "no extra contract queries");
});

test("ensure does nothing when the current batch is already cached", async () => {
  const { pf, fakes } = make(makeDb());
  await pf.ensure(targets, targets);
  const n = fakes.calls.latest.length + fakes.calls.contract.length;
  await pf.ensure(targets.slice(0, 2), targets);
  assert.equal(fakes.calls.latest.length + fakes.calls.contract.length, n);
});

test("entries are single-use: a second read goes live", async () => {
  const { pf, fakes } = make(makeDb());
  await pf.ensure(targets, targets);
  const opts = { datasetId: DS, tableId: HEALTH };
  await pf.scope().fetchLatestRowsByDealSheetIds(["1"], opts);
  const n = fakes.calls.latest.length;
  await pf.scope().fetchLatestRowsByDealSheetIds(["1"], opts);
  assert.equal(fakes.calls.latest.length, n + 1);
  assert.deepEqual(fakes.calls.latest.at(-1).ids, ["1"]);
});

test("expired entries are not served", async () => {
  const { pf, fakes, tick } = make(makeDb(), { ttlMs: 1000 });
  await pf.ensure(targets, targets);
  tick(1000);
  const n = fakes.calls.latest.length;
  const scope = pf.scope();
  await scope.fetchLatestRowsByDealSheetIds(["2"], { datasetId: DS, tableId: HEALTH });
  assert.equal(fakes.calls.latest.length, n + 1);
  assert.equal(scope.usedCache, false);
});

test("a missing baseline is never served from cache (always asked live)", async () => {
  const db = makeDb();
  const { pf, fakes } = make(db);
  const t = [{ deal_sheet_id: "77", table_id: HEALTH }];
  await pf.ensure(t, t);
  const n = fakes.calls.latest.length;
  const got = await pf.scope().fetchLatestRowsByDealSheetIds(["77"], { datasetId: DS, tableId: HEALTH });
  assert.equal(got.size, 0);
  assert.equal(fakes.calls.latest.length, n + 1, "went live");
});

test("other datasets, tables or unexpected options bypass the cache", async () => {
  const { pf, fakes } = make(makeDb());
  await pf.ensure(targets, targets);
  const scope = pf.scope();
  let n = fakes.calls.latest.length;
  await scope.fetchLatestRowsByDealSheetIds(["1"], { datasetId: "other", tableId: HEALTH });
  await scope.fetchLatestRowsByDealSheetIds(["1"], { datasetId: DS, tableId: HEALTH, extra: 1 });
  await scope.fetchLatestRowsByDealSheetIds(["1"], { datasetId: DS });
  assert.equal(fakes.calls.latest.length, n + 3);
  n = fakes.calls.contract.length;
  await scope.fetchContractIdsByDealSheetIds(["1"], { datasetId: "other", matchPlacement: true });
  await scope.fetchContractIdsByDealSheetIds(["1"], { matchPlacement: true, somethingElse: true });
  assert.equal(fakes.calls.contract.length, n + 2);
  assert.equal(scope.usedCache, false);
});

test("a key-mode mismatch (plain vs placement-keyed) falls back to live", async () => {
  const { pf, fakes } = make(makeDb());
  await pf.ensure(targets, targets); // health prefetched placement-keyed
  const n = fakes.calls.contract.length;
  const got = await pf.scope().fetchContractIdsByDealSheetIds(["1"], {}); // asked plain
  assert.equal(fakes.calls.contract.length, n + 1);
  assert.equal(got.size, 0, "plain lookup for a keyed-only fake returns what live returns");
});

test("verify: true when nothing came from cache, without querying", async () => {
  const { pf, fakes } = make(makeDb());
  const scope = pf.scope();
  const n = fakes.calls.latest.length + fakes.calls.contract.length;
  assert.equal(await scope.verify(), true);
  assert.equal(fakes.calls.latest.length + fakes.calls.contract.length, n);
});

test("verify: true when cached values still match BigQuery", async () => {
  const { pf } = make(makeDb());
  await pf.ensure(targets, targets);
  const scope = pf.scope();
  await scope.fetchLatestRowsByDealSheetIds(["2"], { datasetId: DS, tableId: HEALTH });
  await scope.fetchContractIdsByDealSheetIds(["2"], { matchPlacement: true });
  assert.equal(await scope.verify(), true);
  assert.equal(pf.stats.verifyStale, 0);
});

test("verify: false when the baseline row changed after the read-ahead", async () => {
  const db = makeDb();
  const { pf } = make(db);
  await pf.ensure(targets, targets);
  const scope = pf.scope();
  await scope.fetchLatestRowsByDealSheetIds(["1"], { datasetId: DS, tableId: HEALTH });
  db.rows[`${HEALTH}|1`] = { ...db.rows[`${HEALTH}|1`], ID: "newer", LAST_UPDATED: "t2" };
  assert.equal(await scope.verify(), false);
  assert.equal(pf.stats.verifyStale, 1);
});

test("verify: false when the stored contract id changed after the read-ahead", async () => {
  const db = makeDb();
  const { pf } = make(db);
  await pf.ensure(targets, targets);
  const scope = pf.scope();
  await scope.fetchContractIdsByDealSheetIds(["2"], { matchPlacement: true });
  db.keyed[2] = { 200: "CHC9", 201: "CHC3" };
  assert.equal(await scope.verify(), false);
});

test("verify ignores row order of the contract lookup (query has no ORDER BY)", async () => {
  const db = makeDb();
  const { pf } = make(db);
  await pf.ensure(targets, targets);
  const scope = pf.scope();
  await scope.fetchContractIdsByDealSheetIds(["2"], { matchPlacement: true });
  db.keyed[2] = { 201: "CHC3", 200: "CHC2" }; // same values, other order
  assert.equal(await scope.verify(), true);
});

test("verify: a live-read error counts as stale (refresh is redone live)", async () => {
  const db = makeDb();
  const fakes = makeFakes(db);
  let fail = false;
  const pf = createUpdateLoopPrefetcher({
    datasetId: DS,
    contractDatasetId: DS,
    fetchLatestRowsFn: async (ids, o) => {
      if (fail) throw new Error("boom");
      return fakes.fetchLatestRowsFn(ids, o);
    },
    fetchContractIdsFn: fakes.fetchContractIdsFn,
    isPlacementKeyedTable: (t) => t === HEALTH,
    ttlMs: 60000,
  });
  await pf.ensure(targets, targets);
  const scope = pf.scope();
  await scope.fetchLatestRowsByDealSheetIds(["1"], { datasetId: DS, tableId: HEALTH });
  fail = true;
  assert.equal(await scope.verify(), false);
});

test("a failed read-ahead is non-fatal: lookups simply go live", async () => {
  const db = makeDb();
  const fakes = makeFakes(db);
  let fail = true;
  const pf = createUpdateLoopPrefetcher({
    datasetId: DS,
    contractDatasetId: DS,
    fetchLatestRowsFn: async (ids, o) => {
      if (fail) throw new Error("bq down");
      return fakes.fetchLatestRowsFn(ids, o);
    },
    fetchContractIdsFn: fakes.fetchContractIdsFn,
    isPlacementKeyedTable: (t) => t === HEALTH,
    ttlMs: 60000,
  });
  await pf.ensure(targets, targets); // must not throw
  assert.equal(pf.stats.prefetchFailures, 2, "one per table (health + canada)");
  fail = false;
  const got = await pf.scope().fetchLatestRowsByDealSheetIds(["1"], { datasetId: DS, tableId: HEALTH });
  assert.equal(got.get("1").ID, "a");
});
