/**
 * Firebase Functions for Deal Sheet BigQuery Sync (Gen2 — longer timeouts)
 *
 * 1. dealSheetSync — HTTP (v2 onRequest, up to 3600s)
 * 2. rateChangeLogSync — HTTP rate-change log (BigQuery CONTRACT_ID scan)
 * 3. dealSheetSyncTrigger — scheduled insert (new deal sheets only)
 * 4. dealSheetSyncUpdateTrigger — scheduled update (existing BQ composites); also runs the
 *    recruiter-reassignment / CSM-divergence audit log scan (inorganic_hierarchy_logs) as its
 *    last step, on the same invocation
 * 5. dealSheetSyncOfferRejected — HTTP ended / offer-rejected stream (manual)
 * 6. rateChangeLogSyncTrigger — scheduled rate-change logs (BigQuery CONTRACT_ID scan)
 * 7. bulkBackfillByPlacementId — HTTP bulk Nexus backfill (no BQ baseline checks)
 * 8. inorganicHierarchyLogSync — HTTP manual/debug trigger for the audit log scan (see 4.)
 */

const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const {
  syncEnrichedDealSheetCandidatesToBigQuery,
  syncExistingActiveDealSheetUpdatesFromBigQuery,
  syncRateChangeLogsFromBigQuery,
  syncInorganicHierarchyLogsFromBigQuery,
  syncOwnershipChangeLogsFromBigQuery,
  syncOwnershipChangeLogEffectiveDatesFromExtensions,
  refreshPlacementRecordToBigQuery,
  bulkBackfillPlacementRecordsFromNexus,
  resolveBulkBackfillMaxPlacementIds,
} = require("./syncService");
const { syncPeopleStrongEmployeeDetailsToBigQuery } = require("./peoplestrongEmployeeDetailsService");
const { logLine, logError, withTimingAsync } = require("./logger");
const { startDateOnOrAfterUtcMin, effectiveMinFilterDate } = require("./columnMappings");
const { transformOfferRejectedEndedRowsForBigQuery } = require("./offerRejectedRowTransform");

admin.initializeApp();

const REGION = "us-central1";
const ENDED_BACKFILL_SUBMITTAL_CODES = "EARLY_TERM,COMPLETED,CANCELLED,CANCELED";
/** Firestore pagination cursor for HTTP ended (domain-routed) offer-rejected sync */
const OFFER_REJECTED_SYNC_CHECKPOINT_KEY = "offer-rejected-ended-records";
/** Firestore pair-index cursor for scheduled active update sync (distinct from Nexus page checkpoints) */
const ACTIVE_UPDATE_SYNC_CHECKPOINT_KEY = "active-deal-sheet-update-cursor";
/** Firestore submittal-page cursor for scheduled active INSERT trigger. On a socket-hangup / thrown
 *  error mid-run the failed page is saved here and the next run resumes from it; once every page is
 *  processed the doc is deleted (clear_checkpoint_on_complete) so the next run rescans from page 1. */
const ACTIVE_INSERT_SYNC_CHECKPOINT_KEY = "active-deal-sheet-insert-page-cursor";
/** First-insert placement allowlist for new DEAL_SHEET_ID+PLACEMENT_ID baselines on active `dealSheetSyncTrigger`
 *  (STARTED/BOOKED, plus DID NOT ACCEPT for offer-rejected and DID NOT START for cancelled VERBAL
 *  candidates admitted below). */
const ACTIVE_BOOTSTRAP_FIRST_INSERT_PLACEMENT_STATUSES = "STARTED,BOOKED,ENDED,ENDED<30,DID NOT ACCEPT,DID NOT START,OFFERED";
/** First-insert allowlist for `dealSheetSyncOfferRejected` ended tables (wider than active scheduled) */
const ACTIVE_EXPANDED_FIRST_INSERT_PLACEMENT_STATUSES =
  "STARTED,BOOKED,ENDED,ENDED<30,DID NOT START,DID NOT ACCEPT";
/** Active HTTP/trigger + scheduled update: only insert rows with START_DATE on or after this day (UTC). */
const DEAL_SHEET_MIN_START_DATE_MS = Date.UTC(2026, 4, 1);
/** Same lower bound as YYYY-MM-DD, pushed to the Nexus job-submittals list as start_date_from so the
 *  scan fetches only relevant submittals. Derived from the ms constant so the two never drift. */
const DEAL_SHEET_MIN_START_DATE_ISO = new Date(DEAL_SHEET_MIN_START_DATE_MS).toISOString().slice(0, 10);

/** Nexus submittal filter for scheduled insert trigger (new deal sheets only).
 *  OFFER_REJECTED (-> DID NOT ACCEPT) and CANCELLED/CANCELED (-> DID NOT START) included so those
 *  candidates (deal sheet often only VERBAL) are picked up into the ACTIVE tables too — their VERBAL
 *  deal sheet is admitted via deal_sheet_status_codes=FINAL,VERBAL and the placement status is mapped
 *  by mapSubmittalCodeToPlacementStatus.
 *  COMPLETED (-> ENDED) and EARLY_TERM (-> ENDED / ENDED<30) included so ended placements are fetched
 *  into the ACTIVE tables as well (admitted by the ENDED/ENDED<30 entries in
 *  ACTIVE_BOOTSTRAP_FIRST_INSERT_PLACEMENT_STATUSES); they stay in the active tables (no move-to-ended
 *  routing runs on this path). */
const ACTIVE_BOOTSTRAP_SUBMITTAL_CODES = "PERM_STARTS,ACTIVE,BOOKED,OFFER_REJECTED,CANCELLED,CANCELED,OFFERED,COMPLETED,EARLY_TERM";

function filterEnrichedRowsByDealSheetMinStartDate(rows) {
  return rows.filter((row) =>
    startDateOnOrAfterUtcMin(effectiveMinFilterDate(row), DEAL_SHEET_MIN_START_DATE_MS)
  );
}

/** Max placement composites refreshed per `dealSheetSyncUpdateTrigger` invocation (env override). */
function resolveDealSheetUpdateTriggerMaxPairs() {
  const raw = process.env.DEAL_SHEET_UPDATE_TRIGGER_MAX_PAIRS;
  const n = parseInt(String(raw != null && raw !== "" ? raw : "500").trim(), 10);
  if (!Number.isFinite(n) || n < 1) return 500;
  return n;
}

/**
 * Optional per-run submittal-page cap for `dealSheetSyncTrigger` (env override). 0 = no cap (default).
 * Set DEAL_SHEET_INSERT_TRIGGER_MAX_PAGES > 0 so each run voluntarily stops after N pages, writes the
 * page checkpoint, and the next scheduled run resumes — protects against the 1800s hard timeout (which
 * kills the process before the error-pause checkpoint can be written) when the full scan is large.
 */
function resolveDealSheetInsertTriggerMaxPages() {
  const raw = process.env.DEAL_SHEET_INSERT_TRIGGER_MAX_PAGES;
  const n = parseInt(String(raw != null && raw !== "" ? raw : "0").trim(), 10);
  if (!Number.isFinite(n) || n < 1) return 0;
  return n;
}
/** Gen2 HTTP: max 3600s; avoids 540s Gen1 cap on full sync */
const HTTP_TIMEOUT_SEC = 3600;
const HTTP_MEMORY = "2GiB";
/** Gen2 scheduled (Pub/Sub) functions are capped at 1800s by Cloud Run. */
const SCHEDULE_TIMEOUT_SEC = 1800;
const SCHEDULE_MEMORY = "1GiB";

/**
 * HTTP: manual / API sync
 *
 * Query: only_new, max_candidates, test_limit, max_pages,
 *        resume, reset_checkpoint, checkpoint_key (chunked backfill controls),
 *        submittal_codes, bq_table, bq_dataset (per-run Nexus filter + BigQuery target),
 *        checkpoint_use_submittal_page=true (Firestore saves next submittal list page),
 *        use_ended_domain_routing=true (three ended tables by recruiter email; requires no bq_table)
 *
 * Inserts are limited to rows with START_DATE >= 2026-05-01 (see DEAL_SHEET_MIN_START_DATE_MS).
 */
exports.dealSheetSync = onRequest(
  {
    region: REGION,
    timeoutSeconds: HTTP_TIMEOUT_SEC,
    memory: HTTP_MEMORY,
  },
  async (req, res) => {
    const wallStartMs = Date.now();
    try {
      const result = await withTimingAsync("dealSheetSync", async () => {
        const q = req.query || {};
        const submittalCodesRaw =
          typeof q.submittal_codes === "string"
            ? q.submittal_codes.trim()
            : typeof q.organization_submittal_status_code === "string"
              ? q.organization_submittal_status_code.trim()
              : "";
        const bqTableRaw = typeof q.bq_table === "string" ? q.bq_table.trim() : "";
        const bqDatasetRaw = typeof q.bq_dataset === "string" ? q.bq_dataset.trim() : "";
        const onlyNew = q.only_new !== "false";
        const dedupeByPlacementId = q.dedupe_by_placement_id !== "false";
        logLine(
          `[dealSheetSync] HTTP Gen2 region=${REGION} timeoutSeconds=${HTTP_TIMEOUT_SEC} method=${req.method} only_new=${onlyNew ? "true" : "false"} dedupe_by_placement_id=${dedupeByPlacementId ? "true" : "false"} max_candidates=${q.max_candidates || "none"} test_limit=${q.test_limit || "none"} max_pages=${q.max_pages || "none"} resume=${q.resume || "false"} reset_checkpoint=${q.reset_checkpoint || "false"} checkpoint_key=${q.checkpoint_key || "default"} submittal_codes=${submittalCodesRaw || "default"} bq_table=${bqTableRaw || "default"} bq_dataset=${bqDatasetRaw || "default"} START_DATE>=2026-05-01 only`
        );

        const maxCandidates = parseInt(q.max_candidates || "0", 10);
        const testLimit = parseInt(q.test_limit || "0", 10);
        const maxPages = parseInt(q.max_pages || "0", 10);
        const maxPagesProvided = Object.prototype.hasOwnProperty.call(q, "max_pages");
        const resume = q.resume === "true";
        const resetCheckpoint = q.reset_checkpoint === "true";
        const checkpointKey = typeof q.checkpoint_key === "string" ? q.checkpoint_key.trim() : "";

        const params = {};
        if (onlyNew) params.only_new_deal_sheets = true;
        if (dedupeByPlacementId) params.dedupe_by_placement_id = true;
        if (maxCandidates > 0) params.max_candidates = maxCandidates;
        if (testLimit > 0) params.test_submittal_limit = testLimit;
        if (maxPagesProvided) {
          params.max_pages_provided = true;
          if (maxPages > 0) params.max_pages = maxPages;
        }
        if (resume) params.resume_from_checkpoint = true;
        if (resetCheckpoint) params.reset_checkpoint = true;
        if (checkpointKey) params.checkpoint_key = checkpointKey;
        if (submittalCodesRaw) params.organization_submittal_status_code = submittalCodesRaw;
        if (bqTableRaw) params.bq_table = bqTableRaw;
        if (bqDatasetRaw) params.bq_dataset = bqDatasetRaw;
        if (q.checkpoint_use_submittal_page === "true") params.checkpoint_use_submittal_page = true;
        if (q.use_ended_domain_routing === "true") params.use_ended_domain_routing = true;

        params.transform_rows_fn = filterEnrichedRowsByDealSheetMinStartDate;

        logLine(`[dealSheetSync] Params object: ${JSON.stringify(params)}`);
        logLine(
          `[dealSheetSync] Invoking syncEnrichedDealSheetCandidatesToBigQuery (submittals -> deal-sheet-candidates -> enrich -> BigQuery)`
        );

        return syncEnrichedDealSheetCandidatesToBigQuery(params);
      });

      const executionTimeMs = Date.now() - wallStartMs;
      logLine(
        `[dealSheetSync] DONE success inserted=${result.inserted} candidatesProcessed=${result.candidatesProcessed} errorBatches=${result.errorBatches} executionTimeMs=${executionTimeMs}`
      );

      res.status(200).json({
        success: true,
        message: "Deal sheet sync completed successfully",
        result,
        executionTimeMs,
      });
    } catch (error) {
      const executionTimeMs = Date.now() - wallStartMs;
      logError(`[dealSheetSync] FAILED after ${executionTimeMs}ms`, error);

      res.status(500).json({
        success: false,
        error: error.message,
        executionTimeMs,
      });
    }
  }
);

/**
 * HTTP: rate-change log sync (BigQuery CONTRACT_ID scan; no Nexus)
 */
exports.rateChangeLogSync = onRequest(
  {
    region: REGION,
    timeoutSeconds: HTTP_TIMEOUT_SEC,
    memory: HTTP_MEMORY,
  },
  async (req, res) => {
    const wallStartMs = Date.now();
    try {
      const result = await withTimingAsync("rateChangeLogSync", async () => {
        const q = req.query || {};
        const bqTableRaw = typeof q.bq_table === "string" ? q.bq_table.trim() : "";
        const bqDatasetRaw = typeof q.bq_dataset === "string" ? q.bq_dataset.trim() : "";
        const dealSheetDatasetRaw =
          typeof q.deal_sheet_bq_dataset === "string" ? q.deal_sheet_bq_dataset.trim() : "";
        logLine(
          `[rateChangeLogSync] HTTP Gen2 region=${REGION} timeoutSeconds=${HTTP_TIMEOUT_SEC} method=${req.method} bq_table=${bqTableRaw || "default"} bq_dataset=${bqDatasetRaw || "default"} deal_sheet_bq_dataset=${dealSheetDatasetRaw || "default"}`
        );

        const params = {};
        if (bqTableRaw) params.bq_table = bqTableRaw;
        if (bqDatasetRaw) params.bq_dataset = bqDatasetRaw;
        if (dealSheetDatasetRaw) params.deal_sheet_bq_dataset = dealSheetDatasetRaw;

        logLine(`[rateChangeLogSync] Params object: ${JSON.stringify(params)}`);
        logLine(`[rateChangeLogSync] Invoking syncRateChangeLogsFromBigQuery`);
        return syncRateChangeLogsFromBigQuery(params);
      });

      const executionTimeMs = Date.now() - wallStartMs;
      logLine(
        `[rateChangeLogSync] DONE success inserted=${result.inserted} total=${result.total} rateChangeYes=${result.rateChangeYes} errorBatches=${result.errorBatches} executionTimeMs=${executionTimeMs}`
      );

      res.status(200).json({
        success: true,
        message: "Rate change log sync completed successfully",
        result,
        executionTimeMs,
      });
    } catch (error) {
      const executionTimeMs = Date.now() - wallStartMs;
      logError(`[rateChangeLogSync] FAILED after ${executionTimeMs}ms`, error);

      res.status(500).json({
        success: false,
        error: error.message,
        executionTimeMs,
      });
    }
  }
);

/**
 * HTTP: manual/debug trigger for the recruiter-reassignment + CSM-divergence audit log scan.
 * The scheduled path is dealSheetSyncUpdateTrigger (runs this automatically as its last step);
 * this endpoint exists only for on-demand testing/re-runs.
 */
exports.inorganicHierarchyLogSync = onRequest(
  {
    region: REGION,
    timeoutSeconds: HTTP_TIMEOUT_SEC,
    memory: HTTP_MEMORY,
  },
  async (req, res) => {
    const wallStartMs = Date.now();
    try {
      const result = await withTimingAsync("inorganicHierarchyLogSync", async () => {
        const q = req.query || {};
        const bqTableRaw = typeof q.bq_table === "string" ? q.bq_table.trim() : "";
        const bqDatasetRaw = typeof q.bq_dataset === "string" ? q.bq_dataset.trim() : "";
        const dealSheetDatasetRaw =
          typeof q.deal_sheet_bq_dataset === "string" ? q.deal_sheet_bq_dataset.trim() : "";
        logLine(
          `[inorganicHierarchyLogSync] HTTP Gen2 region=${REGION} timeoutSeconds=${HTTP_TIMEOUT_SEC} method=${req.method} bq_table=${bqTableRaw || "default"} bq_dataset=${bqDatasetRaw || "default"} deal_sheet_bq_dataset=${dealSheetDatasetRaw || "default"}`
        );

        const params = {};
        if (bqTableRaw) params.bq_table = bqTableRaw;
        if (bqDatasetRaw) params.bq_dataset = bqDatasetRaw;
        if (dealSheetDatasetRaw) params.deal_sheet_bq_dataset = dealSheetDatasetRaw;

        logLine(`[inorganicHierarchyLogSync] Params object: ${JSON.stringify(params)}`);
        logLine(`[inorganicHierarchyLogSync] Invoking syncInorganicHierarchyLogsFromBigQuery`);
        return syncInorganicHierarchyLogsFromBigQuery(params);
      });

      const executionTimeMs = Date.now() - wallStartMs;
      logLine(
        `[inorganicHierarchyLogSync] DONE success inserted=${result.inserted} total=${result.total} candidates=${result.candidates} errorBatches=${result.errorBatches} executionTimeMs=${executionTimeMs}`
      );

      res.status(200).json({
        success: true,
        message: "Inorganic hierarchy log sync completed successfully",
        result,
        executionTimeMs,
      });
    } catch (error) {
      const executionTimeMs = Date.now() - wallStartMs;
      logError(`[inorganicHierarchyLogSync] FAILED after ${executionTimeMs}ms`, error);

      res.status(500).json({
        success: false,
        error: error.message,
        executionTimeMs,
      });
    }
  }
);

/**
 * HTTP: PeopleStrong employee details sync to BigQuery
 * Query: bq_dataset, bq_table
 */
exports.peoplestrongEmployeeDetailsSync = onRequest(
  {
    region: REGION,
    timeoutSeconds: HTTP_TIMEOUT_SEC,
    memory: HTTP_MEMORY,
  },
  async (req, res) => {
    const wallStartMs = Date.now();
    try {
      const result = await withTimingAsync("peoplestrongEmployeeDetailsSync", async () => {
        const q = req.query || {};
        const bqDatasetRaw = typeof q.bq_dataset === "string" ? q.bq_dataset.trim() : "";
        const bqTableRaw = typeof q.bq_table === "string" ? q.bq_table.trim() : "";

        logLine(
          `[peoplestrongEmployeeDetailsSync] HTTP Gen2 region=${REGION} timeoutSeconds=${HTTP_TIMEOUT_SEC} method=${req.method} bq_dataset=${bqDatasetRaw || "default"} bq_table=${bqTableRaw || "default"}`
        );

        const params = {};
        if (bqDatasetRaw) params.bq_dataset = bqDatasetRaw;
        if (bqTableRaw) params.bq_table = bqTableRaw;
        return syncPeopleStrongEmployeeDetailsToBigQuery(params);
      });

      const executionTimeMs = Date.now() - wallStartMs;
      res.status(200).json({
        success: true,
        message: "PeopleStrong employee details sync completed successfully",
        result,
        executionTimeMs,
      });
    } catch (error) {
      const executionTimeMs = Date.now() - wallStartMs;
      logError(`[peoplestrongEmployeeDetailsSync] FAILED after ${executionTimeMs}ms`, error);
      res.status(500).json({
        success: false,
        error: error.message,
        executionTimeMs,
      });
    }
  }
);

/**
 * HTTP: on-demand refresh by placement/deal-sheet/job identifiers.
 * Primary key: placement_id. Optional fallbacks: deal_sheet_id, job_id, candidate_id.
 */
exports.refreshDealSheetByPlacementId = onRequest(
  {
    region: REGION,
    timeoutSeconds: HTTP_TIMEOUT_SEC,
    memory: HTTP_MEMORY,
  },
  async (req, res) => {
    const wallStartMs = Date.now();
    try {
      const result = await withTimingAsync("refreshDealSheetByPlacementId", async () => {
        const q = req.query || {};
        const placementId = typeof q.placement_id === "string" ? q.placement_id.trim() : "";
        const dealSheetId = typeof q.deal_sheet_id === "string" ? q.deal_sheet_id.trim() : "";
        const jobId = typeof q.job_id === "string" ? q.job_id.trim() : "";
        const candidateId = typeof q.candidate_id === "string" ? q.candidate_id.trim() : "";
        const applyUpdate = typeof q.apply_update === "string" ? q.apply_update.trim() : "";
        const bqDatasetRaw = typeof q.bq_dataset === "string" ? q.bq_dataset.trim() : "";
        const bqTableRaw = typeof q.bq_table === "string" ? q.bq_table.trim() : "";

        if (!placementId && !dealSheetId && !jobId) {
          return {
            _badRequest: true,
            error: "Provide placement_id (preferred) or fallback deal_sheet_id/job_id",
          };
        }

        const params = {};
        if (placementId) params.placement_id = placementId;
        if (dealSheetId) params.deal_sheet_id = dealSheetId;
        if (jobId) params.job_id = jobId;
        if (candidateId) params.candidate_id = candidateId;
        if (applyUpdate) params.apply_update = applyUpdate;
        if (bqDatasetRaw) params.bq_dataset = bqDatasetRaw;
        if (bqTableRaw) params.bq_table = bqTableRaw;
        params.generated_uuid_field = "ID";
        params.compare_ignore_fields = ["ID", "DATE_AND_TIME", "IS_REJECTED"];
        params.first_insert_placement_status_allowlist =
          ACTIVE_EXPANDED_FIRST_INSERT_PLACEMENT_STATUSES;
        // Manual single-placement call: opt IN to the table-wide inorganic scan for full parity
        // (pass ?run_inorganic_scan=false to skip the heavy scan). Scheduled triggers never set this,
        // so their per-placement refreshes never trigger it (opt-in default OFF).
        params.refresh_run_inorganic_scan = q.run_inorganic_scan !== "false";

        logLine(
          `[refreshDealSheetByPlacementId] method=${req.method} placement_id=${placementId || "none"} deal_sheet_id=${dealSheetId || "none"} job_id=${jobId || "none"} candidate_id=${candidateId || "none"} apply_update=${applyUpdate || "default:true"} bq_dataset=${bqDatasetRaw || "rr_project_data"} bq_table=${bqTableRaw || "domain-routed (from ASSIGNMENT_RECRUITER_EMAIL)"} first_insert_placement_status_allowlist=${ACTIVE_EXPANDED_FIRST_INSERT_PLACEMENT_STATUSES}`
        );

        return refreshPlacementRecordToBigQuery(params);
      });

      if (result && result._badRequest) {
        res.status(400).json({ success: false, error: result.error });
        return;
      }

      const executionTimeMs = Date.now() - wallStartMs;
      const statusCode = result?.action === "NOT_FOUND" ? 404 : 200;
      res.status(statusCode).json({
        success: statusCode === 200,
        result,
        executionTimeMs,
      });
    } catch (error) {
      const executionTimeMs = Date.now() - wallStartMs;
      logError(`[refreshDealSheetByPlacementId] FAILED after ${executionTimeMs}ms`, error);
      res.status(500).json({
        success: false,
        error: error.message,
        executionTimeMs,
      });
    }
  }
);

/**
 * HTTP: bulk Nexus backfill by placement_id (POST JSON).
 * No BigQuery baseline/existence checks on deal-sheet rows; CONTRACT_ID always null.
 */
exports.bulkBackfillByPlacementId = onRequest(
  {
    region: REGION,
    timeoutSeconds: HTTP_TIMEOUT_SEC,
    memory: HTTP_MEMORY,
  },
  async (req, res) => {
    const wallStartMs = Date.now();
    try {
      const result = await withTimingAsync("bulkBackfillByPlacementId", async () => {
        const body = req.body && typeof req.body === "object" ? req.body : {};
        const q = req.query || {};

        let placementIds = [];
        if (Array.isArray(body.placement_ids)) {
          placementIds = body.placement_ids;
        } else if (typeof body.placement_ids === "string" && body.placement_ids.trim() !== "") {
          placementIds = body.placement_ids.split(",");
        } else if (typeof q.placement_ids === "string" && q.placement_ids.trim() !== "") {
          placementIds = q.placement_ids.split(",");
        }

        const params = { placement_ids: placementIds };
        const applyUpdate =
          body.apply_update != null
            ? body.apply_update
            : q.apply_update != null
              ? q.apply_update
              : undefined;
        if (applyUpdate != null) params.apply_update = applyUpdate;

        const bqDataset =
          typeof body.bq_dataset === "string"
            ? body.bq_dataset.trim()
            : typeof q.bq_dataset === "string"
              ? q.bq_dataset.trim()
              : "";
        if (bqDataset) params.bq_dataset = bqDataset;

        const bqTable =
          typeof body.bq_table === "string"
            ? body.bq_table.trim()
            : typeof q.bq_table === "string"
              ? q.bq_table.trim()
              : "";
        if (bqTable) params.bq_table = bqTable;

        const maxIds = resolveBulkBackfillMaxPlacementIds();
        logLine(
          `[bulkBackfillByPlacementId] method=${req.method} placement_ids=${placementIds.length} max_per_request=${maxIds} apply_update=${applyUpdate == null ? "default:true" : applyUpdate} bq_dataset=${bqDataset || "rr_project_data"} bq_table=${bqTable || "domain-routed (from ASSIGNMENT_RECRUITER_EMAIL)"}`
        );

        return bulkBackfillPlacementRecordsFromNexus(params);
      });

      if (result && result._badRequest) {
        res.status(400).json({ success: false, error: result.error });
        return;
      }

      const executionTimeMs = Date.now() - wallStartMs;
      res.status(200).json({
        ...result,
        executionTimeMs,
      });
    } catch (error) {
      const executionTimeMs = Date.now() - wallStartMs;
      logError(`[bulkBackfillByPlacementId] FAILED after ${executionTimeMs}ms`, error);
      res.status(500).json({
        success: false,
        error: error.message,
        executionTimeMs,
      });
    }
  }
);

/**
 * Scheduled: PeopleStrong employee sync daytime window.
 * Runs 8 times daily at 08:00-15:00 Eastern (hourly).
 */
exports.peoplestrongEmployeeDetailsSyncTrigger = onSchedule(
  {
    schedule: "0 8,9,10,11,12,13,14,15 * * *",
    timeZone: "America/New_York",
    region: REGION,
    timeoutSeconds: SCHEDULE_TIMEOUT_SEC,
    memory: SCHEDULE_MEMORY,
  },
  async (event) => {
    logLine(
      `[peoplestrongEmployeeDetailsSyncTrigger] Gen2 onSchedule region=${REGION} timeoutSeconds=${SCHEDULE_TIMEOUT_SEC} scheduleTime=${event.scheduleTime || "n/a"} jobName=${event.jobName || "n/a"}`
    );

    return withTimingAsync("peoplestrongEmployeeDetailsSyncTrigger", async () => {
      logLine(
        "[peoplestrongEmployeeDetailsSyncTrigger] Scheduled (hourly 8AM-3PM ET): PeopleStrong EmployeeData -> BigQuery target from env defaults"
      );
      logLine("[peoplestrongEmployeeDetailsSyncTrigger] Invoking syncPeopleStrongEmployeeDetailsToBigQuery");

      const result = await syncPeopleStrongEmployeeDetailsToBigQuery();

      logLine(
        `[peoplestrongEmployeeDetailsSyncTrigger] Pipeline result fetched=${result.fetched || 0} inserted=${result.inserted || 0} attempted=${result.attempted || 0} targetTable=${result.targetTable || "n/a"} elapsedMs=${result.elapsedMs || "n/a"}`
      );

      return { success: true, result };
    });
  }
);

/**
 * Scheduled: every 2 hours at :00 Eastern on ODD slots (09,11,13,15,17,19), alternating with
 * dealSheetSyncUpdateTrigger which runs on the EVEN hours in between (10,12,...). This gives a clean
 * insert -> (1h) update -> (1h) insert -> (1h) update rhythm: a new EXTENSION whose parent DEAL is
 * inserted in the same run (and may sort before it) gets its CONTRACT_ID / hierarchy / ORIGINAL_START_DATE
 * inherited on the very next update run, once the parent DEAL row exists in BigQuery.
 * Inserts **new** deal sheets only (DEAL_SHEET_ID not yet in BigQuery), first row STARTED/BOOKED.
 */
exports.dealSheetSyncTrigger = onSchedule(
  {
    schedule: "0 9,11,13,15,17,19 * * *",
    timeZone: "America/New_York",
    region: REGION,
    timeoutSeconds: SCHEDULE_TIMEOUT_SEC,
    memory: SCHEDULE_MEMORY,
  },
  async (event) => {
    logLine(
      `[dealSheetSyncTrigger] Gen2 onSchedule region=${REGION} timeoutSeconds=${SCHEDULE_TIMEOUT_SEC} scheduleTime=${event.scheduleTime || "n/a"} jobName=${event.jobName || "n/a"}`
    );

    return withTimingAsync("dealSheetSyncTrigger", async () => {
      const bqDataset = "rr_project_data";
      const organizationSubmittalCodes = ACTIVE_BOOTSTRAP_SUBMITTAL_CODES;
      const firstInsertPlacementStatuses = ACTIVE_BOOTSTRAP_FIRST_INSERT_PLACEMENT_STATUSES;
      const insertMaxPages = resolveDealSheetInsertTriggerMaxPages();

      logLine(
        `[dealSheetSyncTrigger] Scheduled insert-only: ${organizationSubmittalCodes} -> cynetdatabase.${bqDataset}; skip if DEAL_SHEET_ID or PLACEMENT_ID exists in BQ; START_DATE>=2026-05-01; first_insert_allowlist=${firstInsertPlacementStatuses}; no append-on-change; checkpoint_key=${ACTIVE_INSERT_SYNC_CHECKPOINT_KEY} (resume-on-error/timeout by submittal page, clear-on-complete); max_pages_per_run=${insertMaxPages || "none"}`
      );
      logLine("[dealSheetSyncTrigger] Invoking syncEnrichedDealSheetCandidatesToBigQuery");

      const result = await syncEnrichedDealSheetCandidatesToBigQuery({
        organization_submittal_status_code: organizationSubmittalCodes,
        only_new_deal_sheets: true,
        skip_existing_deal_sheet_or_placement: true,
        reject_if_existing_deal_sheet_or_placement: true,
        dedupe_by_placement_id: false,
        bq_dataset: bqDataset,
        generated_uuid_field: "ID",
        append_on_change_by_dealsheet: false,
        compare_ignore_fields: ["ID", "DATE_AND_TIME", "IS_REJECTED"],
        first_insert_placement_status_allowlist: firstInsertPlacementStatuses,
        // Bring in BOTH FINAL and VERBAL deal sheets (no longer FINAL-only).
        deal_sheet_status_codes: "FINAL,VERBAL",
        // Push the START_DATE >= 2026-05-01 lower bound to the Nexus list (server-side) so we fetch
        // ~1k relevant submittals instead of scanning every page (~3k+) and discarding old ones —
        // this is the real cut to the socket-hangup / timeout load. No upper bound (future starts).
        // filterEnrichedRowsByDealSheetMinStartDate stays below as the in-code safety net.
        submittal_start_date_from: DEAL_SHEET_MIN_START_DATE_ISO,
        transform_rows_fn: filterEnrichedRowsByDealSheetMinStartDate,
        // Page-level Firestore checkpoint: on a thrown socket-hangup (ECONNRESET after retries) the
        // failed submittal page is saved and the next run resumes from it; on a fully-successful pass
        // the doc is deleted so the next run rescans from page 1 to pick up newly-added deal sheets.
        resume_from_checkpoint: true,
        checkpoint_key: ACTIVE_INSERT_SYNC_CHECKPOINT_KEY,
        checkpoint_use_submittal_page: true,
        clear_checkpoint_on_complete: true,
        ...(insertMaxPages > 0 ? { max_pages: insertMaxPages, max_pages_provided: true } : {}),
      });

      logLine(
        `[dealSheetSyncTrigger] Pipeline result inserted=${result.inserted} candidatesProcessed=${result.candidatesProcessed} errorBatches=${result.errorBatches} elapsed=${result.elapsed || "n/a"} pagesProcessed=${result.pagesProcessedThisRun ?? "n/a"}`
      );

      // Extensions get inserted here; reconcile ownership_change_logs EFFECTIVE_DATE from the
      // matching CONTRACT_ID's extension start date (overwrites the temporary tentative+1 value).
      logLine("[dealSheetSyncTrigger] Invoking syncOwnershipChangeLogEffectiveDatesFromExtensions");
      let ownershipEffectiveDateResult = null;
      try {
        ownershipEffectiveDateResult = await syncOwnershipChangeLogEffectiveDatesFromExtensions({
          deal_sheet_bq_dataset: bqDataset,
          bq_table: "ownership_change_logs",
        });
        logLine(
          `[dealSheetSyncTrigger] ownership effective-date overwrite updated=${ownershipEffectiveDateResult.updated == null ? "n/a" : ownershipEffectiveDateResult.updated} elapsed=${ownershipEffectiveDateResult.elapsed || "n/a"}`
        );
      } catch (effErr) {
        logError("[dealSheetSyncTrigger] ownership effective-date overwrite FAILED (non-fatal)", effErr);
      }

      // Fresh inserts freeze hierarchy as of NEW_HIRE_DATE; the org chart can already have moved on
      // by the time this same run happens (see recruiter-hierarchy-divergence signal below), so this
      // full active-table scan runs on both triggers, not just dealSheetSyncUpdateTrigger.
      logLine(
        "[dealSheetSyncTrigger] Invoking syncInorganicHierarchyLogsFromBigQuery (recruiter-change + CSM-divergence + recruiter-hierarchy-divergence scan)"
      );
      let inorganicHierarchyLogResult = null;
      try {
        inorganicHierarchyLogResult = await syncInorganicHierarchyLogsFromBigQuery({
          bq_dataset: bqDataset,
          bq_table: "inorganic_hierarchy_logs",
        });
        logLine(
          `[dealSheetSyncTrigger] inorganic hierarchy log result inserted=${inorganicHierarchyLogResult.inserted} recruiterChangePairs=${inorganicHierarchyLogResult.total} csmDivergences=${inorganicHierarchyLogResult.csmDivergences} recruiterHierarchyDivergences=${inorganicHierarchyLogResult.recruiterHierarchyDivergences} errorBatches=${inorganicHierarchyLogResult.errorBatches} elapsed=${inorganicHierarchyLogResult.elapsed || "n/a"}`
        );
      } catch (inorganicErr) {
        logError("[dealSheetSyncTrigger] inorganic hierarchy log scan FAILED (non-fatal)", inorganicErr);
      }

      // Ownership change logs incl. the recruiter-handover (previous->new recruiter + vacated role)
      // rows — runs on this insert trigger too (not just the update trigger) per requirement.
      logLine("[dealSheetSyncTrigger] Invoking syncOwnershipChangeLogsFromBigQuery (per-role + recruiter-handover scan)");
      let ownershipChangeLogResult = null;
      try {
        ownershipChangeLogResult = await syncOwnershipChangeLogsFromBigQuery({
          bq_dataset: bqDataset,
          bq_table: "ownership_change_logs",
        });
        logLine(
          `[dealSheetSyncTrigger] ownership change log result inserted=${ownershipChangeLogResult.inserted} changedPairs=${ownershipChangeLogResult.total} handoverRows=${ownershipChangeLogResult.handoverRows} builtRows=${ownershipChangeLogResult.builtRows} errorBatches=${ownershipChangeLogResult.errorBatches} elapsed=${ownershipChangeLogResult.elapsed || "n/a"}`
        );
      } catch (ownershipErr) {
        logError("[dealSheetSyncTrigger] ownership change log scan FAILED (non-fatal)", ownershipErr);
      }

      return {
        success: true,
        result,
        ownershipEffectiveDate: ownershipEffectiveDateResult,
        inorganicHierarchyLog: inorganicHierarchyLogResult,
        ownershipChangeLog: ownershipChangeLogResult,
      };
    });
  }
);

/**
 * Scheduled: every 2 hours at :00 Eastern on EVEN slots (10,12,14,16,18,20), interleaved with
 * dealSheetSyncTrigger's ODD slots — so an insert run is always followed ~1h later by an update run.
 * Loads existing DEAL_SHEET_IDs from BigQuery (placement_id fallback when deal sheet null), refreshes
 * via Nexus, appends on column diff vs latest deal-sheet row. This is also where a same-run-inserted
 * EXTENSION gets its parent-DEAL inheritance (CONTRACT_ID / hierarchy / ORIGINAL_START_DATE) filled in.
 */
exports.dealSheetSyncUpdateTrigger = onSchedule(
  {
    schedule: "0 10,12,14,16,18,20 * * *",
    timeZone: "America/New_York",
    region: REGION,
    timeoutSeconds: SCHEDULE_TIMEOUT_SEC,
    memory: SCHEDULE_MEMORY,
  },
  async (event) => {
    logLine(
      `[dealSheetSyncUpdateTrigger] Gen2 onSchedule region=${REGION} timeoutSeconds=${SCHEDULE_TIMEOUT_SEC} scheduleTime=${event.scheduleTime || "n/a"} jobName=${event.jobName || "n/a"}`
    );

    return withTimingAsync("dealSheetSyncUpdateTrigger", async () => {
      const bqDataset = "rr_project_data";
      const maxPairsPerRun = resolveDealSheetUpdateTriggerMaxPairs();

      logLine(
        `[dealSheetSyncUpdateTrigger] Scheduled update: cynetdatabase.${bqDataset}; BQ deal_sheet targets -> Nexus refresh; baseline=deal_sheet_id; priority=STARTED,BOOKED,ACTIVE (all each run); batch=ENDED,ENDED<30,DID NOT START,DID NOT ACCEPT+unknown; max_pairs_per_run=${maxPairsPerRun} (batch only); checkpoint_key=${ACTIVE_UPDATE_SYNC_CHECKPOINT_KEY}; START_DATE>=2026-05-01`
      );
      logLine("[dealSheetSyncUpdateTrigger] Invoking syncExistingActiveDealSheetUpdatesFromBigQuery");

      const result = await syncExistingActiveDealSheetUpdatesFromBigQuery({
        bq_dataset: bqDataset,
        resume_from_checkpoint: true,
        checkpoint_key: ACTIVE_UPDATE_SYNC_CHECKPOINT_KEY,
        clear_checkpoint_on_complete: true,
        max_pairs_per_run: maxPairsPerRun,
        min_start_date_ms: DEAL_SHEET_MIN_START_DATE_MS,
        generated_uuid_field: "ID",
        compare_ignore_fields: ["ID", "DATE_AND_TIME", "IS_REJECTED"],
      });

      logLine(
        `[dealSheetSyncUpdateTrigger] Pipeline result checked=${result.checked} appended=${result.appended} no_change=${result.no_change} not_found=${result.not_found} no_baseline=${result.no_baseline ?? 0} skipped_date=${result.skipped_date} errors=${result.errors} priorityTotal=${result.priorityTotal ?? "n/a"} priorityChecked=${result.priorityChecked ?? "n/a"} batchTotal=${result.batchTotal ?? "n/a"} batchCheckedThisRun=${result.batchCheckedThisRun ?? "n/a"} batchOffsetEnd=${result.batchOffsetEnd ?? result.targetOffsetEnd ?? "n/a"} targetTotal=${result.targetTotal ?? result.pairTotal ?? "n/a"} hasMore=${result.hasMore ? "yes" : "no"} elapsed=${result.elapsed || "n/a"}`
      );

      logLine(
        "[dealSheetSyncUpdateTrigger] Invoking syncInorganicHierarchyLogsFromBigQuery (recruiter-change + CSM-divergence + recruiter-hierarchy-divergence scan)"
      );
      let inorganicHierarchyLogResult = null;
      try {
        inorganicHierarchyLogResult = await syncInorganicHierarchyLogsFromBigQuery({
          bq_dataset: bqDataset,
          bq_table: "inorganic_hierarchy_logs",
        });
        logLine(
          `[dealSheetSyncUpdateTrigger] inorganic hierarchy log result inserted=${inorganicHierarchyLogResult.inserted} recruiterChangePairs=${inorganicHierarchyLogResult.total} csmDivergences=${inorganicHierarchyLogResult.csmDivergences} recruiterHierarchyDivergences=${inorganicHierarchyLogResult.recruiterHierarchyDivergences} errorBatches=${inorganicHierarchyLogResult.errorBatches} elapsed=${inorganicHierarchyLogResult.elapsed || "n/a"}`
        );
      } catch (inorganicErr) {
        // Non-fatal: the main deal-sheet update already succeeded above; don't fail the whole
        // trigger run over the audit-log scan.
        logError("[dealSheetSyncUpdateTrigger] inorganic hierarchy log scan FAILED (non-fatal)", inorganicErr);
      }

      logLine("[dealSheetSyncUpdateTrigger] Invoking syncOwnershipChangeLogsFromBigQuery (per-role ownership handover scan)");
      let ownershipChangeLogResult = null;
      try {
        ownershipChangeLogResult = await syncOwnershipChangeLogsFromBigQuery({
          bq_dataset: bqDataset,
          bq_table: "ownership_change_logs",
        });
        logLine(
          `[dealSheetSyncUpdateTrigger] ownership change log result inserted=${ownershipChangeLogResult.inserted} changedPairs=${ownershipChangeLogResult.total} handoverRows=${ownershipChangeLogResult.handoverRows} builtRows=${ownershipChangeLogResult.builtRows} errorBatches=${ownershipChangeLogResult.errorBatches} elapsed=${ownershipChangeLogResult.elapsed || "n/a"}`
        );
      } catch (ownershipErr) {
        // Non-fatal, same as the inorganic scan above.
        logError("[dealSheetSyncUpdateTrigger] ownership change log scan FAILED (non-fatal)", ownershipErr);
      }

      // Keep ownership_change_logs' placement dates (START_DATE / END_DATE_PREVIOUS_OWNER /
      // EFFECTIVE_DATE) in sync with each placement's CURRENT deal-sheet row. Date changes (e.g. a
      // placement going ENDED / ENDED<30, or START/TENTATIVE edits) happen on THIS update trigger,
      // so the overwrite must run here too — not only on dealSheetSyncTrigger. Runs AFTER the
      // ownership-change scan so freshly-inserted handover rows are re-dated as well. Non-fatal.
      logLine("[dealSheetSyncUpdateTrigger] Invoking syncOwnershipChangeLogEffectiveDatesFromExtensions (placement date sync)");
      let ownershipEffectiveDateResult = null;
      try {
        ownershipEffectiveDateResult = await syncOwnershipChangeLogEffectiveDatesFromExtensions({
          deal_sheet_bq_dataset: bqDataset,
          bq_table: "ownership_change_logs",
        });
        logLine(
          `[dealSheetSyncUpdateTrigger] ownership date sync updated=${ownershipEffectiveDateResult.updated == null ? "n/a" : ownershipEffectiveDateResult.updated} dealSheetUpdated=${ownershipEffectiveDateResult.dealSheetUpdated == null ? "n/a" : ownershipEffectiveDateResult.dealSheetUpdated} elapsed=${ownershipEffectiveDateResult.elapsed || "n/a"}`
        );
      } catch (effErr) {
        logError("[dealSheetSyncUpdateTrigger] ownership date sync FAILED (non-fatal)", effErr);
      }

      return {
        success: true,
        result,
        inorganicHierarchyLog: inorganicHierarchyLogResult,
        ownershipChangeLog: ownershipChangeLogResult,
        ownershipEffectiveDate: ownershipEffectiveDateResult,
      };
    });
  }
);

/**
 * HTTP: ended / offer-rejected stream (manual only — no Cloud Scheduler from Firebase).
 *
 * Query: `resume` (default true; set `resume=false` to start without reading checkpoint),
 *        `reset_checkpoint=true`, `checkpoint_key` (default `offer-rejected-ended-records`),
 *        `max_pages`, `max_candidates`, `test_limit`, `submittal_codes`, `bq_dataset`,
 *        `dedupe_by_placement_id` (default false; set `true` for legacy single-row-per-placement skip),
 *        `skip_did_not_accept_existing` (default false; set `true` to skip when BQ already has DID NOT ACCEPT),
 *        `checkpoint_use_submittal_page` (default true; set `false` to disable page cursor).
 *
 * BigQuery write path matches scheduled active sync: append-on-change, `ID` UUID, same compare-ignore fields,
 * and `first_insert_placement_status_allowlist` = expanded active list (ENDED etc. allowed on first baseline in ended tables).
 * With default `dedupe_by_placement_id=false`, multiple history rows per placement are possible (like active tables).
 * If you need one row per placement only, pass `dedupe_by_placement_id=true` and do not rely on append-on-change for that placement.
 *
 * Placement filter: DID NOT START, ENDED, ENDED<30, DID NOT ACCEPT; TENTATIVE_DATE >= 2026-05-01 UTC.
 * CONTRACT_ID: always null on ended inserts (`skip_contract_id`); allocation only on active insert (`dealSheetSyncTrigger` / `dealSheetSync` HTTP).
 * After deploy, delete the legacy GCP job `firebase-schedule-dealSheetSyncOfferRejectedTrigger-*` if it still exists.
 * To run from Cloud Scheduler, create an HTTP job targeting this function URL (GET/POST).
 */
exports.dealSheetSyncOfferRejected = onRequest(
  {
    region: REGION,
    timeoutSeconds: HTTP_TIMEOUT_SEC,
    memory: HTTP_MEMORY,
  },
  async (req, res) => {
    const wallStartMs = Date.now();
    try {
      const result = await withTimingAsync("dealSheetSyncOfferRejected", async () => {
        const q = req.query || {};
        const submittalCodesRaw =
          typeof q.submittal_codes === "string"
            ? q.submittal_codes.trim()
            : typeof q.organization_submittal_status_code === "string"
              ? q.organization_submittal_status_code.trim()
              : "";
        const bqDatasetRaw = typeof q.bq_dataset === "string" ? q.bq_dataset.trim() : "";
        const resume = q.resume !== "false";
        const resetCheckpoint = q.reset_checkpoint === "true";
        const checkpointKey =
          typeof q.checkpoint_key === "string" && q.checkpoint_key.trim() !== ""
            ? q.checkpoint_key.trim()
            : OFFER_REJECTED_SYNC_CHECKPOINT_KEY;
        const dedupeByPlacementId = q.dedupe_by_placement_id === "true";
        const skipDidNotAcceptExisting = q.skip_did_not_accept_existing === "true";
        const checkpointUseSubmittalPage = q.checkpoint_use_submittal_page !== "false";

        const maxCandidates = parseInt(q.max_candidates || "0", 10);
        const testLimit = parseInt(q.test_limit || "0", 10);
        const maxPages = parseInt(q.max_pages || "0", 10);
        const maxPagesProvided = Object.prototype.hasOwnProperty.call(q, "max_pages");

        logLine(
          `[dealSheetSyncOfferRejected] HTTP Gen2 region=${REGION} timeoutSeconds=${HTTP_TIMEOUT_SEC} method=${req.method} resume=${resume ? "true" : "false"} reset_checkpoint=${resetCheckpoint ? "true" : "false"} checkpoint_key=${checkpointKey} max_pages=${maxPagesProvided ? maxPages || "0" : "none"} max_candidates=${q.max_candidates || "none"} test_limit=${q.test_limit || "none"} submittal_codes=${submittalCodesRaw || "default"} bq_dataset=${bqDatasetRaw || "rr_project_data"} dedupe_by_placement_id=${dedupeByPlacementId ? "true" : "false"} skip_did_not_accept_existing=${skipDidNotAcceptExisting ? "true" : "false"} checkpoint_use_submittal_page=${checkpointUseSubmittalPage ? "true" : "false"}`
        );

        const params = {
          organization_submittal_status_code: submittalCodesRaw || ENDED_BACKFILL_SUBMITTAL_CODES,
          deal_sheet_status_codes: "FINAL",
          resume_from_checkpoint: resume,
          checkpoint_key: checkpointKey,
          clear_checkpoint_on_complete: true,
          dedupe_by_placement_id: dedupeByPlacementId,
          skip_did_not_accept_existing: skipDidNotAcceptExisting,
          bq_dataset: bqDatasetRaw || "rr_project_data",
          use_ended_domain_routing: true,
          checkpoint_use_submittal_page: checkpointUseSubmittalPage,
          generated_uuid_field: "ID",
          append_on_change_by_dealsheet: true,
          compare_ignore_fields: ["ID", "DATE_AND_TIME", "IS_REJECTED"],
          first_insert_placement_status_allowlist: ACTIVE_EXPANDED_FIRST_INSERT_PLACEMENT_STATUSES,
          transform_rows_fn: transformOfferRejectedEndedRowsForBigQuery,
          skip_contract_id: true,
        };

        if (resetCheckpoint) params.reset_checkpoint = true;
        if (maxCandidates > 0) params.max_candidates = maxCandidates;
        if (testLimit > 0) params.test_submittal_limit = testLimit;
        if (maxPagesProvided) {
          params.max_pages_provided = true;
          if (maxPages > 0) params.max_pages = maxPages;
        }

        logLine(`[dealSheetSyncOfferRejected] Params object: ${JSON.stringify({ ...params, transform_rows_fn: "[fn]" })}`);
        logLine("[dealSheetSyncOfferRejected] Invoking syncEnrichedDealSheetCandidatesToBigQuery");

        return syncEnrichedDealSheetCandidatesToBigQuery(params);
      });

      const executionTimeMs = Date.now() - wallStartMs;
      logLine(
        `[dealSheetSyncOfferRejected] DONE success inserted=${result.inserted} candidatesProcessed=${result.candidatesProcessed} errorBatches=${result.errorBatches} executionTimeMs=${executionTimeMs}`
      );

      res.status(200).json({
        success: true,
        message: "Offer-rejected ended deal sheet sync completed successfully",
        result,
        executionTimeMs,
      });
    } catch (error) {
      const executionTimeMs = Date.now() - wallStartMs;
      logError(`[dealSheetSyncOfferRejected] FAILED after ${executionTimeMs}ms`, error);

      res.status(500).json({
        success: false,
        error: error.message,
        executionTimeMs,
      });
    }
  }
);

/**
 * Scheduled: rate-change log stream (BigQuery CONTRACT_ID scan).
 * Scans active deal-sheet tables; when latest row per CONTRACT_ID has RATE_CHANGE=YES
 * and a previous row exists, writes OLD/NEW snapshot to ch_rate_change_logs.
 */
exports.rateChangeLogSyncTrigger = onSchedule(
  {
    schedule: "0 9-19 * * *",
    timeZone: "America/New_York",
    region: REGION,
    timeoutSeconds: SCHEDULE_TIMEOUT_SEC,
    memory: SCHEDULE_MEMORY,
  },
  async (event) => {
    logLine(
      `[rateChangeLogSyncTrigger] Gen2 onSchedule region=${REGION} timeoutSeconds=${SCHEDULE_TIMEOUT_SEC} scheduleTime=${event.scheduleTime || "n/a"} jobName=${event.jobName || "n/a"}`
    );

    return withTimingAsync("rateChangeLogSyncTrigger", async () => {
      logLine(
        "[rateChangeLogSyncTrigger] Scheduled (hourly :00 Eastern, 9 AM–7 PM): BQ CONTRACT_ID scan -> ch_rate_change_logs (RATE_CHANGE=YES on latest row); skip existing CONTRACT_ID+EFFECTIVE_DATE"
      );
      logLine("[rateChangeLogSyncTrigger] Invoking syncRateChangeLogsFromBigQuery");

      const result = await syncRateChangeLogsFromBigQuery({
        bq_dataset: "rr_project_data",
        bq_table: "ch_rate_change_logs",
      });

      logLine(
        `[rateChangeLogSyncTrigger] Pipeline result inserted=${result.inserted} total=${result.total} rateChangeYes=${result.rateChangeYes} errorBatches=${result.errorBatches} elapsed=${result.elapsed || "n/a"}`
      );

      return { success: true, result };
    });
  }
);

// Recruiter-reassignment / CSM-divergence audit log (inorganic_hierarchy_logs) is no longer a
// separate schedule — it runs as the last step of dealSheetSyncUpdateTrigger above, right after
// syncExistingActiveDealSheetUpdatesFromBigQuery, on the same invocation/schedule.

