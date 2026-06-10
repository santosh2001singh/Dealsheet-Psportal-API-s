/**
 * Firebase Functions for Deal Sheet BigQuery Sync (Gen2 — longer timeouts)
 *
 * 1. dealSheetSync — HTTP (v2 onRequest, up to 3600s)
 * 2. rateChangeLogSync — HTTP rate-change log (BigQuery CONTRACT_ID scan)
 * 3. dealSheetSyncTrigger — scheduled insert (new deal sheets only)
 * 4. dealSheetSyncUpdateTrigger — scheduled update (existing BQ composites)
 * 5. dealSheetSyncOfferRejected — HTTP ended / offer-rejected stream (manual)
 * 6. rateChangeLogSyncTrigger — scheduled rate-change logs (BigQuery CONTRACT_ID scan)
 * 7. bulkBackfillByPlacementId — HTTP bulk Nexus backfill (no BQ baseline checks)
 */

const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const {
  syncEnrichedDealSheetCandidatesToBigQuery,
  syncExistingActiveDealSheetUpdatesFromBigQuery,
  syncRateChangeLogsFromBigQuery,
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
/** First-insert placement allowlist for new DEAL_SHEET_ID+PLACEMENT_ID baselines on active `dealSheetSyncTrigger` (always STARTED/BOOKED) */
const ACTIVE_BOOTSTRAP_FIRST_INSERT_PLACEMENT_STATUSES = "STARTED,BOOKED";
/** First-insert allowlist for `dealSheetSyncOfferRejected` ended tables (wider than active scheduled) */
const ACTIVE_EXPANDED_FIRST_INSERT_PLACEMENT_STATUSES =
  "STARTED,BOOKED,ENDED,ENDED<30,DID NOT START,DID NOT ACCEPT";
/** Active HTTP/trigger + scheduled update: only insert rows with START_DATE on or after this day (UTC). */
const DEAL_SHEET_MIN_START_DATE_MS = Date.UTC(2026, 4, 1);

/** Nexus submittal filter for scheduled insert trigger (new deal sheets only) */
const ACTIVE_BOOTSTRAP_SUBMITTAL_CODES = "PERM_STARTS,ACTIVE,BOOKED";

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
 * Scheduled: every 4 hours at :00 Eastern (01:00, 05:00, 09:00, 13:00, 17:00, 21:00).
 * Inserts **new** deal sheets only (DEAL_SHEET_ID not yet in BigQuery), first row STARTED/BOOKED.
 * Full Nexus job-submittals scan each run (no page checkpoint). Updates to existing rows use `dealSheetSyncUpdateTrigger`.
 */
exports.dealSheetSyncTrigger = onSchedule(
  {
    schedule: "0 9-19 * * *",
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

      logLine(
        `[dealSheetSyncTrigger] Scheduled insert-only: ${organizationSubmittalCodes} -> cynetdatabase.${bqDataset}; skip if DEAL_SHEET_ID or PLACEMENT_ID exists in BQ; START_DATE>=2026-05-01; first_insert_allowlist=${firstInsertPlacementStatuses}; no append-on-change`
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
        transform_rows_fn: filterEnrichedRowsByDealSheetMinStartDate,
      });

      logLine(
        `[dealSheetSyncTrigger] Pipeline result inserted=${result.inserted} candidatesProcessed=${result.candidatesProcessed} errorBatches=${result.errorBatches} elapsed=${result.elapsed || "n/a"} pagesProcessed=${result.pagesProcessedThisRun ?? "n/a"}`
      );

      return { success: true, result };
    });
  }
);

/**
 * Scheduled: hourly :30 Eastern, 9:30 AM–7:30 PM (30 min after each insert trigger run).
 * Loads existing DEAL_SHEET_IDs from BigQuery (placement_id fallback when deal sheet null), refreshes via Nexus, appends on column diff vs latest deal-sheet row.
 */
exports.dealSheetSyncUpdateTrigger = onSchedule(
  {
    schedule: "30 9-19 * * *",
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

      return { success: true, result };
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

