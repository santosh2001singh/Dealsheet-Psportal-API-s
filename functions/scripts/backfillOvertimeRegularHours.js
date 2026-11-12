#!/usr/bin/env node
/**
 * Backfill for the Cynet Health billing-overtime rule (Nov 2026): a submittal that carries an
 * `overtime` id (/api/billing-overtimes/) uses the regular-hours NEW-rate formula, like CA / AK.
 *
 * BigQuery cannot do this alone: REGULAR_HOURS_1/2 were stored as 0 outside CA / AK and the
 * submittal's overtime id was never stored. So this script:
 *
 *   fetch   (default)  Every PLACEMENT_ID / DEAL_SHEET_ID in cynet_health_deal_sheet (the ended
 *                      table is not touched) -> GET /api/job-submittals/{placement}/ for
 *                      `overtime`; for the ones with an id, GET /api/deal-sheet-hours-details/ for
 *                      regular / scheduled hours, and the /api/billing-overtimes/{id}/ label.
 *                      Writes one row per deal sheet WITH an overtime id to the staging table
 *                      rr_project_data.tmp_overtime_regular_hours (WRITE_TRUNCATE).
 *                      --dry-run writes only the local NDJSON file and prints the counts.
 *   --placement <id>   Only these placements (repeat the flag or comma-separate). Prints every
 *                      version of the placement with the stored vs recomputed NEW-rate family, so a
 *                      single placement can be checked before anything is written.
 *   --apply            After loading the staging table, run sql/backfill_overtime_regular_hours.sql
 *                      (in-place UPDATE). With --placement only that placement's rows change, since
 *                      the SQL works off the staging table.
 *   --verify           After sql/backfill_overtime_regular_hours.sql: recompute every updated row
 *                      with computeNewRateFamily (the sync's own code) and list any column that
 *                      differs from what the SQL stored. Zero differences = the :30 update trigger
 *                      will see nothing to append.
 *
 * Writes nothing to the deal sheet tables; the in-place UPDATE is the SQL file.
 *
 * Usage (from functions/, with NEXUS_USERNAME / NEXUS_PASSWORD in functions/.env):
 *   node scripts/backfillOvertimeRegularHours.js --placement 1474462 --dry-run   # preview only
 *   node scripts/backfillOvertimeRegularHours.js --placement 1474462 --apply     # update it
 *   node scripts/backfillOvertimeRegularHours.js --placement 1474462 --verify
 *   node scripts/backfillOvertimeRegularHours.js --dry-run
 *   node scripts/backfillOvertimeRegularHours.js --apply
 *   node scripts/backfillOvertimeRegularHours.js --verify
 */

const fs = require("node:fs");
const path = require("node:path");

// functions/.env -> process.env before config is read (no dotenv dependency in this package).
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

const { BigQuery } = require("@google-cloud/bigquery");
const config = require("../src/config");
const {
  buildUrl,
  getNexusAccessToken,
  nexusGetJsonWithRetry,
  firstPagedItemOrNull,
  isNotFoundNexusError,
} = require("../src/nexusClient");
const { getBillingOvertimeLabel } = require("../src/billingOvertime");
const { normalizeOvertimeId, computeNewRateFamily } = require("../src/w2PayRateNew");

const PROJECT = "cynetdatabase";
const DATASET = "rr_project_data";
// Active table only: cynet_health_ended_deal_sheet is deliberately left alone.
const SOURCE_TABLES = ["cynet_health_deal_sheet"];
const STAGING_TABLE = "tmp_overtime_regular_hours";
const CONCURRENCY = 8;
const NEW_FAMILY_COLUMNS = [
  "W2_PAY_RATE_NEW",
  "FINAL_PAY_RATE_NEW",
  "FINAL_COST_NEW",
  "FINAL_BILL_RATE_NEW",
  "CALCULATED_MARGIN",
];

function makeBigQuery() {
  const { client_email: email, private_key: key } = config.serviceAccount;
  return email && key
    ? new BigQuery({ projectId: PROJECT, credentials: { client_email: email, private_key: key } })
    : new BigQuery({ projectId: PROJECT });
}

async function query(bq, sql) {
  const [rows] = await bq.query({ query: sql, location: "US" });
  return rows;
}

function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Runs fn over items, CONCURRENCY at a time; returns results in order. */
async function pool(items, fn, label) {
  const out = new Array(items.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
      done++;
      if (done % 250 === 0) console.log(`  ${label}: ${done}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}

function placementFilter(placements) {
  return placements.length ? ` AND PLACEMENT_ID IN (${placements.join(", ")})` : "";
}

/** Same guard as the SQL: a version takes the API regular hours only if its schedule hours match. */
function scheduleMatches(row, stage) {
  return (toNum(row.SCHEDULE_HOURS_1) ?? 0) === (stage.API_SCHEDULED_HRS_1 ?? 0)
    && (toNum(row.SCHEDULE_HOURS_2) ?? 0) === (stage.API_SCHEDULED_HRS_2 ?? 0);
}

function plainRow(row) {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v?.value ?? v]));
}

/** Every version of the given placements: stored vs recomputed, nothing written. */
async function previewPlacements(bq, placements, stageRows) {
  const stageByKey = new Map(stageRows.map((r) => [`${r.PLACEMENT_ID}|${r.DEAL_SHEET_ID}`, r]));
  for (const t of SOURCE_TABLES) {
    const rows = await query(bq, `SELECT * FROM \`${PROJECT}.${DATASET}.${t}\`
      WHERE TRUE${placementFilter(placements)} ORDER BY PLACEMENT_ID, LAST_UPDATED`);
    const out = rows.map((raw) => {
      const row = plainRow(raw);
      const stage = stageByKey.get(`${row.PLACEMENT_ID}|${row.DEAL_SHEET_ID}`);
      const applies = stage != null && scheduleMatches(row, stage);
      const next = applies
        ? computeNewRateFamily({
          ...row,
          OVERTIME_ID: stage.OVERTIME_ID,
          REGULAR_HOURS_1: stage.API_REGULAR_HRS_1 ?? 0,
          REGULAR_HOURS_2: stage.API_REGULAR_HRS_2 ?? 0,
        })
        : null;
      return {
        DEAL_SHEET_ID: row.DEAL_SHEET_ID,
        LAST_UPDATED: row.LAST_UPDATED ? String(row.LAST_UPDATED).slice(0, 19) : null,
        STATE: row.CLIENT_STATE,
        OVERTIME: stage ? `${stage.OVERTIME_ID} ${stage.OVERTIME}` : "-",
        SH: `${row.SCHEDULE_HOURS_1}/${row.SCHEDULE_HOURS_2}`,
        RH: applies ? `${row.REGULAR_HOURS_1}/${row.REGULAR_HOURS_2} -> ${stage.API_REGULAR_HRS_1}/${stage.API_REGULAR_HRS_2}` : "unchanged",
        MARGIN_API: toNum(row.MARGIN),
        CALC_MARGIN_OLD: toNum(row.CALCULATED_MARGIN),
        CALC_MARGIN_NEW: next ? next.CALCULATED_MARGIN : "unchanged",
        BILL_NEW: next ? `${row.FINAL_BILL_RATE_NEW} -> ${next.FINAL_BILL_RATE_NEW}` : "",
        COST_NEW: next ? `${row.FINAL_COST_NEW} -> ${next.FINAL_COST_NEW}` : "",
        W2_NEW: next ? `${row.W2_PAY_RATE_NEW} -> ${next.W2_PAY_RATE_NEW}` : "",
      };
    });
    console.log(`\n${t}: ${out.length} version(s)`);
    if (out.length) console.table(out);
  }
}

async function fetchStage({ dryRun, apply, placements }) {
  const bq = makeBigQuery();
  const pairs = await query(bq, SOURCE_TABLES.map((t) => `
    SELECT DISTINCT PLACEMENT_ID, DEAL_SHEET_ID
    FROM \`${PROJECT}.${DATASET}.${t}\`
    WHERE PLACEMENT_ID IS NOT NULL AND DEAL_SHEET_ID IS NOT NULL${placementFilter(placements)}`).join("\nUNION DISTINCT\n"));
  const placementIds = [...new Set(pairs.map((p) => String(p.PLACEMENT_ID)))];
  console.log(`pairs=${pairs.length} placements=${placementIds.length}`);

  const token = await getNexusAccessToken();
  const failed = [];
  const overtimeByPlacement = new Map();
  await pool(placementIds, async (pid) => {
    try {
      const sub = await nexusGetJsonWithRetry(`${config.nexus.baseUrl}/api/job-submittals/${pid}/`, token);
      overtimeByPlacement.set(pid, normalizeOvertimeId(sub?.overtime));
    } catch (err) {
      if (!isNotFoundNexusError(err)) failed.push(`submittal ${pid}`);
      overtimeByPlacement.set(pid, null);
    }
  }, "submittals");

  const withOvertime = pairs.filter((p) => overtimeByPlacement.get(String(p.PLACEMENT_ID)) != null);
  const dealSheetIds = [...new Set(withOvertime.map((p) => String(p.DEAL_SHEET_ID)))];
  const hoursByDs = new Map();
  await pool(dealSheetIds, async (ds) => {
    try {
      const url = buildUrl(`${config.nexus.baseUrl}/api/deal-sheet-hours-details/`, { deal_sheet_id: ds });
      hoursByDs.set(ds, firstPagedItemOrNull(await nexusGetJsonWithRetry(url, token)));
    } catch (err) {
      failed.push(`hours ds=${ds}`);
    }
  }, "hours");

  const stageRows = [];
  for (const p of withOvertime) {
    const ds = String(p.DEAL_SHEET_ID);
    if (!hoursByDs.has(ds)) continue; // fetch failed: leave the deal sheet as it is
    const hours = hoursByDs.get(ds);
    const overtimeId = overtimeByPlacement.get(String(p.PLACEMENT_ID));
    stageRows.push({
      PLACEMENT_ID: Number(p.PLACEMENT_ID),
      DEAL_SHEET_ID: Number(p.DEAL_SHEET_ID),
      OVERTIME_ID: overtimeId,
      OVERTIME: await getBillingOvertimeLabel(overtimeId, token),
      API_SCHEDULED_HRS_1: toNum(hours?.scheduled_hrs_1),
      API_SCHEDULED_HRS_2: toNum(hours?.scheduled_hrs_2),
      API_REGULAR_HRS_1: toNum(hours?.regular_hrs_1),
      API_REGULAR_HRS_2: toNum(hours?.regular_hrs_2),
    });
  }

  const byLabel = {};
  for (const r of stageRows) byLabel[`${r.OVERTIME_ID} ${r.OVERTIME}`] = (byLabel[`${r.OVERTIME_ID} ${r.OVERTIME}`] || 0) + 1;
  console.log(`placements with overtime=${new Set(withOvertime.map((p) => p.PLACEMENT_ID)).size}`);
  console.log(`staged deal sheets=${stageRows.length}`, byLabel);
  console.log(`no hours row=${stageRows.filter((r) => r.API_SCHEDULED_HRS_1 == null).length}`
    + ` regular hrs blank=${stageRows.filter((r) => r.API_REGULAR_HRS_1 == null && r.API_REGULAR_HRS_2 == null).length}`);
  if (failed.length) console.log(`FAILED fetches=${failed.length} (left untouched):`, failed.slice(0, 20));

  const file = path.join(require("node:os").tmpdir(), `${STAGING_TABLE}.ndjson`);
  fs.writeFileSync(file, stageRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`wrote ${file}`);
  if (placements.length) await previewPlacements(bq, placements, stageRows);
  if (dryRun) return;

  await bq.dataset(DATASET).table(STAGING_TABLE).load(file, {
    sourceFormat: "NEWLINE_DELIMITED_JSON",
    writeDisposition: "WRITE_TRUNCATE",
    schema: {
      fields: [
        { name: "PLACEMENT_ID", type: "INT64" },
        { name: "DEAL_SHEET_ID", type: "INT64" },
        { name: "OVERTIME_ID", type: "INT64" },
        { name: "OVERTIME", type: "STRING" },
        { name: "API_SCHEDULED_HRS_1", type: "FLOAT64" },
        { name: "API_SCHEDULED_HRS_2", type: "FLOAT64" },
        { name: "API_REGULAR_HRS_1", type: "FLOAT64" },
        { name: "API_REGULAR_HRS_2", type: "FLOAT64" },
      ],
    },
  });
  console.log(`loaded ${stageRows.length} rows into ${DATASET}.${STAGING_TABLE}`);
  if (!apply) return;

  const sqlFile = path.join(__dirname, "..", "..", "sql", "backfill_overtime_regular_hours.sql");
  await query(bq, fs.readFileSync(sqlFile, "utf8"));
  console.log(`applied ${path.basename(sqlFile)}; now run with --verify`);
}

async function verify(placements) {
  const bq = makeBigQuery();
  let checked = 0;
  const diffs = [];
  for (const t of SOURCE_TABLES) {
    const rows = await query(bq, `SELECT * FROM \`${PROJECT}.${DATASET}.${t}\` WHERE OVERTIME_ID IS NOT NULL${placementFilter(placements)}`);
    for (const row of rows) {
      const plain = plainRow(row);
      const expected = computeNewRateFamily(plain);
      checked++;
      for (const col of NEW_FAMILY_COLUMNS) {
        const stored = toNum(plain[col]);
        if (stored !== (expected[col] ?? null)) {
          diffs.push({ table: t, DEAL_SHEET_ID: plain.DEAL_SHEET_ID, col, stored, expected: expected[col] });
        }
      }
    }
  }
  console.log(`checked rows=${checked} differing values=${diffs.length}`);
  if (diffs.length) console.table(diffs.slice(0, 50));
  process.exitCode = diffs.length ? 1 : 0;
}

function parseArgs(argv) {
  const out = { dryRun: false, apply: false, verify: false, placements: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--apply") out.apply = true;
    else if (arg === "--verify") out.verify = true;
    else if (arg === "--placement") {
      for (const id of String(argv[++i] ?? "").split(",")) {
        if (!/^\d+$/.test(id.trim())) throw new Error(`--placement expects numeric ids, got "${id}"`);
        out.placements.push(Number(id.trim()));
      }
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (out.dryRun && out.apply) throw new Error("--dry-run and --apply together make no sense");
  return out;
}

const opts = parseArgs(process.argv.slice(2));
(opts.verify ? verify(opts.placements) : fetchStage(opts)).catch((err) => {
  console.error(err);
  process.exit(1);
});
