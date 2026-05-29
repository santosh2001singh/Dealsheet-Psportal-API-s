const axios = require("axios");
const config = require("./config");
const { logLine } = require("./logger");
const { insertAll } = require("./bigQueryClient");

let cachedAccessToken = null;
let cachedAccessTokenExp = 0;

function normalizeDate(value) {
  const s = value == null ? "" : String(value).trim();
  return s || null;
}

function normalizeString(value) {
  const s = value == null ? "" : String(value).trim();
  return s || null;
}

function buildEmployeeName(firstName, lastName) {
  const first = normalizeString(firstName) || "";
  const last = normalizeString(lastName) || "";
  const full = `${first} ${last}`.trim();
  return full || null;
}

function mapBasicDetailToRow(detail) {
  const firstName = normalizeString(detail?.FirstName);
  const lastName = normalizeString(detail?.LastName);
  return {
    Employee_Name: buildEmployeeName(firstName, lastName),
    employee_id: normalizeString(detail?.["Employee Id"]),
    email: normalizeString(detail?.Email),
    designation: normalizeString(detail?.Designation),
    employee_status: normalizeString(detail?.["Employee Status"]),
    department: normalizeString(detail?.Department),
    l1_manager_name: normalizeString(detail?.L1ManagerName),
    l2_manager_name: normalizeString(detail?.L2ManagerName),
    manager_email: normalizeString(detail?.["Manager Email"]),
    hr_email: normalizeString(detail?.["HR Email"]),
    department_head_email: normalizeString(detail?.["Department Head Email"]),
    first_name: firstName,
    last_name: lastName,
    business_unit: normalizeString(detail?.["Business Unit"]),
    functional_manager_name: normalizeString(detail?.FunctionalManagerName),
    grade: normalizeString(detail?.Grade),
    joining_date: normalizeDate(detail?.["Joining Date"]),
    exit_date: normalizeDate(detail?.["Exit Date"]),
    contact: normalizeString(detail?.Contact),
    personal_mail_id: normalizeString(detail?.PersonalMaildID),
    cost_center: normalizeString(detail?.["Cost Center"]),
    date_of_birth: normalizeDate(detail?.["Date of Birth"]),
    location: normalizeString(detail?.Location),
    source_api: "peoplestrong_employee_details",
    synced_at: new Date().toISOString(),
  };
}

async function getPeopleStrongAccessToken() {
  const nowMs = Date.now();
  if (cachedAccessToken && cachedAccessTokenExp && nowMs < cachedAccessTokenExp - 60000) {
    logLine("[peoplestrong sync] STEP 1/4 AUTH: using cached access token");
    return cachedAccessToken;
  }

  if (!config.peoplestrong.authBasicToken) {
    throw new Error("Missing PS_AUTH_BASIC_TOKEN environment variable.");
  }

  logLine("[peoplestrong sync] STEP 1/4 AUTH: requesting new access token");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
  });

  const response = await axios.post(config.peoplestrong.authUrl, body.toString(), {
    headers: {
      Authorization: `Basic ${config.peoplestrong.authBasicToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  const token = response?.data?.access_token;
  const expiresInSecRaw = Number(response?.data?.expires_in);
  const expiresInSec = Number.isFinite(expiresInSecRaw) && expiresInSecRaw > 0 ? Math.trunc(expiresInSecRaw) : 300;
  if (!token) {
    throw new Error("PeopleStrong auth response missing access_token.");
  }
  cachedAccessToken = token;
  cachedAccessTokenExp = Date.now() + expiresInSec * 1000;
  logLine(`[peoplestrong sync] STEP 1/4 AUTH: token received expiresInSec=${expiresInSec}`);
  return token;
}

async function fetchPeopleStrongEmployeeDetails(accessToken, allowRetryOn401 = true) {
  if (!config.peoplestrong.apiKey) {
    throw new Error("Missing PS_API_KEY environment variable.");
  }

  try {
    const response = await axios.post(
      config.peoplestrong.dataUrl,
      { integrationMasterName: config.peoplestrong.integrationMasterName },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          apikey: config.peoplestrong.apiKey,
        },
      }
    );
    return response?.data || {};
  } catch (error) {
    const status = error?.response?.status;
    if (allowRetryOn401 && status === 401) {
      logLine("[peoplestrong sync] STEP 2/4 DATA API: token expired/unauthorized, re-auth and retry once");
      cachedAccessToken = null;
      cachedAccessTokenExp = 0;
      const freshToken = await getPeopleStrongAccessToken();
      return fetchPeopleStrongEmployeeDetails(freshToken, false);
    }
    throw error;
  }
}

function mapPeopleStrongEmployeeRows(payload) {
  const records = payload?.root?.EmployeeMaster?.EmployeeMasterData;
  const rootExists = Boolean(payload && typeof payload === "object" && payload.root);
  const employeeMasterExists = Boolean(payload?.root && payload.root.EmployeeMaster);
  const recordsType = Array.isArray(records) ? "array" : records == null ? "nullish" : typeof records;
  const recordsLength = Array.isArray(records) ? records.length : "n/a";
  logLine(
    `[peoplestrong sync] STEP 3/4 TRANSFORM DEBUG: payload.root.exists=${rootExists} payload.root.EmployeeMaster.exists=${employeeMasterExists} employeeMasterData.type=${recordsType} employeeMasterData.length=${recordsLength}`
  );
  if (!Array.isArray(records) || records.length === 0) return [];

  const out = [];
  for (const item of records) {
    const detail = item?.BasicDetails?.BasicDetail;
    if (!detail || typeof detail !== "object") continue;
    out.push(mapBasicDetailToRow(detail));
  }
  return out;
}

async function syncPeopleStrongEmployeeDetailsToBigQuery(params = {}) {
  const startMs = Date.now();
  const datasetId =
    typeof params.bq_dataset === "string" && params.bq_dataset.trim() !== ""
      ? params.bq_dataset.trim()
      : config.peoplestrong.employeeDatasetId;
  const tableId =
    typeof params.bq_table === "string" && params.bq_table.trim() !== ""
      ? params.bq_table.trim()
      : config.peoplestrong.employeeTableId;

  logLine(
    `[peoplestrong sync] === START === target=${config.projectId}.${datasetId}.${tableId} integrationMasterName=${config.peoplestrong.integrationMasterName}`
  );
  logLine("[peoplestrong sync] STEP 1/4 AUTH: start");
  const accessToken = await getPeopleStrongAccessToken();
  logLine("[peoplestrong sync] STEP 1/4 AUTH: done");

  logLine("[peoplestrong sync] STEP 2/4 DATA API: requesting employee details");
  const payload = await fetchPeopleStrongEmployeeDetails(accessToken);
  const apiStatusCode = payload?.responseDetails?.APIStatusCode || "n/a";
  const apiMessage = payload?.responseDetails?.Message || "n/a";
  logLine(`[peoplestrong sync] STEP 2/4 DATA API: response APIStatusCode=${apiStatusCode} message=${apiMessage}`);

  logLine("[peoplestrong sync] STEP 3/4 TRANSFORM: mapping payload to rows");
  const rows = mapPeopleStrongEmployeeRows(payload);
  const target = `${config.projectId}.${datasetId}.${tableId}`;

  logLine(`[peoplestrong sync] STEP 3/4 TRANSFORM: recordsMapped=${rows.length} target=${target}`);

  if (rows.length === 0) {
    const elapsedMs = Date.now() - startMs;
    logLine(`[peoplestrong sync] === DONE (no rows) === elapsedMs=${elapsedMs}`);
    return {
      fetched: 0,
      inserted: 0,
      targetTable: target,
      message: "No PeopleStrong employee records found in payload.",
      responseDetails: payload?.responseDetails || null,
    };
  }

  logLine(`[peoplestrong sync] STEP 4/4 BIGQUERY: inserting rows=${rows.length}`);
  const insertIdBase = Date.now();
  const insertResult = await insertAll(rows, {
    datasetId,
    tableId,
    insertIdBase,
  });
  const elapsedMs = Date.now() - startMs;
  logLine(
    `[peoplestrong sync] STEP 4/4 BIGQUERY: attempted=${insertResult.attempted || rows.length} inserted=${insertResult.inserted || 0} hasErrors=${Array.isArray(insertResult.errors) && insertResult.errors.length > 0 ? "yes" : "no"}`
  );
  logLine(`[peoplestrong sync] === DONE === fetched=${rows.length} inserted=${insertResult.inserted || 0} elapsedMs=${elapsedMs}`);

  return {
    fetched: rows.length,
    inserted: insertResult.inserted || 0,
    attempted: insertResult.attempted || rows.length,
    targetTable: target,
    elapsedMs,
    responseDetails: payload?.responseDetails || null,
    hasInsertErrors: Array.isArray(insertResult.errors) && insertResult.errors.length > 0,
  };
}

module.exports = {
  getPeopleStrongAccessToken,
  fetchPeopleStrongEmployeeDetails,
  mapPeopleStrongEmployeeRows,
  syncPeopleStrongEmployeeDetailsToBigQuery,
};
