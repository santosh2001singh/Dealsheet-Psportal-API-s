/**
 * Cynet Systems deal-sheet sync: CEIPAL "Runrate Tool" report -> rr_project_data.cynet_systems_deal_sheet.
 *
 * Same model as the Health deal sheet, keyed on PLACEMENT_ID = CEIPAL Placement Code ("PLC-13831", a STRING, not Nexus's numeric id):
 *   insert  - a PLACEMENT_ID not yet in the table gets its first row, with the recruiter hierarchy
 *             resolved from Google Workspace (MISC.directory_employee_hierarchy) by recruiter email.
 *   update  - a PLACEMENT_ID whose CEIPAL-owned columns differ from its latest row gets a NEW row
 *             appended (history is never overwritten). Everything CEIPAL does not own — hierarchy,
 *             onboarding/BGV, comments and other manual columns — is carried forward from the latest
 *             row, so a manual BigQuery edit survives the next sync.
 *
 * CONTRACT_ID: one per PLACEMENT_ID (prefix CSC, Firestore sequence workspaces/run-rate-tool/
 * contractIdSequences/cynet_systems_deal_sheet, same mechanism as Health's CHC). Minted once on the
 * first insert and carried on every appended row; never re-minted.
 *
 * Every CEIPAL placement in the report is written, with ENTITY = SYSTEMS / HEALTH / CANADA
 * (see classifyCeipalRecord); only test records (PLC-16180) and rows without a code are skipped.
 */

const { randomUUID } = require("crypto");
const config = require("./config");
const { logLine, logError } = require("./logger");
const { fetchReportPage } = require("./ceipalClient");
const { classifyCeipalRecord, mapCeipalRecordToRow } = require("./systemsCeipalMapping");
const { DEAL_RECRUITER_HIERARCHY_TARGETS } = require("./recruiterHierarchyDesignations");
const { buildSequenceOptionsForTable } = require("./contractIdFormat");

const HIERARCHY_FIELDS = DEAL_RECRUITER_HIERARCHY_TARGETS.flatMap((t) => [t.column, t.empNoColumn]);

/** Columns that never trigger an append: they change without the placement changing. */
const COMPARE_IGNORE = new Set(["CEIPAL_MODIFIED_ON"]);

/** CEIPAL hierarchy columns used when the Workspace chain has nothing for that role. */
const CEIPAL_HIERARCHY_FALLBACK_COLUMNS = ["ACCOUNT_MANAGER", "ASSOCIATE_AM", "RM", "TEAM_LEAD", "ATL"];

function tableRef(tableId = config.systems.dealSheetTableId) {
  return `\`${config.projectId}.${config.datasetId}.${tableId}\``;
}

/** BigQuery client values (BigQueryDate, BigQueryTimestamp, ...) -> plain JSON-safe values. */
function plainValue(v) {
  if (v == null) return null;
  if (typeof v === "object" && !Array.isArray(v) && "value" in v) return v.value;
  return v;
}

/** Comparable form of a value: trims strings, rounds numbers, canonicalises date/time strings. */
function comparable(v) {
  const p = plainValue(v);
  if (p == null) return "";
  if (typeof p === "number") return String(Math.round(p * 10000) / 10000);
  const s = String(p).trim();
  if (s === "") return "";
  const dt = s.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}:\d{2}))?/);
  if (dt) return dt[2] ? `${dt[1]} ${dt[2]}` : dt[1];
  if (/^-?\d+(\.\d+)?$/.test(s)) return String(Math.round(Number(s) * 10000) / 10000);
  return s;
}

/** CEIPAL-owned columns whose values differ between the mapped row and the latest stored row. */
function diffCeipalColumns(mapped, latest) {
  const changed = [];
  for (const [k, v] of Object.entries(mapped)) {
    if (k.startsWith("__") || COMPARE_IGNORE.has(k)) continue;
    if (comparable(v) !== comparable(latest?.[k])) changed.push(k);
  }
  return changed;
}

function nowDateTime() {
  return new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

function stampRow(row) {
  return {
    ...row,
    ID: randomUUID(),
    LAST_UPDATED: nowDateTime(),
    UPDATED_BY: "CEIPAL_SYNC",
    DATA_SOURCE: "CEIPAL",
  };
}

/**
 * Fill RECRUITER_EMP_NO and the recruiter hierarchy on rows, from Google Workspace by recruiter
 * email (the recruiter's CURRENT chain, as Canada/Locums do). Only empty columns are filled, so a
 * carried-forward or manually corrected value is never replaced. Where Workspace has no one for a
 * role, CEIPAL's own value for that role is used.
 */
async function applyRecruiterHierarchy(rows, deps) {
  const stats = { workspaceMatched: 0, ceipalFallbackCells: 0, empNoFromWorkspace: 0 };
  if (rows.length === 0) return stats;

  const emails = [...new Set(rows.map((r) => r.RECRUITER_EMAIL_ID).filter(Boolean))];
  const directory = emails.length > 0 ? await deps.fetchEmployeeDirectoryByEmails(emails) : new Map();

  const pseudo = rows.map((r) => {
    const emp = directory.get(r.RECRUITER_EMAIL_ID)?.employeeId ?? null;
    return {
      PLACEMENT_ID: r.PLACEMENT_ID,
      ASSIGNMENT_RECRUITER_EMAIL: r.RECRUITER_EMAIL_ID,
      RECRUITER_EMP_NO: emp ?? r.CEIPAL_RECRUITER_EMP_NO ?? null,
      NEW_HIRE_DATE: null,
    };
  });
  const chains = await deps.fetchDealRecruiterHierarchyByPlacementId(pseudo, { currentChain: true });

  for (const row of rows) {
    const empNo = directory.get(row.RECRUITER_EMAIL_ID)?.employeeId ?? null;
    if (row.RECRUITER_EMP_NO == null || row.RECRUITER_EMP_NO === "") {
      if (empNo) {
        row.RECRUITER_EMP_NO = empNo;
        stats.empNoFromWorkspace++;
      } else {
        row.RECRUITER_EMP_NO = row.CEIPAL_RECRUITER_EMP_NO ?? null;
      }
    }
    const chain = chains.get(row.PLACEMENT_ID);
    if (chain) stats.workspaceMatched++;
    for (const f of HIERARCHY_FIELDS) {
      if (row[f] != null && row[f] !== "") continue;
      if (chain && chain[f] != null) row[f] = chain[f];
    }
    const ceipal = row.__CEIPAL_HIERARCHY || {};
    for (const f of CEIPAL_HIERARCHY_FALLBACK_COLUMNS) {
      if ((row[f] == null || row[f] === "") && ceipal[f]) {
        row[f] = ceipal[f];
        stats.ceipalFallbackCells++;
      }
    }
  }
  return stats;
}

/**
 * Mint CONTRACT_IDs for the rows that do not carry one yet. The counter is floored at the table's
 * own highest CSC number, so a stale or reset Firestore doc can never re-issue a live id.
 */
async function assignContractIds(rows, deps) {
  const need = rows.filter((r) => r.CONTRACT_ID == null || String(r.CONTRACT_ID).trim() === "");
  if (need.length === 0) return 0;
  const tableId = config.systems.dealSheetTableId;
  const seq = buildSequenceOptionsForTable(tableId);
  if (!seq) throw new Error(`no contractIdByTable entry for ${tableId}`);
  const prefix = seq.prefix;
  const ids = await deps.allocateContractIds(need.length, {
    ...seq,
    minNextValueFn: async () => {
      const rowsMax = await deps.queryObjects(`
        SELECT MAX(SAFE_CAST(REGEXP_EXTRACT(CONTRACT_ID, r'^${prefix}(\\d+)$') AS INT64)) AS m
        FROM ${tableRef(tableId)}`);
      const m = Number(rowsMax?.[0]?.m);
      return Number.isFinite(m) && m > 0 ? m + 1 : null;
    },
  });
  if (ids.length !== need.length) {
    throw new Error(`CONTRACT_ID allocation returned ${ids.length} ids for ${need.length} rows`);
  }
  need.forEach((r, i) => {
    r.CONTRACT_ID = ids[i];
  });
  return need.length;
}

function checkpointStore() {
  const { getCheckpointRef } = require("./firestoreWorkspace");
  return {
    async get(key) {
      const snap = await getCheckpointRef(key).get();
      return snap.exists ? snap.data() : null;
    },
    async set(key, data) {
      await getCheckpointRef(key).set(data, { merge: true });
    },
    async clear(key) {
      await getCheckpointRef(key).delete();
    },
  };
}

function defaultDeps() {
  const bq = require("./bigQueryClient");
  const admin = require("firebase-admin");
  // index.js initializes the app in Cloud Functions; a local run (node -e ...) has to do it here.
  if (admin.apps.length === 0) admin.initializeApp();
  const { allocateContractIds } = require("./contractIdSequence");
  return {
    allocateContractIds,
    fetchPage: (page) => fetchReportPage(page),
    checkpoint: checkpointStore(),
    queryObjects: bq.queryObjects,
    insertAll: bq.insertAll,
    fetchEmployeeDirectoryByEmails: bq.fetchEmployeeDirectoryByEmails,
    fetchDealRecruiterHierarchyByPlacementId: bq.fetchDealRecruiterHierarchyByPlacementId,
  };
}

/** Latest stored row for each of the given PLACEMENT_IDs (one page's worth). */
async function fetchLatestRowsForCodes(codes, deps) {
  const out = new Map();
  if (codes.length === 0) return out;
  const inList = codes.map((c) => `'${String(c).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`).join(", ");
  const rows = await deps.queryObjects(`
    SELECT * EXCEPT(_rn) FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY PLACEMENT_ID ORDER BY LAST_UPDATED DESC) AS _rn
      FROM ${tableRef()}
      WHERE PLACEMENT_ID IN (${inList})
    ) WHERE _rn = 1`);
  for (const r of rows) out.set(String(r.PLACEMENT_ID).trim(), r);
  return out;
}

function addInto(target, source) {
  for (const [k, v] of Object.entries(source)) {
    if (typeof v === "number") target[k] = (target[k] ?? 0) + v;
    else if (v && typeof v === "object") addInto((target[k] ??= {}), v);
  }
}

/**
 * Map, diff and (unless dry run) write one page of CEIPAL records. Each page is written as soon as
 * it is processed, so a run that stops part-way keeps everything it already did.
 */
async function processRecords(records, ctx, d) {
  const { mode, dryRun, todayIso, seenInRun } = ctx;
  const stats = {
    fetched: records.length, systems: 0, health: 0, canada: 0, excluded: 0, invalid: 0,
    repeatedInRun: 0, alreadyInTable: 0, inserts: 0, appends: 0, contractIdsNeeded: 0,
    contractIdsMinted: 0, written: 0, changedColumnCounts: {}, hierarchy: {},
  };

  const mappedByCode = new Map();
  for (const rec of records) {
    const cls = classifyCeipalRecord(rec);
    stats[cls] = (stats[cls] ?? 0) + 1;
    // Systems, Health and Canada all go to this table (ENTITY tells them apart); only test records
    // and rows without a placement code are skipped.
    if (cls !== "systems" && cls !== "health" && cls !== "canada") continue;
    const row = mapCeipalRecordToRow(rec, { todayIso });
    // CEIPAL's order can shift between page requests; a placement already handled in this run is
    // not processed twice.
    if (seenInRun.has(row.PLACEMENT_ID)) {
      stats.repeatedInRun++;
      continue;
    }
    const prev = mappedByCode.get(row.PLACEMENT_ID);
    if (!prev || String(row.CEIPAL_MODIFIED_ON ?? "") >= String(prev.CEIPAL_MODIFIED_ON ?? "")) {
      mappedByCode.set(row.PLACEMENT_ID, row);
    }
  }
  for (const code of mappedByCode.keys()) seenInRun.add(code);

  const latestByCode = await fetchLatestRowsForCodes([...mappedByCode.keys()], d);
  stats.alreadyInTable = latestByCode.size;

  const inserts = [];
  const appends = [];
  for (const [code, mapped] of mappedByCode) {
    const latest = latestByCode.get(code);
    if (!latest) {
      if (mode !== "update") inserts.push({ ...mapped });
      continue;
    }
    if (mode === "insert") continue;
    const changed = diffCeipalColumns(mapped, latest);
    if (changed.length === 0) continue;
    for (const c of changed) stats.changedColumnCounts[c] = (stats.changedColumnCounts[c] ?? 0) + 1;
    const carried = {};
    for (const [k, v] of Object.entries(latest)) carried[k] = plainValue(v);
    appends.push({ ...carried, ...mapped });
  }
  stats.inserts = inserts.length;
  stats.appends = appends.length;

  const rows = [...inserts, ...appends];
  if (rows.length === 0) return { stats, sample: [] };

  stats.hierarchy = await applyRecruiterHierarchy(rows, d);
  // Dry runs report how many ids a real run would mint but never touch the counter.
  stats.contractIdsNeeded = rows.filter((r) => r.CONTRACT_ID == null || String(r.CONTRACT_ID).trim() === "").length;

  const toWrite = rows.map((r) => {
    const out = stampRow(r);
    delete out.__CEIPAL_HIERARCHY;
    return out;
  });
  if (dryRun) return { stats, sample: toWrite.slice(0, 3) };

  stats.contractIdsMinted = await assignContractIds(toWrite, d);
  const res = await d.insertAll(toWrite, {
    datasetId: config.datasetId,
    tableId: config.systems.dealSheetTableId,
  });
  stats.written = res?.inserted ?? 0;
  if (stats.written < toWrite.length) {
    logError(`[systems sync] wrote ${stats.written}/${toWrite.length} rows; see BAD_ROWS_SKIPPED above`);
  }
  return { stats, sample: [] };
}

/**
 * Page through the CEIPAL report, writing each page as it goes, with a Firestore page checkpoint
 * (workspaces/run-rate-tool/dealSheetSyncCheckpoints/systems-<mode>) — the same resume model as
 * the Health / Locums insert triggers:
 *   - after every written page the checkpoint holds the next page to fetch;
 *   - a run stops by itself when its time budget is spent (before the function timeout kills it)
 *     and the next run continues from the checkpoint;
 *   - when the last page is done the checkpoint is cleared and the next run starts a fresh cycle
 *     at page 1.
 * Re-processing a page is harmless (inserts skip PLACEMENT_IDs already in the table; appends only
 * happen on a real change), so a kill between the write and the checkpoint save loses nothing.
 * Dry runs neither read nor write the checkpoint.
 *
 * @param {object} [opts] { mode: "insert" | "update" | "all", dryRun, todayIso, label,
 *                          timeBudgetMs, maxPages, resume (default true), checkpointKey }
 * @param {object} [deps] injectable I/O (tests)
 */
async function runSystemsDealSheetSync(opts = {}, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  const mode = opts.mode ?? "all";
  const dryRun = opts.dryRun === true;
  const label = opts.label ?? `systemsDealSheetSync[${mode}]`;
  const todayIso = opts.todayIso ?? new Date().toISOString().slice(0, 10);
  const timeBudgetMs = opts.timeBudgetMs ?? config.systems.timeBudgetMs;
  const maxPages = opts.maxPages ?? Infinity;
  const checkpointKey = opts.checkpointKey ?? `systems-${mode}`;
  const useCheckpoint = !dryRun && opts.resume !== false;
  const nowMs = d.nowMs ?? (() => Date.now());
  const startedMs = nowMs();

  const checkpoint = useCheckpoint ? await d.checkpoint.get(checkpointKey) : null;
  const startPage = Number(checkpoint?.nextPage) >= 1 ? Math.trunc(Number(checkpoint.nextPage)) : 1;
  const cycleStartedAt = checkpoint?.cycleStartedAt ?? new Date(startedMs).toISOString();

  const summary = {
    mode, dryRun, checkpointKey, startPage, pages: 0, lastPage: null, nextPage: null,
    completedCycle: false, stoppedBy: null, recordCount: null,
    fetched: 0, systems: 0, health: 0, canada: 0, excluded: 0, invalid: 0, repeatedInRun: 0,
    alreadyInTable: 0, inserts: 0, appends: 0, contractIdsNeeded: 0, contractIdsMinted: 0,
    written: 0, changedColumnCounts: {}, hierarchy: {},
  };
  const ctx = { mode, dryRun, todayIso, seenInRun: new Set() };
  const samples = [];
  let restartedFromOne = false;
  let prevFirstCode = null;

  logLine(`[${label}] start page=${startPage}${checkpoint ? " (resumed from checkpoint)" : ""} budgetMs=${timeBudgetMs}`);

  for (let page = startPage; ; page++) {
    if (summary.pages >= maxPages) {
      summary.stoppedBy = "maxPages";
      summary.nextPage = page;
      break;
    }
    if (summary.pages > 0 && nowMs() - startedMs > timeBudgetMs) {
      summary.stoppedBy = "timeBudget";
      summary.nextPage = page;
      break;
    }

    const pg = await d.fetchPage(page);
    summary.pages++;
    if (pg.recordCount != null) summary.recordCount = pg.recordCount;

    if (pg.records.length === 0) {
      // A checkpoint past the end (the report shrank, e.g. after switching to "Modified On, last 30
      // days") starts the cycle over in this same run instead of wasting it.
      if (page === startPage && startPage > 1 && !restartedFromOne) {
        logLine(`[${label}] checkpoint page ${page} is past the end of the report; restarting at page 1`);
        restartedFromOne = true;
        page = 0;
        continue;
      }
      summary.completedCycle = true;
      break;
    }

    const firstCode = pg.records[0]?.PlacementCode ?? JSON.stringify(pg.records[0]);
    if (firstCode === prevFirstCode) {
      logError(`[${label}] page ${page} repeated the previous page; ending the cycle`);
      summary.completedCycle = true;
      break;
    }
    prevFirstCode = firstCode;

    const { stats, sample } = await processRecords(pg.records, ctx, d);
    addInto(summary, stats);
    if (samples.length < 3) samples.push(...sample.slice(0, 3 - samples.length));
    summary.lastPage = page;

    const last = pg.hasNext === false || (pg.hasNext == null && pg.records.length < config.ceipal.reportPageLimit);
    if (useCheckpoint && !last) {
      await d.checkpoint.set(checkpointKey, {
        nextPage: page + 1,
        recordCount: summary.recordCount,
        cycleStartedAt,
        updatedAt: new Date(nowMs()).toISOString(),
      });
    }
    logLine(`[${label}] page ${page}${summary.recordCount != null ? `/${Math.ceil(summary.recordCount / config.ceipal.reportPageLimit)}` : ""}: inserts=${stats.inserts} appends=${stats.appends} written=${stats.written}`);
    if (last) {
      summary.completedCycle = true;
      break;
    }
  }

  if (useCheckpoint && summary.completedCycle) await d.checkpoint.clear(checkpointKey);

  if (dryRun) {
    summary.sample = samples;
    logLine(`[${label}] DRY RUN ${JSON.stringify({ ...summary, sample: undefined })}`);
    return summary;
  }
  logLine(`[${label}] done ${JSON.stringify(summary)}`);
  return summary;
}

module.exports = {
  runSystemsDealSheetSync,
  assignContractIds,
  diffCeipalColumns,
  comparable,
  applyRecruiterHierarchy,
  HIERARCHY_FIELDS,
};
