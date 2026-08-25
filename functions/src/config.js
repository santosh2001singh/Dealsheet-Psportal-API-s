/**
 * Configuration for Deal Sheet BigQuery Sync
 * Uses environment variables set via Firebase Functions config
 */

const config = {
  projectId: process.env.GCP_PROJECT || "cynetdatabase",
  datasetId: process.env.BQ_DATASET || "rr_project_data",
  /** Default single-table target; domain-routed sync omits bq_table and ignores this for writes */
  tableId: process.env.BQ_TABLE || "cynet_health_deal_sheet",
  /**
   * Historical run-rate source tables used to backfill INITIAL_START_DATE/NEW_HIRE_DATE/hierarchy
   * on brand-new EXTENSION rows, one per domain (see recruiterDomainTables.resolveRunrateTableIdForDealSheetTable).
   */
  runrateTableId: process.env.RUNRATE_TABLE_ID || "all_CH_data_runrate",
  /**
   * Canada's legacy source: the run-rate table SKU_NUMBER / CONTRACT_ID / manual ops columns are
   * recovered from, the Canada twin of all_CH_data_runrate.
   *
   * History, because this moved twice: it briefly pointed at all_Health_Canada_Deal_sheet_data,
   * which held the data at the time. That table was recreated empty on 2026-08-24, so lookups
   * against it matched nothing and every synced row landed with a blank SKU and blank manual
   * columns. The populated table is all_Health_Canada_data_Runrate (620 rows, 498 with a SKU) —
   * verified to match all 86 synced deal rows on candidate + facility + parent client + date window.
   */
  runrateCanadaTableId:
    process.env.RUNRATE_CANADA_TABLE_ID || "all_Health_Canada_data_Runrate",
  runrateLocumsTableId: process.env.RUNRATE_LOCUMS_TABLE_ID || "all_locums_runrate",
  rateChangeLogDatasetId: process.env.BQ_RATE_CHANGE_LOG_DATASET || "rr_project_data",
  rateChangeLogTableId: process.env.BQ_RATE_CHANGE_LOG_TABLE || "ch_rate_change_logs",
  additionalCostLogDatasetId: process.env.BQ_ADDITIONAL_COST_LOG_DATASET || "rr_project_data",
  additionalCostLogTableId: process.env.BQ_ADDITIONAL_COST_LOG_TABLE || "ch_additional_cost_logs",
  terminationReasonLogDatasetId:
    process.env.BQ_TERMINATION_REASON_LOG_DATASET || "rr_project_data",
  terminationReasonLogTableId:
    process.env.BQ_TERMINATION_REASON_LOG_TABLE || "ch_termination_reason_logs",
  /** Audit log of recruiter-reassignment events: new recruiter's hierarchy at time of change */
  inorganicHierarchyLogDatasetId:
    process.env.BQ_INORGANIC_HIERARCHY_LOG_DATASET || "rr_project_data",
  inorganicHierarchyLogTableId:
    process.env.BQ_INORGANIC_HIERARCHY_LOG_TABLE || "inorganic_hierarchy_logs",
  /** Per-role ownership-change audit log (recruiter / onsite AM / CSM level handovers) */
  ownershipChangeLogDatasetId:
    process.env.BQ_OWNERSHIP_CHANGE_LOG_DATASET || "rr_project_data",
  ownershipChangeLogTableId:
    process.env.BQ_OWNERSHIP_CHANGE_LOG_TABLE || "ownership_change_logs",

  batchSize: parseInt(process.env.BATCH_SIZE || "300", 10),
  /** Nexus job-submittals per_page (deal-sheet sync paths); override via PER_PAGE */
  perPage: parseInt(process.env.PER_PAGE || "300", 10),
  /** Max candidates per enrich wave (controls API fan-out burst size) */
  enrichBatchSize: parseInt(process.env.ENRICH_BATCH_SIZE || "300", 10),
  /** Parallel Nexus GETs per batch; lower default to reduce 500s under load */
  fetchAllMax: parseInt(process.env.FETCH_ALL_MAX || "20", 10),
  maxRetries: parseInt(process.env.MAX_RETRIES || "3", 10),
  /** Delay between fetch chunks; slightly higher default for API stability */
  batchDelayMs: parseInt(process.env.BATCH_DELAY_MS || "100", 10),

  /**
   * Per-domain Nexus fan-out tuning, applied on top of the values above.
   *
   * Canada runs with NO start-date filter, so one run enriches its whole Nexus history — a single
   * wave fired 3222 requests on 2026-08-24 and tripped the edge (Cloud Armor) rate limit, which
   * answers with an HTML 403 page. Health and locums only fetch from 2026-01-01, so their volume
   * never reaches that point and they keep the faster defaults.
   *
   * These live in code rather than per-function env vars on purpose: setting them with
   * `gcloud --update-env-vars` truncated NEXUS_PASSWORD at its trailing "#" (shell comment), which
   * broke Canada's auth with a 401. Keeping the tuning here means every function can be deployed
   * with plain `firebase deploy`, which reads .env verbatim and handles "#" correctly.
   *
   * An explicit env var still wins — see resolveDomainTuning.
   */
  domainTuning: {
    canada: { fetchAllMax: 5, batchDelayMs: 500, maxRetries: 5 },
  },
  /**
   * Per-request Nexus timeout. Without one, axios waits forever on a hung socket: a run on Aug 19
   * 2026 processed 9 submittal pages in 28 min at a steady ~3 min/page, then sat on page 10 for 22+
   * min against ECONNRESET retries until the 30-min function timeout killed it. A dead socket must
   * fail fast so the retry (and then the individual-URL fallback) can make progress instead of the
   * whole run's budget draining into one request.
   *
   * 45s is well above a healthy Nexus response and well below the function timeout, so a request that
   * hits it is genuinely stuck rather than merely slow.
   */
  requestTimeoutMs: parseInt(process.env.NEXUS_REQUEST_TIMEOUT_MS || "45000", 10),

  nexus: {
    baseUrl:
      process.env.NEXUS_BASE_URL ||
      "https://nexusapi.cynetcorp.com",
    username: process.env.NEXUS_USERNAME || "",
    password: process.env.NEXUS_PASSWORD || "",
    csrfToken:
      process.env.NEXUS_CSRF_TOKEN ||
      "We7tSedQczm55SseMel5niQnHkVbxDm6zsBeg5GckCjdzEFPamijsjYd38sXANYk",
  },

  bigQuery: {
    ignoreUnknownValues: true,
    skipInvalidRows: true,
    insertIdField: "DEAL_SHEET_ID",
  },

  serviceAccount: {
    type: "service_account",
    project_id: process.env.BQ_SERVICE_ACCOUNT_PROJECT_ID || "cynetdatabase",
    private_key_id: process.env.BQ_SERVICE_ACCOUNT_PRIVATE_KEY_ID || "",
    private_key: (process.env.BQ_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    client_email: process.env.BQ_SERVICE_ACCOUNT_CLIENT_EMAIL || "",
    token_uri: process.env.BQ_SERVICE_ACCOUNT_TOKEN_URI || "https://oauth2.googleapis.com/token",
  },

  /** Comma-separated Nexus organization_submittal_status_code values for /api/job-submittals/ list */
  submittalStatusCodes: process.env.SUBMITTAL_STATUS_CODES || "PERM_STARTS,ACTIVE,BOOKED",

  /**
   * When false, NEW_HIRE_DATE is not frozen on update-append and DEAL NEW_HIRE_DATE diffs trigger append
   * (one-time migration: set NEW_HIRE_DATE_FREEZE_ENABLED=false in Firebase env, run update sync, re-enable).
   */
  newHireDateFreezeEnabled: process.env.NEW_HIRE_DATE_FREEZE_ENABLED !== "false",

  /**
   * When false, EXTENSION_DATE is not frozen on update-append and EXTENSION EXTENSION_DATE diffs trigger append
   * (one-time migration: set EXTENSION_DATE_FREEZE_ENABLED=false in Firebase env, run update sync, re-enable).
   */
  extensionDateFreezeEnabled: process.env.EXTENSION_DATE_FREEZE_ENABLED !== "false",

  /** Parent Firestore document for deal-sheet sync state (subcollections below) */
  firestoreWorkspace: {
    collection: process.env.FIRESTORE_WORKSPACE_COLLECTION || "workspaces",
    docId: process.env.FIRESTORE_WORKSPACE_DOC_ID || "run-rate-tool",
  },

  backfill: {
    /** Default pages per resume invocation (0 = no cap unless max_pages query is passed) */
    pageLimitPerRun: parseInt(process.env.BACKFILL_PAGE_LIMIT_PER_RUN || "0", 10),
    /** Firestore collection/doc for resume cursor state */
    checkpointCollection: process.env.BACKFILL_CHECKPOINT_COLLECTION || "dealSheetSyncCheckpoints",
    checkpointKey: process.env.BACKFILL_CURSOR_KEY || "active-records-default",
  },

  /**
   * Per-table prefixed CONTRACT_ID config (CHC/CAC/LOC + first sequence value).
   *
   * cynet health restarts at CHC23000 (Aug 2026) to leave the pre-reset CHC1000-range ids well
   * behind; canada and locums keep their original 1000 start. NOTE: startValue only applies when
   * the Firestore sequence doc does not exist yet — an existing doc's stored nextValue always wins
   * (see allocateContractIds). After a data reset, delete or reset the doc as well, otherwise the
   * old counter carries on: see sql/reset_contract_id_sequences.md.
   */
  contractIdByTable: {
    cynet_health_deal_sheet: { prefix: "CHC", startValue: 23000 },
    cynet_health_canada_deal_sheet: { prefix: "CAC", startValue: 1000 },
    cynet_locums_deal_sheet: { prefix: "LOC", startValue: 1000 },
  },

  /** Firestore collection for per-table CONTRACT_ID sequences (doc id = table id) */
  contractIdSequence: {
    collection: process.env.CONTRACT_ID_SEQUENCE_COLLECTION || "contractIdSequences",
  },

  /** Employee directory used to resolve recruiter/hierarchy emp numbers by email */
  directoryEmployees: {
    datasetId: process.env.DIRECTORY_EMPLOYEES_DATASET || "MISC",
    tableId: process.env.DIRECTORY_EMPLOYEES_TABLE || "directory_employees",
  },

  /** Employee org-chart hierarchy snapshots, keyed by employee external_id, used to backfill
   * recruiter hierarchy (TEAM_LEAD, ATL, RM, etc.) on brand-new DEAL_TYPE=DEAL rows */
  directoryEmployeeHierarchy: {
    datasetId: process.env.DIRECTORY_EMPLOYEE_HIERARCHY_DATASET || "MISC",
    tableId: process.env.DIRECTORY_EMPLOYEE_HIERARCHY_TABLE || "directory_employee_hierarchy",
  },

  /** Employee master used to check STATUS (Active/Inactive) + IMMEDIATE_MANAGER + DESIGNATION by
   * name for EXTENSION inorganic hierarchy resolution. Table name contains a space ("Ph and India")
   * so it must be backtick-quoted in SQL. */
  departmentData: {
    datasetId: process.env.DEPARTMENT_DATA_DATASET || "Department_Data",
    tableId: process.env.DEPARTMENT_DATA_TABLE || "Ph and India",
  },

  peoplestrong: {
    authUrl:
      process.env.PS_AUTH_URL ||
      "https://auth.peoplestrong.com/auth/realms/1227/protocol/openid-connect/token",
    dataUrl:
      process.env.PS_DATA_URL ||
      "https://api.peoplestrong.com/api/integration/Outbound/CynetSystemsPrivateLimited_HRIS_EmployeeData",
    authBasicToken: process.env.PS_AUTH_BASIC_TOKEN || "",
    apiKey: process.env.PS_API_KEY || "",
    integrationMasterName: process.env.PS_INTEGRATION_MASTER_NAME || "EmployeeData",
    employeeDatasetId: process.env.PS_BQ_DATASET || "Department_Data",
    employeeTableId: process.env.PS_BQ_TABLE || "PS_Portal_Employee_Details",
  },
};

/**
 * The env/default tuning values as loaded at module start, before any domain override is applied.
 * applyDomainTuning mutates config.fetchAllMax and friends, so the fallbacks have to come from an
 * immutable snapshot or one domain's run would poison the next resolve() in the same process.
 */
const TUNING_BASELINE = Object.freeze({
  fetchAllMax: config.fetchAllMax,
  batchDelayMs: config.batchDelayMs,
  maxRetries: config.maxRetries,
});

/**
 * Nexus fan-out tuning for one sync domain.
 *
 * ONLY the request-pacing knobs vary by domain — how many Nexus GETs run in parallel, the gap
 * between batches, and how many times a transient failure is retried. Credentials (NEXUS_USERNAME /
 * NEXUS_PASSWORD / NEXUS_BASE_URL / NEXUS_CSRF_TOKEN) are the SAME for every domain and are never
 * touched here: all three pull from the same Nexus account.
 *
 * Precedence: an explicit env var always wins, then the per-domain entry, then the global default.
 * That keeps a one-off override possible without editing code.
 *
 * @param {string} [domain] - "health" | "canada" | "locums"
 * @returns {{fetchAllMax: number, batchDelayMs: number, maxRetries: number}}
 */
function resolveDomainTuning(domain) {
  const key = domain == null ? "" : String(domain).trim().toLowerCase();
  const perDomain = config.domainTuning[key] || {};
  const fromEnv = (name) => {
    const raw = process.env[name];
    if (raw == null || String(raw).trim() === "") return null;
    const n = parseInt(String(raw).trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  // Fall back to the BASELINE, never to config.* — applyDomainTuning mutates those, so reading them
  // here would let one domain's values leak into the next resolve() in the same process.
  return {
    fetchAllMax: fromEnv("FETCH_ALL_MAX") ?? perDomain.fetchAllMax ?? TUNING_BASELINE.fetchAllMax,
    batchDelayMs:
      fromEnv("BATCH_DELAY_MS") ?? perDomain.batchDelayMs ?? TUNING_BASELINE.batchDelayMs,
    maxRetries: fromEnv("MAX_RETRIES") ?? perDomain.maxRetries ?? TUNING_BASELINE.maxRetries,
  };
}

/**
 * Apply a domain's fan-out tuning to the live config, for the rest of this process.
 *
 * Each scheduled function runs exactly ONE domain (dealSheetSyncTriggerCanada only ever syncs
 * canada), so mutating the shared config at the start of a run is safe and keeps every downstream
 * batching site — nexusFetchAllJsonBatched, the enricher's note batches, the retry wrapper — on the
 * right values without threading a parameter through every call.
 *
 * Idempotent and logged, so a run's actual pacing is visible in the logs.
 *
 * @param {string} [domain]
 * @returns {{fetchAllMax: number, batchDelayMs: number, maxRetries: number}} the applied values
 */
function applyDomainTuning(domain) {
  const t = resolveDomainTuning(domain);
  config.fetchAllMax = t.fetchAllMax;
  config.batchDelayMs = t.batchDelayMs;
  config.maxRetries = t.maxRetries;
  return t;
}

module.exports = config;
module.exports.resolveDomainTuning = resolveDomainTuning;
module.exports.applyDomainTuning = applyDomainTuning;
