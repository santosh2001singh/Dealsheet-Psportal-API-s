/**
 * AITA candidate webhook (Health only).
 *
 * AITA wants one JSON POST per placement event when a placement STARTS, ENDS or ENDS<30 (spec:
 * "AITA Candidate Feed — Webhook API (for Run Rate)", Nov 11 2026). This module finds those events in
 * cynet_health_deal_sheet and pushes them.
 *
 * WHY A SEPARATE PASS OVER BIGQUERY, not a hook inside the sync: Health rows are written by at least
 * five paths (insert trigger, update trigger, refreshDealSheetByPlacementId, backfill, bulk backfill).
 * Hooking each one is fragile — miss one and its events are lost — and it would put a third-party HTTP
 * call inside the sync. Reading the table after the fact catches every path and leaves the sync
 * untouched.
 *
 * WHY STATE-BASED, not a time watermark: UPDATED_AT is null on every row and LAST_UPDATED is the Nexus
 * timestamp, not the time the row reached BigQuery, so a row can land after a watermark has passed it.
 * Instead an event is identified by EVENT_KEY = DEAL_SHEET_ID|PLACEMENT_ID|PLACEMENT_STATUS of the
 * latest version of each deal sheet; a key not yet in the outbox is a new event. Late rows, re-runs and
 * every write path are covered by construction.
 *
 * FRESH CANDIDATES ONLY: the first run against an empty outbox records every current key as `baseline`
 * and every CANDIDATE_ID already in the table in aita_webhook_known_candidates, and sends nothing.
 * From then on an event goes out only for a candidate NOT in that list — someone who had never been in
 * the Health table before go-live. All of a fresh candidate's events go (STARTED, later ENDED,
 * extensions), so AITA sees the whole placement; an existing candidate's new placement, extension or
 * end never does (user decision, Nov 12 2026). The known list is frozen at go-live on purpose: a
 * candidate first seen afterwards stays fresh for good.
 *
 * OUTBOX (aita_webhook_outbox): each event is written as `pending` with its exact JSON BEFORE it is
 * POSTed. AITA de-duplicates on a SHA-256 of the raw body, so a retry must resend the same bytes — the
 * stored PAYLOAD_JSON is what every retry sends, never a rebuilt payload.
 *   202            -> sent
 *   401            -> retry (and the run stops: every other call would 401 too)
 *   503/timeout/.. -> retry, up to maxAttempts, then failed
 *   bad envelope   -> skipped, never POSTed (202 would hide it: AITA stores it as `failed`)
 *
 * PLACEMENT_ID changes on every extension in our data (0 of 6,602 extension/deal pairs share one), so
 * CONTRACT_ID — stable across a contract and its extensions — rides along as an extra field.
 */

const crypto = require("node:crypto");
const axios = require("axios");
const config = require("./config");
const { queryObjects, runDml, escapeSqlString } = require("./bigQueryClient");
const { logLine, logError } = require("./logger");

const AITA_PLACEMENT_STATUSES = ["STARTED", "ENDED", "ENDED<30"];

const STATE = Object.freeze({
  BASELINE: "baseline",
  PENDING: "pending",
  SENT: "sent",
  RETRY: "retry",
  FAILED: "failed",
  SKIPPED: "skipped",
});

/**
 * Payload key order. JSON.stringify keeps insertion order, so a fixed order keeps the bytes stable.
 * Pay rates are the PR_* Nexus codes, bill rates the BR_* ones — base rates, not the FINAL_* calcs.
 */
const PAYLOAD_FIELDS = [
  "PLACEMENT_ID",
  "PLACEMENT_STATUS",
  "CANDIDATE_STATUS",
  "CONTRACT_ID",
  "DEAL_TYPE",
  "CANDIDATE_ID",
  "CANDIDATE_NAME",
  "CANDIDATE_EMAIL",
  "START_DATE",
  "END_DATE",
  "EXTENSION_START_DATE",
  "CLIENT_ID",
  "MSP_ID",
  "FACILITY_NAME",
  "CLIENT_STATE",
  "PAY_RATE",
  "OT_RATE",
  "HOLIDAY_RATE",
  "DT_RATE",
  "ON_CALL_RATE",
  "CALL_BACK_RATE",
  "BILL_RATE",
  "CLIENT_OT_RATE",
  "CLIENT_HOLIDAY_RATE",
  "CLIENT_DT_RATE",
  "CLIENT_ON_CALL_RATE",
  "CLIENT_CALL_BACK_RATE",
];

/** Source columns read off the latest deal sheet version (START_DATE comes from INITIAL_START_DATE). */
const SOURCE_COLUMNS = [
  "DEAL_SHEET_ID",
  "INITIAL_START_DATE",
  ...PAYLOAD_FIELDS,
];

function resolveSettings(overrides = {}) {
  const w = config.aitaWebhook;
  return {
    enabled: overrides.enabled ?? w.enabled,
    url: overrides.url ?? w.url,
    token: overrides.token ?? w.token,
    sourceTableId: overrides.sourceTableId ?? w.sourceTableId,
    outboxTableId: overrides.outboxTableId ?? w.outboxTableId,
    knownCandidatesTableId: overrides.knownCandidatesTableId ?? w.knownCandidatesTableId,
    datasetId: overrides.datasetId ?? config.datasetId,
    timeoutMs: overrides.timeoutMs ?? w.timeoutMs,
    concurrency: overrides.concurrency ?? w.concurrency,
    maxAttempts: overrides.maxAttempts ?? w.maxAttempts,
    maxEventsPerRun: overrides.maxEventsPerRun ?? w.maxEventsPerRun,
  };
}

function fqn(settings, tableId) {
  return `\`${config.projectId}.${settings.datasetId}.${tableId}\``;
}

/** BigQuery DATE / TIMESTAMP come back as {value}; AITA wants YYYY-MM-DD. */
function toIsoDate(v) {
  if (v == null) return null;
  const raw = typeof v === "object" && v.value !== undefined ? v.value : v;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString().slice(0, 10);
  const s = String(raw).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function toNumberOrNull(v) {
  if (v == null || v === "") return null;
  const raw = typeof v === "object" && v.value !== undefined ? v.value : v;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function toTrimmedOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function normalizeStatus(status) {
  return status == null ? "" : String(status).trim().toUpperCase();
}

function buildEventKey(row) {
  const ds = row?.DEAL_SHEET_ID == null ? "" : String(row.DEAL_SHEET_ID).trim();
  const pid = row?.PLACEMENT_ID == null ? "" : String(row.PLACEMENT_ID).trim();
  return `${ds}|${pid}|${normalizeStatus(row?.PLACEMENT_STATUS)}`;
}

/** Mirrors AITA's envelope rule: positive integer, no coercion of a bad id. */
function isValidPlacementId(v) {
  const n = toNumberOrNull(v);
  return n != null && Number.isInteger(n) && n > 0;
}

/**
 * Build the AITA payload for one latest-version row.
 * START_DATE is the contract's ORIGINAL start (INITIAL_START_DATE): AITA reads START_DATE on an
 * extension as the original start and EXTENSION_START_DATE as the segment start.
 */
function buildAitaPayload(row) {
  const out = {};
  for (const f of PAYLOAD_FIELDS) {
    switch (f) {
      case "PLACEMENT_ID":
      case "CANDIDATE_ID":
      case "CLIENT_ID":
      case "MSP_ID":
        out[f] = toNumberOrNull(row[f]);
        break;
      case "PLACEMENT_STATUS":
        out[f] = normalizeStatus(row[f]);
        break;
      case "START_DATE":
        out[f] = toIsoDate(row.INITIAL_START_DATE) ?? toIsoDate(row.START_DATE);
        break;
      case "END_DATE":
      case "EXTENSION_START_DATE":
        out[f] = toIsoDate(row[f]);
        break;
      default:
        out[f] = f.endsWith("_RATE") ? toNumberOrNull(row[f]) : toTrimmedOrNull(row[f]);
    }
  }
  return out;
}

/**
 * Reasons an event must not be POSTed. AITA answers 202 even for a bad envelope (stored as `failed`
 * with an alert on their side), so these are caught here instead.
 * @returns {string|null}
 */
function validateAitaPayload(payload) {
  if (!isValidPlacementId(payload.PLACEMENT_ID)) return "invalid PLACEMENT_ID";
  if (!AITA_PLACEMENT_STATUSES.includes(payload.PLACEMENT_STATUS)) return "status not in AITA scope";
  if (!payload.CANDIDATE_STATUS) return "missing CANDIDATE_STATUS";
  if (payload.END_DATE && payload.EXTENSION_START_DATE && payload.END_DATE < payload.EXTENSION_START_DATE) {
    return "END_DATE before EXTENSION_START_DATE";
  }
  if (payload.END_DATE && payload.START_DATE && payload.END_DATE < payload.START_DATE) {
    return "END_DATE before START_DATE";
  }
  return null;
}

function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Classify one HTTP outcome into the next outbox state.
 * @param {{httpStatus: number|null, attempts: number}} r - attempts already includes this one
 */
function classifyResult({ httpStatus, attempts }, maxAttempts) {
  if (httpStatus === 202) return STATE.SENT;
  return attempts >= maxAttempts ? STATE.FAILED : STATE.RETRY;
}

/** POST one exact body. Never throws: network errors come back as httpStatus=null. */
async function postAitaEvent(body, settings, deps = {}) {
  const post = deps.post || axios.post;
  try {
    const res = await post(settings.url, body, {
      headers: {
        "Authorization": `Bearer ${settings.token}`,
        "Content-Type": "application/json",
      },
      timeout: settings.timeoutMs,
      // Send the stored string as-is: re-serialising would change the bytes AITA de-duplicates on.
      transformRequest: [(data) => data],
      validateStatus: () => true,
    });
    return { httpStatus: res.status, error: res.status === 202 ? null : `HTTP ${res.status}` };
  } catch (err) {
    return { httpStatus: null, error: String(err?.code || err?.message || err).slice(0, 500) };
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

function outboxDdl(settings) {
  return `CREATE TABLE IF NOT EXISTS ${fqn(settings, settings.outboxTableId)} (
    EVENT_KEY STRING NOT NULL,
    DOMAIN STRING,
    DEAL_SHEET_ID INT64,
    PLACEMENT_ID INT64,
    CONTRACT_ID STRING,
    DEAL_TYPE STRING,
    PLACEMENT_STATUS STRING,
    STATE STRING,
    SKIP_REASON STRING,
    PAYLOAD_JSON STRING,
    PAYLOAD_SHA256 STRING,
    ATTEMPTS INT64,
    LAST_HTTP_STATUS INT64,
    LAST_ERROR STRING,
    CREATED_AT TIMESTAMP,
    LAST_ATTEMPT_AT TIMESTAMP,
    SENT_AT TIMESTAMP
  )`;
}

function knownCandidatesDdl(settings) {
  return `CREATE TABLE IF NOT EXISTS ${fqn(settings, settings.knownCandidatesTableId)} (
    CANDIDATE_ID INT64 NOT NULL,
    SEEDED_AT TIMESTAMP
  )`;
}

/** Latest version per deal sheet (by LAST_UPDATED) whose status is in AITA scope. */
function latestInScopeSql(settings) {
  const statuses = AITA_PLACEMENT_STATUSES.map((s) => `'${escapeSqlString(s)}'`).join(", ");
  return `
    SELECT * EXCEPT(rn) FROM (
      SELECT t.*, ROW_NUMBER() OVER (
        PARTITION BY t.DEAL_SHEET_ID, t.PLACEMENT_ID ORDER BY t.LAST_UPDATED DESC
      ) AS rn
      FROM ${fqn(settings, settings.sourceTableId)} t
      WHERE t.PLACEMENT_ID IS NOT NULL
    )
    WHERE rn = 1 AND UPPER(TRIM(PLACEMENT_STATUS)) IN (${statuses})`;
}

const EVENT_KEY_SQL =
  "CONCAT(COALESCE(CAST(DEAL_SHEET_ID AS STRING), ''), '|', CAST(PLACEMENT_ID AS STRING), '|', UPPER(TRIM(PLACEMENT_STATUS)))";

/** Outbox row count; 0 when the table does not exist yet (a dry run never creates it). */
async function countOutboxRows(settings, deps) {
  const q = deps.queryObjects || queryObjects;
  try {
    const rows = await q(`SELECT COUNT(*) AS n FROM ${fqn(settings, settings.outboxTableId)}`);
    return Number(rows?.[0]?.n ?? 0);
  } catch (err) {
    if (/not found/i.test(String(err?.message || err))) return 0;
    throw err;
  }
}

/**
 * Go-live snapshot, pure SQL: every CANDIDATE_ID already in the table becomes "known" (never sent), and
 * every current in-scope key is recorded as `baseline` (no payload, never sent).
 */
async function seedBaseline(settings, deps) {
  const dml = deps.runDml || runDml;
  await dml(`
    INSERT INTO ${fqn(settings, settings.knownCandidatesTableId)} (CANDIDATE_ID, SEEDED_AT)
    SELECT DISTINCT CANDIDATE_ID, CURRENT_TIMESTAMP()
    FROM ${fqn(settings, settings.sourceTableId)}
    WHERE CANDIDATE_ID IS NOT NULL
      AND CANDIDATE_ID NOT IN (SELECT CANDIDATE_ID FROM ${fqn(settings, settings.knownCandidatesTableId)})`);
  return dml(`
    INSERT INTO ${fqn(settings, settings.outboxTableId)}
      (EVENT_KEY, DOMAIN, DEAL_SHEET_ID, PLACEMENT_ID, CONTRACT_ID, DEAL_TYPE, PLACEMENT_STATUS, STATE, ATTEMPTS, CREATED_AT)
    SELECT ${EVENT_KEY_SQL}, 'health', DEAL_SHEET_ID, PLACEMENT_ID, CONTRACT_ID, DEAL_TYPE,
      UPPER(TRIM(PLACEMENT_STATUS)), '${STATE.BASELINE}', 0, CURRENT_TIMESTAMP()
    FROM (${latestInScopeSql(settings)}) l
    WHERE ${EVENT_KEY_SQL} NOT IN (SELECT EVENT_KEY FROM ${fqn(settings, settings.outboxTableId)})`);
}

async function fetchNewEventRows(settings, deps) {
  const q = deps.queryObjects || queryObjects;
  const cols = SOURCE_COLUMNS.map((c) => `l.${c}`).join(", ");
  return q(`
    SELECT ${cols}
    FROM (${latestInScopeSql(settings)}) l
    WHERE ${EVENT_KEY_SQL} NOT IN (SELECT EVENT_KEY FROM ${fqn(settings, settings.outboxTableId)})
      AND l.CANDIDATE_ID IS NOT NULL
      AND l.CANDIDATE_ID NOT IN (SELECT CANDIDATE_ID FROM ${fqn(settings, settings.knownCandidatesTableId)})
    ORDER BY l.LAST_UPDATED
    LIMIT ${Number(settings.maxEventsPerRun) + 1}`);
}

async function fetchRetryRows(settings, deps) {
  const q = deps.queryObjects || queryObjects;
  return q(`
    SELECT EVENT_KEY, PAYLOAD_JSON, ATTEMPTS
    FROM ${fqn(settings, settings.outboxTableId)}
    WHERE STATE IN ('${STATE.PENDING}', '${STATE.RETRY}') AND PAYLOAD_JSON IS NOT NULL
    ORDER BY CREATED_AT
    LIMIT ${Number(settings.maxEventsPerRun)}`);
}

function sqlStr(v) {
  return v == null ? "NULL" : `'${escapeSqlString(String(v))}'`;
}

function sqlInt(v) {
  const n = toNumberOrNull(v);
  return n == null || !Number.isInteger(n) ? "NULL" : String(n);
}

/** Insert new events (pending or skipped) with their exact payload, before anything is POSTed. */
async function insertOutboxEvents(events, settings, deps) {
  if (events.length === 0) return 0;
  const dml = deps.runDml || runDml;
  const values = events
    .map(
      (e) =>
        `(${sqlStr(e.eventKey)}, 'health', ${sqlInt(e.dealSheetId)}, ${sqlInt(e.payload.PLACEMENT_ID)}, ` +
        `${sqlStr(e.payload.CONTRACT_ID)}, ${sqlStr(e.payload.DEAL_TYPE)}, ${sqlStr(e.payload.PLACEMENT_STATUS)}, ` +
        `${sqlStr(e.state)}, ${sqlStr(e.skipReason)}, ${sqlStr(e.body)}, ${sqlStr(sha256(e.body))}, 0, CURRENT_TIMESTAMP())`
    )
    .join(",\n");
  return dml(`
    INSERT INTO ${fqn(settings, settings.outboxTableId)}
      (EVENT_KEY, DOMAIN, DEAL_SHEET_ID, PLACEMENT_ID, CONTRACT_ID, DEAL_TYPE, PLACEMENT_STATUS, STATE, SKIP_REASON, PAYLOAD_JSON, PAYLOAD_SHA256, ATTEMPTS, CREATED_AT)
    VALUES ${values}`);
}

/** Write every attempt's outcome back in one MERGE. */
async function recordAttempts(results, settings, deps) {
  if (results.length === 0) return 0;
  const dml = deps.runDml || runDml;
  const rows = results
    .map(
      (r) =>
        `STRUCT(${sqlStr(r.eventKey)} AS EVENT_KEY, ${sqlStr(r.state)} AS STATE, ${sqlInt(r.attempts)} AS ATTEMPTS, ` +
        `${sqlInt(r.httpStatus)} AS LAST_HTTP_STATUS, ${sqlStr(r.error)} AS LAST_ERROR)`
    )
    .join(",\n");
  return dml(`
    MERGE ${fqn(settings, settings.outboxTableId)} T
    USING (SELECT * FROM UNNEST([${rows}])) S
    ON T.EVENT_KEY = S.EVENT_KEY
    WHEN MATCHED THEN UPDATE SET
      STATE = S.STATE,
      ATTEMPTS = S.ATTEMPTS,
      LAST_HTTP_STATUS = S.LAST_HTTP_STATUS,
      LAST_ERROR = S.LAST_ERROR,
      LAST_ATTEMPT_AT = CURRENT_TIMESTAMP(),
      SENT_AT = IF(S.STATE = '${STATE.SENT}', CURRENT_TIMESTAMP(), T.SENT_AT)`);
}

/** Turn latest-version rows into outbox events (payload built, validated, serialised once). */
function buildEvents(rows) {
  return rows.map((row) => {
    const payload = buildAitaPayload(row);
    const skipReason = validateAitaPayload(payload);
    return {
      eventKey: buildEventKey(row),
      dealSheetId: row.DEAL_SHEET_ID,
      payload,
      body: JSON.stringify(payload),
      state: skipReason ? STATE.SKIPPED : STATE.PENDING,
      skipReason,
    };
  });
}

/**
 * One webhook pass for Health.
 *
 * @param {object} [params]
 * @param {boolean} [params.dryRun] - build and return the events; no POST and no outbox writes
 * @param {object} [params.settings] - overrides for config.aitaWebhook (tests)
 * @param {object} [deps] - {queryObjects, runDml, post} injection for tests
 */
async function runAitaWebhookSyncHealth(params = {}, deps = {}) {
  const settings = resolveSettings(params.settings);
  const dryRun = params.dryRun === true;
  const dml = deps.runDml || runDml;
  const tag = "[aitaWebhookHealth]";

  if (!dryRun && !settings.enabled) {
    logLine(`${tag} disabled (AITA_WEBHOOK_ENABLED is not true) — nothing sent`);
    return { skipped: true, reason: "disabled" };
  }
  if (!dryRun && (!settings.url || !settings.token)) {
    logError(`${tag} AITA_WEBHOOK_URL / AITA_WEBHOOK_TOKEN not set — nothing sent`);
    return { skipped: true, reason: "missing url or token" };
  }

  if (!dryRun) {
    await dml(outboxDdl(settings));
    await dml(knownCandidatesDdl(settings));
  }

  if ((await countOutboxRows(settings, deps)) === 0) {
    if (dryRun) {
      logLine(`${tag} dry run: outbox is empty, a real run would seed the baseline and send nothing`);
      return { dryRun: true, baselineNeeded: true, events: [] };
    }
    const seeded = await seedBaseline(settings, deps);
    logLine(`${tag} first run: known candidates + ${seeded} baseline keys seeded, sent nothing (fresh candidates only from now on)`);
    return { baselineSeeded: seeded, sent: 0 };
  }

  const rows = await fetchNewEventRows(settings, deps);
  const capped = rows.length > settings.maxEventsPerRun;
  const events = buildEvents(rows.slice(0, settings.maxEventsPerRun));
  if (capped) {
    logLine(`${tag} more than ${settings.maxEventsPerRun} new events — the rest go next run`);
  }

  if (dryRun) {
    logLine(`${tag} dry run: ${events.length} new events (nothing sent, nothing written)`);
    return {
      dryRun: true,
      capped,
      events: events.map((e) => ({ eventKey: e.eventKey, state: e.state, skipReason: e.skipReason, payload: e.payload })),
    };
  }

  await insertOutboxEvents(events, settings, deps);

  // Retry rows include the pending events just inserted, so one path sends everything — always
  // from the stored PAYLOAD_JSON.
  const toSend = await fetchRetryRows(settings, deps);
  const results = [];
  let authFailed = false;
  await mapWithConcurrency(toSend, settings.concurrency, async (r) => {
    if (authFailed) return;
    const attempts = Number(r.ATTEMPTS || 0) + 1;
    const { httpStatus, error } = await postAitaEvent(r.PAYLOAD_JSON, settings, deps);
    if (httpStatus === 401) authFailed = true;
    results.push({
      eventKey: r.EVENT_KEY,
      attempts,
      httpStatus,
      error,
      state: classifyResult({ httpStatus, attempts }, settings.maxAttempts),
    });
  });
  await recordAttempts(results, settings, deps);

  const count = (s) => results.filter((r) => r.state === s).length;
  const summary = {
    newEvents: events.length,
    skipped: events.filter((e) => e.state === STATE.SKIPPED).length,
    attempted: results.length,
    sent: count(STATE.SENT),
    retry: count(STATE.RETRY),
    failed: count(STATE.FAILED),
    authFailed,
    capped,
  };
  if (authFailed) logError(`${tag} AITA returned 401 — check AITA_WEBHOOK_TOKEN; run stopped`);
  if (summary.failed > 0) logError(`${tag} ${summary.failed} events failed after ${settings.maxAttempts} attempts`);
  logLine(`${tag} done ${JSON.stringify(summary)}`);
  return summary;
}

module.exports = {
  AITA_PLACEMENT_STATUSES,
  STATE,
  PAYLOAD_FIELDS,
  buildAitaPayload,
  validateAitaPayload,
  buildEventKey,
  isValidPlacementId,
  toIsoDate,
  classifyResult,
  postAitaEvent,
  buildEvents,
  runAitaWebhookSyncHealth,
};
