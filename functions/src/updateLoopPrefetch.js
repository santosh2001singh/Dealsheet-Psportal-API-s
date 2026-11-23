/**
 * Read-ahead cache for the scheduled update loop (syncExistingActiveDealSheetUpdatesFromBigQuery).
 *
 * WHY: every placement the loop refreshes used to run its own two BigQuery lookups — the stored
 * CONTRACT_ID (fetchContractIdsByDealSheetIds, a UNION over the three active deal-sheet tables) and
 * the baseline row (fetchLatestRowsByDealSheetIds with a single id). The tables are small (health is
 * ~19 MB) but BigQuery bills at least 10 MB per table per query, so ~5,600 refreshes a day cost
 * ~130k jobs and ~$35 over 2026-11-01..23 — most of run-rate's BigQuery bill. Fetching the next
 * chunk of placements in ONE query each turns hundreds of jobs per run into a handful.
 *
 * SAFETY RULES (the cache may only ever make a refresh cheaper, never different):
 *  - Entries live at most `ttlMs` (default 2 min) and are single-use: a value is handed out once and
 *    then dropped, so nothing cached outlives the refresh it was fetched for.
 *  - A cached baseline of "no row" is never served — the caller queries live, exactly as before.
 *  - Anything the wrappers do not recognise (other dataset/table, extra options) goes straight to
 *    the live query.
 *  - Every value served from cache is recorded on the per-refresh scope. Before the refresh WRITES
 *    anything (contract-id repair or an append) it calls scope.verify(), which re-runs the live
 *    queries for exactly those values; if any differs, the refresh redoes itself fully live. So a
 *    write is only ever based on data confirmed fresh at write time — the cache only shortcuts the
 *    read-only NO_CHANGE path.
 *  - UPDATE_PREFETCH_TTL_MS=0 switches the whole thing off (the loop then behaves exactly as before).
 */

const DEFAULT_TTL_MS = 120000;
const DEFAULT_CHUNK = 60;

function resolveUpdatePrefetchTtlMs() {
  const raw = process.env.UPDATE_PREFETCH_TTL_MS;
  if (raw == null || String(raw).trim() === "") return DEFAULT_TTL_MS;
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TTL_MS;
  // Never hold data longer than 10 minutes, whatever the override says.
  return Math.min(n, 10 * 60 * 1000);
}

function resolveUpdatePrefetchChunk() {
  const raw = process.env.UPDATE_PREFETCH_CHUNK;
  const n = parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CHUNK;
  return Math.min(n, 500);
}

function trimId(v) {
  return v == null ? "" : String(v).trim();
}

function stableJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(Math.random());
  }
}

/** Contract entries in a fixed order — the lookup query has no ORDER BY. */
function sortedEntries(entries) {
  return [...entries].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0));
}

/**
 * @param {object} cfg
 * @param {string} cfg.datasetId - dataset the loop reads baselines from
 * @param {string} cfg.contractDatasetId - dataset fetchContractIdsByDealSheetIds resolves to when the
 *   caller passes no datasetId (config.datasetId)
 * @param {Function} cfg.fetchLatestRowsFn - real fetchLatestRowsByDealSheetIds
 * @param {Function} cfg.fetchContractIdsFn - real fetchContractIdsByDealSheetIds
 * @param {(tableId: string) => boolean} cfg.isPlacementKeyedTable
 * @param {number} [cfg.ttlMs]
 * @param {() => number} [cfg.now]
 * @param {(msg: string) => void} [cfg.log]
 * @returns {object|null} null when disabled (ttlMs === 0)
 */
function createUpdateLoopPrefetcher(cfg) {
  const ttlMs = cfg.ttlMs ?? resolveUpdatePrefetchTtlMs();
  if (!(ttlMs > 0)) return null;
  const now = cfg.now ?? (() => Date.now());
  const log = cfg.log ?? (() => {});
  const datasetId = trimId(cfg.datasetId);
  const contractDatasetId = trimId(cfg.contractDatasetId);
  const realLatest = cfg.fetchLatestRowsFn;
  const realContract = cfg.fetchContractIdsFn;

  /** `${tableId}|${dsid}` -> { row, at } (row is never null here) */
  const baselines = new Map();
  /** `${P|D}|${dsid}` -> { entries: Array<[key, contractId]>, at } */
  const contracts = new Map();

  const stats = {
    prefetchQueries: 0,
    prefetchFailures: 0,
    baselineHits: 0,
    baselineMisses: 0,
    contractHits: 0,
    contractMisses: 0,
    verifyRuns: 0,
    verifyStale: 0,
  };

  const fresh = (entry) => entry != null && now() - entry.at < ttlMs;
  const modeOf = (matchPlacement) => (matchPlacement ? "P" : "D");

  function baselineKeyForOptions(options) {
    if (!options || typeof options !== "object") return null;
    const keys = Object.keys(options);
    if (keys.some((k) => k !== "datasetId" && k !== "tableId")) return null;
    const ds = trimId(options.datasetId);
    const tableId = trimId(options.tableId);
    if (!tableId || ds !== datasetId) return null;
    return tableId;
  }

  function contractModeForOptions(options) {
    const opts = options || {};
    const keys = Object.keys(opts);
    if (keys.some((k) => k !== "datasetId" && k !== "matchPlacement")) return null;
    const ds = trimId(opts.datasetId) || contractDatasetId;
    if (ds !== contractDatasetId) return null;
    return modeOf(opts.matchPlacement === true);
  }

  async function prefetch(windowTargets) {
    const baselineIdsByTable = new Map();
    const contractIdsByMode = new Map([
      ["D", []],
      ["P", []],
    ]);
    const seenContract = new Set();
    for (const t of windowTargets || []) {
      const dsid = trimId(t?.deal_sheet_id);
      const tableId = trimId(t?.table_id);
      if (!dsid || !tableId) continue;
      if (!fresh(baselines.get(`${tableId}|${dsid}`))) {
        if (!baselineIdsByTable.has(tableId)) baselineIdsByTable.set(tableId, new Set());
        baselineIdsByTable.get(tableId).add(dsid);
      }
      const mode = modeOf(cfg.isPlacementKeyedTable(tableId));
      const ck = `${mode}|${dsid}`;
      if (!fresh(contracts.get(ck)) && !seenContract.has(ck)) {
        seenContract.add(ck);
        contractIdsByMode.get(mode).push(dsid);
      }
    }

    for (const [tableId, idSet] of baselineIdsByTable) {
      const ids = [...idSet];
      try {
        stats.prefetchQueries++;
        const map = await realLatest(ids, { datasetId, tableId });
        const at = now();
        for (const id of ids) {
          const row = map instanceof Map ? map.get(id) : undefined;
          // "No row" is deliberately not cached: the refresh will ask live, as it always did.
          if (row != null) baselines.set(`${tableId}|${id}`, { row, at });
        }
      } catch (err) {
        stats.prefetchFailures++;
        log(`[update prefetch] baseline prefetch failed for ${ids.length} id(s) (falling back to live): ${String(err?.message || err).slice(0, 200)}`);
      }
    }

    for (const [mode, ids] of contractIdsByMode) {
      if (ids.length === 0) continue;
      try {
        stats.prefetchQueries++;
        const map = await realContract(ids, mode === "P" ? { matchPlacement: true } : {});
        const at = now();
        const byDsid = new Map(ids.map((id) => [id, []]));
        if (map instanceof Map) {
          for (const [key, cid] of map) {
            const dsid = mode === "P" ? String(key).split("|")[0] : String(key);
            if (byDsid.has(dsid)) byDsid.get(dsid).push([key, cid]);
          }
        }
        for (const [dsid, entries] of byDsid) {
          contracts.set(`${mode}|${dsid}`, { entries: sortedEntries(entries), at });
        }
      } catch (err) {
        stats.prefetchFailures++;
        log(`[update prefetch] contract-id prefetch failed for ${ids.length} id(s) (falling back to live): ${String(err?.message || err).slice(0, 200)}`);
      }
    }
  }

  /**
   * Make sure the targets about to run have fresh entries; when any of them is missing, read ahead
   * for the whole window (batch + following targets) in one query per table / key mode.
   * @param {object[]} batchTargets - the targets about to be processed now
   * @param {object[]} windowTargets - batchTargets followed by the next ones in the slice
   */
  async function ensure(batchTargets, windowTargets) {
    const missing = (batchTargets || []).some((t) => {
      const dsid = trimId(t?.deal_sheet_id);
      const tableId = trimId(t?.table_id);
      if (!dsid || !tableId) return false;
      const mode = modeOf(cfg.isPlacementKeyedTable(tableId));
      return !fresh(baselines.get(`${tableId}|${dsid}`)) || !fresh(contracts.get(`${mode}|${dsid}`));
    });
    if (missing) await prefetch(windowTargets);
  }

  /**
   * Per-refresh view: drop-in replacements for the two fetch functions that remember which values
   * came from cache, plus verify() to re-check exactly those values live before a write.
   */
  function scope() {
    const servedBaselines = []; // { ids:[dsid], options, rowJson }
    const servedContracts = []; // { dsid, options, mode, entriesJson }

    async function fetchLatestRowsByDealSheetIds(dealSheetIds, options = {}) {
      const tableId = baselineKeyForOptions(options);
      if (tableId == null) return realLatest(dealSheetIds, options);
      const out = new Map();
      const misses = [];
      for (const raw of dealSheetIds || []) {
        const id = trimId(raw);
        if (!id) continue;
        const key = `${tableId}|${id}`;
        const entry = baselines.get(key);
        if (fresh(entry)) {
          baselines.delete(key); // single-use
          out.set(id, entry.row);
          servedBaselines.push({ id, options: { ...options }, rowJson: stableJson(entry.row) });
          stats.baselineHits++;
        } else {
          if (entry) baselines.delete(key);
          misses.push(id);
        }
      }
      if (misses.length > 0) {
        stats.baselineMisses += misses.length;
        const live = await realLatest(misses, options);
        if (live instanceof Map) for (const [k, v] of live) out.set(k, v);
      }
      return out;
    }

    async function fetchContractIdsByDealSheetIds(dealSheetIds, options = {}) {
      const mode = contractModeForOptions(options);
      if (mode == null) return realContract(dealSheetIds, options);
      const out = new Map();
      const misses = [];
      for (const raw of dealSheetIds || []) {
        const id = trimId(raw);
        if (!id) continue;
        const key = `${mode}|${id}`;
        const entry = contracts.get(key);
        if (fresh(entry)) {
          contracts.delete(key); // single-use
          for (const [k, v] of entry.entries) out.set(k, v);
          servedContracts.push({ id, options: { ...(options || {}) }, mode, entriesJson: stableJson(entry.entries) });
          stats.contractHits++;
        } else {
          if (entry) contracts.delete(key);
          misses.push(id);
        }
      }
      if (misses.length > 0) {
        stats.contractMisses += misses.length;
        const live = await realContract(misses, options);
        if (live instanceof Map) for (const [k, v] of live) out.set(k, v);
      }
      return out;
    }

    /**
     * True when every value this refresh got from cache still matches a live read (or nothing came
     * from cache). Cached after the first call. Any error counts as "not fresh" — the caller then
     * redoes the refresh live, which is always safe.
     */
    let verified = null;
    async function verify() {
      if (verified != null) return verified;
      if (servedBaselines.length === 0 && servedContracts.length === 0) {
        verified = true;
        return verified;
      }
      stats.verifyRuns++;
      try {
        for (const s of servedBaselines) {
          const live = await realLatest([s.id], s.options);
          const row = live instanceof Map ? live.get(s.id) : undefined;
          if (row == null || stableJson(row) !== s.rowJson) {
            verified = false;
            break;
          }
        }
        if (verified !== false) {
          for (const s of servedContracts) {
            const live = await realContract([s.id], s.options);
            const entries = [];
            if (live instanceof Map) {
              for (const [k, v] of live) {
                const dsid = s.mode === "P" ? String(k).split("|")[0] : String(k);
                if (dsid === s.id) entries.push([k, v]);
              }
            }
            if (stableJson(sortedEntries(entries)) !== s.entriesJson) {
              verified = false;
              break;
            }
          }
        }
        if (verified !== false) verified = true;
      } catch (err) {
        log(`[update prefetch] verify failed (treating as stale, refresh redone live): ${String(err?.message || err).slice(0, 200)}`);
        verified = false;
      }
      if (verified === false) stats.verifyStale++;
      return verified;
    }

    return {
      fetchLatestRowsByDealSheetIds,
      fetchContractIdsByDealSheetIds,
      verify,
      get usedCache() {
        return servedBaselines.length > 0 || servedContracts.length > 0;
      },
    };
  }

  return { ensure, prefetch, scope, stats, ttlMs };
}

module.exports = {
  createUpdateLoopPrefetcher,
  resolveUpdatePrefetchTtlMs,
  resolveUpdatePrefetchChunk,
  DEFAULT_TTL_MS,
  DEFAULT_CHUNK,
};
