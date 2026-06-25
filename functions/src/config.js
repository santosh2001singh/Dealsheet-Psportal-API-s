/**
 * Configuration for Deal Sheet BigQuery Sync
 * Uses environment variables set via Firebase Functions config
 */

const config = {
  projectId: process.env.GCP_PROJECT || "cynetdatabase",
  datasetId: process.env.BQ_DATASET || "rr_project_data",
  /** Default single-table target; domain-routed sync omits bq_table and ignores this for writes */
  tableId: process.env.BQ_TABLE || "cynet_health_deal_sheet",
  rateChangeLogDatasetId: process.env.BQ_RATE_CHANGE_LOG_DATASET || "rr_project_data",
  rateChangeLogTableId: process.env.BQ_RATE_CHANGE_LOG_TABLE || "ch_rate_change_logs",
  additionalCostLogDatasetId: process.env.BQ_ADDITIONAL_COST_LOG_DATASET || "rr_project_data",
  additionalCostLogTableId: process.env.BQ_ADDITIONAL_COST_LOG_TABLE || "ch_additional_cost_logs",
  terminationReasonLogDatasetId:
    process.env.BQ_TERMINATION_REASON_LOG_DATASET || "rr_project_data",
  terminationReasonLogTableId:
    process.env.BQ_TERMINATION_REASON_LOG_TABLE || "ch_termination_reason_logs",

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

  nexus: {
    baseUrl:
      process.env.NEXUS_BASE_URL ||
      "https://nexus-api-web-440611099785.us-central1.run.app",
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

  backfill: {
    /** Default pages per resume invocation (0 = no cap unless max_pages query is passed) */
    pageLimitPerRun: parseInt(process.env.BACKFILL_PAGE_LIMIT_PER_RUN || "0", 10),
    /** Firestore collection/doc for resume cursor state */
    checkpointCollection: process.env.BACKFILL_CHECKPOINT_COLLECTION || "dealSheetSyncCheckpoints",
    checkpointKey: process.env.BACKFILL_CURSOR_KEY || "active-records-default",
  },

  /** Firestore-backed monotonic CONTRACT_ID sequence (starts at 100000) */
  contractIdSequence: {
    collection: process.env.CONTRACT_ID_SEQUENCE_COLLECTION || "contractIdSequences",
    docId: process.env.CONTRACT_ID_SEQUENCE_DOC || "default",
    startValue: parseInt(process.env.CONTRACT_ID_START_VALUE || "100000", 10),
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

module.exports = config;
