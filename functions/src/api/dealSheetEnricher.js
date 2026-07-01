/**
 * Deal Sheet Enricher
 * Parallel API fetching and data enrichment for deal sheet candidates
 */

const config = require("../config");
const { logLine } = require("../logger");
const {
  buildUrl,
  nexusFetchAllJsonBatched,
  getNexusAccessToken,
  nexusGetJson,
  nexusGetJsonWithRetry,
  normalizePagedResponse,
  firstPagedItemOrNull,
  normalizeNexusResourceId,
} = require("../nexusClient");
const {
  mapDealSheetCandidateToBq,
  mapClientToBq,
  mapDealSheetDetailToBq,
  mapDealSheetHoursDetailsToBq,
  mapDealSheetRevenueDetailsToBq,
  mapDealSheetAdditionalCostsToBq,
  mapAdditionalCostLogRowsForDealSheet,
  isTerminationApiEligiblePlacementStatus,
  extractTerminationReasonValue,
  pickLatestTerminationDetailItem,
  mapTerminationReasonLogRowForDealSheet,
  mapTravelAllowanceToAdditionalBonus,
  mapTravelAllowanceLogRowsForDealSheet,
  mapDealSheetClientCostsToAdditionalBonus,
  mapClientCostLogRowsForDealSheet,
  mapDealSheetRateChangeToBq,
  mapJobToBq,
  mapMspFromClientOfferingRow,
  mapDealSheetRatesListToBq,
  mapJobProfessionSpecialtyFromJob,
  mapJobSubmittalToBq,
  mapDealSheetUsersToBq,
  mapCandidateToBq,
  mapCandidateCandidateTypesToBq,
  clientOfferingHasClientTypeText,
  resolveClientOfferingForEnrich,
  pickClientOfferingRowForJob,
  computeDerivedPlacementFields,
  coerceApiFloatNullsToZero,
  mapCanadaTypeFromTenNintyNine,
  resolveNewHireDateFromSubmittalNotes,
  resolveNewHireDateForDealRow,
  resolveTentativeDateForPlacementRow,
} = require("../columnMappings");
const { computeBonusTotals } = require("../bonusTotals");
const { computeWeekSplit } = require("../weekSplit");
const { computeNewRateFamily } = require("../w2PayRateNew");
const { sanitizeCanadaDealSheetRow, isCynetHealthCanadaRecruiter, pickCanadaDealSheetHoursPart } = require("../canadaDerivedPlacementFields");
const { shouldExcludeRowFromBigQuery } = require("../bqRowExclusions");
const { resolveContractIdsForRows } = require("../contractIdResolver");
const { allocateContractIds } = require("../contractIdSequence");
const { resolveActiveDealSheetTableId } = require("../recruiterDomainTables");
const {
  fetchContractIdsByDealSheetIds,
  fetchContractIdsForExtensions,
} = require("../bigQueryClient");

/**
 * Extract items from paged response
 */
function extractItems(page) {
  const { items } = normalizePagedResponse(page);
  return Array.isArray(items) ? items : [];
}

function resolveSubmittalRowForCandidate(c, ctx) {
  const jobId = normalizeNexusResourceId(c?.job);
  const candId = normalizeNexusResourceId(c?.candidate);
  const dealSheetId = normalizeNexusResourceId(c?.deal_sheet);
  let submittalRow = ctx.hasPreloadedSubmittals
    ? getPreloadedSubmittalRow(ctx.preloadedSubmittals, jobId, candId)
    : null;
  if (!submittalRow && !ctx.hasPreloadedSubmittals && dealSheetId) {
    const detail = ctx.dealSheetById.get(String(dealSheetId));
    const recruiterIdForSub = detail?.recruiter;
    const subKey =
      jobId != null && recruiterIdForSub != null && candId != null
        ? `${jobId}:${recruiterIdForSub}:${candId}`
        : null;
    submittalRow = subKey ? ctx.submittalByKey.get(subKey) ?? null : null;
  }
  return submittalRow;
}

async function fetchAllJobSubmittalNotesForPlacement(placementId, accessToken) {
  const items = [];
  let requestUrl = buildUrl(`${config.nexus.baseUrl}/api/job-submittal-notes/`, {
    job_submittal_id: placementId,
  });
  while (requestUrl) {
    const page = await nexusGetJsonWithRetry(requestUrl, accessToken);
    const normalized = normalizePagedResponse(page);
    if (normalized.items?.length) items.push(...normalized.items);
    requestUrl = normalized.next || null;
  }
  return items;
}

/**
 * Extract submittal status raw value
 */
function extractSubmittalStatusRaw(submittalRow) {
  if (!submittalRow || typeof submittalRow !== "object") return null;
  const raw =
    submittalRow.organization_submittal_status?.submittal_status ??
    submittalRow.submittal_status ??
    null;
  return raw == null ? null : String(raw).trim() || null;
}

/** Normalize status strings to match config CSV (e.g. PERM_STARTS → perm starts) */
function normalizeSubmittalStatusKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, " ");
}

function normalizedSubmittalCodesAllowed() {
  return (config.submittalStatusCodes || "")
    .split(",")
    .map((x) => normalizeSubmittalStatusKey(x))
    .filter(Boolean);
}

/**
 * Check if submittal status is in the configured list (same CSV as job-submittals list query)
 */
function isAllowedSubmittalStatus(submittalRow) {
  const s = extractSubmittalStatusRaw(submittalRow);
  if (!s) return false;
  const key = normalizeSubmittalStatusKey(s);
  const allowed = new Set(normalizedSubmittalCodesAllowed());
  return allowed.has(key);
}

/**
 * Unique deal_sheet / job / candidate / client ids from candidate rows
 */
function collectEntityIds(cands) {
  const dsIds = [];
  const dsSet = new Set();
  const jobIds = [];
  const jobSet = new Set();
  const candIds = [];
  const candSet = new Set();
  const clientIds = [];
  const clientSet = new Set();

  for (const c of cands || []) {
    const ds = normalizeNexusResourceId(c?.deal_sheet);
    if (ds && !dsSet.has(ds)) {
      dsSet.add(ds);
      dsIds.push(ds);
    }
    const j = normalizeNexusResourceId(c?.job);
    if (j && !jobSet.has(j)) {
      jobSet.add(j);
      jobIds.push(j);
    }
    const cand = normalizeNexusResourceId(c?.candidate);
    if (cand && !candSet.has(cand)) {
      candSet.add(cand);
      candIds.push(cand);
    }
    const cl = normalizeNexusResourceId(c?.client);
    if (cl && !clientSet.has(cl)) {
      clientSet.add(cl);
      clientIds.push(cl);
    }
  }

  return { dsIds, jobIds, candIds, clientIds };
}

/**
 * Build preloaded submittal key and fetch row
 */
function getPreloadedSubmittalRow(preloadedSubmittals, jobId, candidateId) {
  if (!preloadedSubmittals) return null;
  const j = normalizeNexusResourceId(jobId);
  const cand = normalizeNexusResourceId(candidateId);
  if (!j || !cand) return null;
  return preloadedSubmittals.get(`${j}:${cand}`) ?? null;
}

/**
 * Embedded client has fields required by mapClientToBq (geo + name).
 */
function isEmbeddedClientGeoSufficient(clientObj) {
  if (!clientObj || typeof clientObj !== "object") return false;
  const hasId = clientObj.id != null && String(clientObj.id).trim() !== "";
  const hasName = clientObj.name != null && String(clientObj.name).trim() !== "";
  const zd = clientObj.zipcode_data;
  const hasGeo =
    zd &&
    typeof zd === "object" &&
    (
      (zd.state_code != null && String(zd.state_code).trim() !== "") ||
      (zd.zipcode != null && String(zd.zipcode).trim() !== "") ||
      (zd.city != null && String(zd.city).trim() !== "")
    );
  return hasId && hasName && hasGeo;
}

function isEmbeddedClientOfferingMspSufficient(clientObj) {
  const offerings = clientObj?.client_offerings;
  if (!Array.isArray(offerings) || offerings.length === 0) return false;
  return offerings.some((o) => o?.msp != null && typeof o.msp === "object");
}

function embeddedClientOfferingsSkippable(clientObj, jobObj) {
  if (!isEmbeddedClientOfferingMspSufficient(clientObj)) return false;
  const offerings = clientObj.client_offerings;
  if (!jobObj) {
    return offerings.every((o) => clientOfferingHasClientTypeText(o));
  }
  const picked = pickClientOfferingRowForJob(offerings, jobObj);
  return picked != null && clientOfferingHasClientTypeText(picked);
}

/** @deprecated use isEmbeddedClientGeoSufficient */
function isEmbeddedClientSufficient(clientObj) {
  return isEmbeddedClientGeoSufficient(clientObj);
}

function registerEmbeddedClientSkips(sub, candidateClientId, jobObj, skipDetail, skipOfferings) {
  const embeddedClient = sub?.client;
  const cid = normalizeNexusResourceId(candidateClientId);
  const embeddedId =
    embeddedClient?.id == null || String(embeddedClient.id).trim() === ""
      ? null
      : String(embeddedClient.id).trim();
  if (!cid || !embeddedId || cid !== embeddedId) return;
  if (isEmbeddedClientGeoSufficient(embeddedClient)) {
    skipDetail.add(cid);
  }
  if (embeddedClientOfferingsSkippable(embeddedClient, jobObj)) {
    skipOfferings.add(cid);
  }
}

/**
 * Nexus may return parent_client as a scalar id or a nested object { id, name, ... }.
 * String(object) becomes "[object Object]" and breaks /api/clients/{id}/ URLs.
 * @returns {string|null} numeric id string for map keys and HTTP paths
 */
function normalizeParentClientIdRef(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "object") {
    const id = raw.id;
    if (id == null || String(id).trim() === "") return null;
    return String(id).trim();
  }
  const s = String(raw).trim();
  if (!s || s === "[object Object]") return null;
  return s;
}

/**
 * Parent display name when embedded on client or submittal payload (skip extra GET when present).
 */
function parentClientNameFromEmbedded(clientObj) {
  const p = clientObj?.parent_client;
  if (!p || typeof p !== "object") return null;
  if (p.name == null) return null;
  const n = String(p.name).trim();
  return n || null;
}

const DEAL_SHEET_WAVE1_API_KINDS = ["ds", "hrs", "rev", "rates", "addcost", "travel", "clientcost", "ratechg"];

/** Track Nexus API failures per resource kind (used for per-candidate fail-fast). */
function createFailedIdsByKind() {
  return {
    ds: new Set(),
    hrs: new Set(),
    rev: new Set(),
    rates: new Set(),
    addcost: new Set(),
    travel: new Set(),
    clientcost: new Set(),
    ratechg: new Set(),
    job: new Set(),
    cand: new Set(),
    candtype: new Set(),
    client: new Set(),
    clioff: new Set(),
    user: new Set(),
    par: new Set(),
  };
}

/**
 * Returns list of failed API keys for a candidate (empty = safe to enrich).
 * @returns {string[]}
 */
function collectCandidateApiFailureKinds({
  dealSheetId,
  jobId,
  candId,
  clientId,
  skipClientDetailFetchIds,
  skipClientOfferingsFetchIds,
  failedIdsByKind,
  failedSubmittalKeys,
  dealSheetById,
  clientById,
  hasPreloadedSubmittals,
}) {
  const dsKey = String(dealSheetId);
  const jobKey = jobId == null ? "" : String(jobId);
  const candKey = candId == null ? "" : String(candId);
  const clientKey = clientId == null ? "" : String(clientId);

  const failedKinds = [];
  for (const k of DEAL_SHEET_WAVE1_API_KINDS) {
    if (failedIdsByKind[k].has(dsKey)) failedKinds.push(`${k}:${dsKey}`);
  }
  if (jobKey && failedIdsByKind.job.has(jobKey)) failedKinds.push(`job:${jobKey}`);
  if (candKey) {
    if (failedIdsByKind.cand.has(candKey)) failedKinds.push(`cand:${candKey}`);
    if (failedIdsByKind.candtype.has(candKey)) failedKinds.push(`candtype:${candKey}`);
  }
  if (clientKey) {
    if (
      !skipClientDetailFetchIds.has(clientKey)
      && failedIdsByKind.client.has(clientKey)
    ) {
      failedKinds.push(`client:${clientKey}`);
    }
    if (
      !skipClientOfferingsFetchIds.has(clientKey)
      && failedIdsByKind.clioff.has(clientKey)
    ) {
      failedKinds.push(`clioff:${clientKey}`);
    }
    if (!skipClientDetailFetchIds.has(clientKey)) {
      const clientObjEarly = clientById.get(clientKey);
      if (clientObjEarly) {
        const parentKeyEarly = normalizeParentClientIdRef(clientObjEarly?.parent_client);
        if (parentKeyEarly && failedIdsByKind.par.has(parentKeyEarly)) {
          failedKinds.push(`par:${parentKeyEarly}`);
        }
      }
    }
  }
  const detailEarly = dealSheetById.get(dsKey);
  if (detailEarly) {
    const rid = detailEarly.recruiter == null ? "" : String(detailEarly.recruiter);
    const sid = detailEarly.sales_rep == null ? "" : String(detailEarly.sales_rep);
    if (rid && failedIdsByKind.user.has(rid)) failedKinds.push(`user:${rid}`);
    if (sid && sid !== rid && failedIdsByKind.user.has(sid)) failedKinds.push(`user:${sid}`);
  }
  if (!hasPreloadedSubmittals && jobKey && candKey && detailEarly) {
    const rid = detailEarly.recruiter == null ? "" : String(detailEarly.recruiter);
    if (rid) {
      const subKey = `${jobKey}:${rid}:${candKey}`;
      if (failedSubmittalKeys.has(subKey)) failedKinds.push(`sub:${subKey}`);
    }
  }
  return failedKinds;
}

/**
 * Build enriched rows from deal sheet candidates
 * Fetches all related data in parallel waves and merges into BigQuery rows
 */
async function buildEnrichedRowsFromDealSheetCandidates(candidates, preloadedSubmittals = null, options = {}) {
  const combined = [];
  const additionalCostLogRows = [];
  const terminationLogRows = [];
  let excludedDummyOrTraining = 0;
  if (!candidates || candidates.length === 0) {
    return { rows: combined, additionalCostLogRows, terminationLogRows };
  }

  const fetchTerminationDetails = options?.fetchTerminationDetails === true;

  const allowedSubmittalCodesCsv =
    options && String(options.allowedSubmittalCodes || "").trim()
      ? String(options.allowedSubmittalCodes).trim()
      : config.submittalStatusCodes;
  const persistDealSheetStatusFromCandidate = options?.persistDealSheetStatusFromCandidate === true;

  const allowedSubmittalStatusKeys = new Set(
    (allowedSubmittalCodesCsv || "")
      .split(",")
      .map((x) => normalizeSubmittalStatusKey(x))
      .filter(Boolean)
  );
  const hasPreloadedSubmittals = preloadedSubmittals && preloadedSubmittals.size > 0;

  const skipClientDetailFetchIds = new Set();
  const skipClientOfferingsFetchIds = new Set();
  if (hasPreloadedSubmittals) {
    for (const c of candidates) {
      const sub = getPreloadedSubmittalRow(preloadedSubmittals, c?.job, c?.candidate);
      registerEmbeddedClientSkips(
        sub,
        c?.client,
        null,
        skipClientDetailFetchIds,
        skipClientOfferingsFetchIds
      );
    }
  }

  function pickAllowedSubmittalFromRun(page, candidateId) {
    const { items } = normalizePagedResponse(page);
    if (!items || !items.length) return null;
    const cid = candidateId == null ? "" : String(candidateId);
    for (const row of items) {
      if (cid && String(row?.candidate ?? "") !== cid) continue;
      const s = extractSubmittalStatusRaw(row);
      if (!s) continue;
      const key = normalizeSubmittalStatusKey(s);
      if (allowedSubmittalStatusKeys.has(key)) return row;
    }
    return null;
  }

  const accessToken = await getNexusAccessToken();

  const { dsIds, jobIds, candIds, clientIds } = collectEntityIds(candidates);

  logLine(
    `[enriched sync] STEP 3/4 ENRICH APIS: unique ids deal_sheets=${dsIds.length} jobs=${jobIds.length} candidates=${candIds.length} clients=${clientIds.length}`
  );

  const failedIdsByKind = createFailedIdsByKind();
  const failedSubmittalKeys = new Set();
  let skippedDueToApiFailure = 0;

  const wave1Urls = [];
  const wave1Ops = [];

  for (const id of dsIds) {
    wave1Urls.push(`${config.nexus.baseUrl}/api/deal-sheets/${encodeURIComponent(id)}/`);
    wave1Ops.push({ k: "ds", id });
    wave1Urls.push(buildUrl(`${config.nexus.baseUrl}/api/deal-sheet-hours-details/`, { deal_sheet_id: id }));
    wave1Ops.push({ k: "hrs", id });
    wave1Urls.push(buildUrl(`${config.nexus.baseUrl}/api/deal-sheet-revenue-details/`, { deal_sheet_id: id }));
    wave1Ops.push({ k: "rev", id });
    wave1Urls.push(buildUrl(`${config.nexus.baseUrl}/api/deal-sheet-rates/`, { deal_sheet_id: id }));
    wave1Ops.push({ k: "rates", id });
    wave1Urls.push(buildUrl(`${config.nexus.baseUrl}/api/deal-sheet-additional-costs/`, { deal_sheet_id: id }));
    wave1Ops.push({ k: "addcost", id });
    wave1Urls.push(buildUrl(`${config.nexus.baseUrl}/api/deal-sheet-travel-allowances/`, { deal_sheet_id: id }));
    wave1Ops.push({ k: "travel", id });
    wave1Urls.push(buildUrl(`${config.nexus.baseUrl}/api/deal-sheet-client-costs/`, { deal_sheet_id: id }));
    wave1Ops.push({ k: "clientcost", id });
    wave1Urls.push(buildUrl(`${config.nexus.baseUrl}/api/deal-sheet-rate-changes/`, { deal_sheet_id: id }));
    wave1Ops.push({ k: "ratechg", id });
  }

  for (const id of jobIds) {
    wave1Urls.push(`${config.nexus.baseUrl}/api/jobs/${encodeURIComponent(id)}/`);
    wave1Ops.push({ k: "job", id });
  }

  for (const id of candIds) {
    wave1Urls.push(`${config.nexus.baseUrl}/api/candidates/${encodeURIComponent(id)}/`);
    wave1Ops.push({ k: "cand", id });
    wave1Urls.push(buildUrl(`${config.nexus.baseUrl}/api/candidate-candidate-types/`, { candidate_id: id }));
    wave1Ops.push({ k: "candtype", id });
  }

  for (const id of clientIds) {
    const clientKey = String(id);
    const skipDetail = skipClientDetailFetchIds.has(clientKey);
    const skipOfferings = skipClientOfferingsFetchIds.has(clientKey);
    if (skipDetail && skipOfferings) continue;
    if (!skipDetail) {
      wave1Urls.push(`${config.nexus.baseUrl}/api/clients/${encodeURIComponent(id)}/`);
      wave1Ops.push({ k: "client", id });
    }
    if (!skipOfferings) {
      wave1Urls.push(buildUrl(`${config.nexus.baseUrl}/api/client-offerings/`, { client_id: id }));
      wave1Ops.push({ k: "clioff", id });
    }
  }

  logLine(
    `[enriched sync] STEP 3/4 ENRICH APIS wave1: GET deal-sheets, hours, revenue, rates, additionalCosts, travelAllowances, clientCosts, rateChanges, jobs, candidates, candidateTypes, clients, clientOfferings totalRequests=${wave1Urls.length} clientsDetailSkipped=${skipClientDetailFetchIds.size} clientOfferingsSkipped=${skipClientOfferingsFetchIds.size}`
  );

  const wave1Start = Date.now();
  let wave1Responses;
  try {
    wave1Responses = await nexusFetchAllJsonBatched(wave1Urls, accessToken);
  } catch (err) {
    logLine(`[enriched sync] WARN: wave1 batch threw error, attempting individual fallback: ${String(err.message || err).slice(0, 200)}`);
    wave1Responses = [];
    let wave1Failed = 0;
    for (let i = 0; i < wave1Urls.length; i++) {
      try {
        const resp = await nexusGetJson(wave1Urls[i], accessToken);
        wave1Responses.push(resp);
      } catch (e) {
        const op = wave1Ops[i];
        if (failedIdsByKind[op.k]) failedIdsByKind[op.k].add(String(op.id));
        logLine(`[enriched sync] SKIP wave1 ${op.k} id=${op.id} due to error: ${String(e.message || e).slice(0, 100)}`);
        wave1Responses.push({});
        wave1Failed++;
      }
    }
    if (wave1Failed > 0) {
      logLine(`[enriched sync] wave1 fallback: skipped=${wave1Failed} successful=${wave1Urls.length - wave1Failed}`);
    }
  }
  const wave1Ms = Date.now() - wave1Start;
  logLine(`[enriched sync] STEP 3/4 ENRICH APIS wave1: responses=${wave1Responses.length} httpMs=${wave1Ms}`);

  const dealSheetById = new Map();
  const hoursByDs = new Map();
  const revByDs = new Map();
  const ratesByDs = new Map();
  const additionalCostsByDs = new Map();
  const travelAllowancesByDs = new Map();
  const clientCostsByDs = new Map();
  const rateChangesByDs = new Map();
  const jobById = new Map();
  const candidateById = new Map();
  const candidateTypesByCand = new Map();
  const clientById = new Map();
  const clientOfferingsByClient = new Map();

  for (let i = 0; i < wave1Ops.length; i++) {
    const op = wave1Ops[i];
    const json = wave1Responses[i];
    if (op.k === "ds") dealSheetById.set(op.id, json);
    else if (op.k === "hrs") hoursByDs.set(op.id, firstPagedItemOrNull(json));
    else if (op.k === "rev") revByDs.set(op.id, firstPagedItemOrNull(json));
    else if (op.k === "rates") ratesByDs.set(op.id, extractItems(json));
    else if (op.k === "addcost") additionalCostsByDs.set(op.id, extractItems(json));
    else if (op.k === "travel") travelAllowancesByDs.set(op.id, extractItems(json));
    else if (op.k === "clientcost") clientCostsByDs.set(op.id, extractItems(json));
    else if (op.k === "ratechg") rateChangesByDs.set(op.id, extractItems(json));
    else if (op.k === "job") jobById.set(op.id, json);
    else if (op.k === "cand") candidateById.set(op.id, json);
    else if (op.k === "candtype") candidateTypesByCand.set(op.id, extractItems(json));
    else if (op.k === "client") clientById.set(op.id, json);
    else if (op.k === "clioff") clientOfferingsByClient.set(op.id, extractItems(json));
  }

  const { dsIds: dsIdsEl, clientIds: clientIdsEl } = collectEntityIds(candidates);

  const parentClientById = new Map();
  clientById.forEach((obj, id) => parentClientById.set(id, obj));

  const parentIdsToFetch = [];
  const parentFetchSeen = new Set();
  for (const cid of clientIdsEl) {
    const obj = clientById.get(String(cid));
    if (!obj) continue;
    const ps = normalizeParentClientIdRef(obj?.parent_client);
    if (!ps) continue;
    if (parentClientNameFromEmbedded(obj)) continue;
    if (parentClientById.has(ps) || parentFetchSeen.has(ps)) continue;
    parentFetchSeen.add(ps);
    parentIdsToFetch.push(ps);
  }
  if (hasPreloadedSubmittals) {
    for (const c of candidates) {
      const sub = getPreloadedSubmittalRow(preloadedSubmittals, c?.job, c?.candidate);
      const embeddedClient = sub?.client;
      if (!isEmbeddedClientGeoSufficient(embeddedClient)) continue;
      const ps = normalizeParentClientIdRef(embeddedClient?.parent_client);
      if (!ps) continue;
      if (parentClientNameFromEmbedded(embeddedClient)) continue;
      if (parentClientById.has(ps) || parentFetchSeen.has(ps)) continue;
      parentFetchSeen.add(ps);
      parentIdsToFetch.push(ps);
    }
  }

  const userIds = [];
  const userSet = new Set();
  for (const id of dsIdsEl) {
    const detail = dealSheetById.get(id);
    if (!detail) continue;
    const r = detail?.recruiter;
    const s = detail?.sales_rep;
    if (r != null && String(r).trim() !== "" && !userSet.has(String(r))) {
      userSet.add(String(r));
      userIds.push(String(r));
    }
    if (s != null && String(s).trim() !== "" && !userSet.has(String(s))) {
      userSet.add(String(s));
      userIds.push(String(s));
    }
  }
  if (hasPreloadedSubmittals) {
    for (const c of candidates) {
      const sub = getPreloadedSubmittalRow(preloadedSubmittals, c?.job, c?.candidate);
      const salesRepId = sub?.sales_rep;
      if (salesRepId != null && String(salesRepId).trim() !== "" && !userSet.has(String(salesRepId))) {
        userSet.add(String(salesRepId));
        userIds.push(String(salesRepId));
      }
    }
  }

  logLine(`[enriched sync] STEP 3/4 ENRICH APIS wave2: users=${userIds.length} parentClients=${parentIdsToFetch.length}`);

  const submittalOps = [];
  const submittalSeen = new Set();

  if (!hasPreloadedSubmittals) {
    for (const c of candidates) {
      const dsId = normalizeNexusResourceId(c?.deal_sheet);
      const jobId = normalizeNexusResourceId(c?.job);
      if (dsId == null || dsId === "") continue;
      const detail = dealSheetById.get(String(dsId));
      if (!detail) continue;
      const recruiterId = detail?.recruiter;
      if (jobId == null || jobId === "") continue;
      if (recruiterId == null || String(recruiterId).trim() === "") continue;
      const candId = normalizeNexusResourceId(c?.candidate);
      if (candId == null || candId === "") continue;
      const key = `${jobId}:${recruiterId}:${candId}`;
      if (submittalSeen.has(key)) continue;
      submittalSeen.add(key);
      submittalOps.push({ jobId: String(jobId), recruiterId: String(recruiterId), candId: String(candId) });
    }
  }

  if (hasPreloadedSubmittals) {
    logLine(`[enriched sync] STEP 3/4 ENRICH APIS submittals: SKIP (using ${preloadedSubmittals.size} preloaded from step 2)`);
  } else {
    logLine(
      `[enriched sync] STEP 3/4 ENRICH APIS submittals: GET /api/job-submittals?job_id&recruiter_id&candidate_id uniqueCalls=${submittalOps.length} allowedStatuses=${allowedSubmittalCodesCsv}`
    );
  }

  const wave2Urls = [];
  const wave2Ops = [];

  for (const uid of userIds) {
    wave2Urls.push(`${config.nexus.baseUrl}/api/users/${encodeURIComponent(uid)}/`);
    wave2Ops.push({ k: "user", id: uid });
  }

  for (const pid of parentIdsToFetch) {
    wave2Urls.push(`${config.nexus.baseUrl}/api/clients/${encodeURIComponent(pid)}/`);
    wave2Ops.push({ k: "par", id: pid });
  }

  if (!hasPreloadedSubmittals) {
    for (const op of submittalOps) {
      wave2Urls.push(
        buildUrl(`${config.nexus.baseUrl}/api/job-submittals/`, {
          job_id: op.jobId,
          recruiter_id: op.recruiterId,
          candidate_id: op.candId,
        })
      );
      wave2Ops.push({ k: "sub", jobId: op.jobId, recruiterId: op.recruiterId, candId: op.candId });
    }
  }

  const wave2Start = Date.now();
  let wave2Responses;
  try {
    wave2Responses = await nexusFetchAllJsonBatched(wave2Urls, accessToken);
  } catch (err) {
    logLine(`[enriched sync] WARN: wave2 batch threw error, attempting individual fallback: ${String(err.message || err).slice(0, 200)}`);
    wave2Responses = [];
    let wave2Failed = 0;
    for (let i = 0; i < wave2Urls.length; i++) {
      try {
        const resp = await nexusGetJson(wave2Urls[i], accessToken);
        wave2Responses.push(resp);
      } catch (e) {
        const op = wave2Ops[i];
        if (op.k === "sub") {
          failedSubmittalKeys.add(`${op.jobId}:${op.recruiterId}:${op.candId}`);
        } else if (failedIdsByKind[op.k]) {
          failedIdsByKind[op.k].add(String(op.id));
        }
        logLine(`[enriched sync] SKIP wave2 ${op.k} id=${op.id || op.jobId} due to error: ${String(e.message || e).slice(0, 100)}`);
        wave2Responses.push({});
        wave2Failed++;
      }
    }
    if (wave2Failed > 0) {
      logLine(`[enriched sync] wave2 fallback: skipped=${wave2Failed} successful=${wave2Urls.length - wave2Failed}`);
    }
  }
  const wave2Ms = Date.now() - wave2Start;
  logLine(
    `[enriched sync] STEP 3/4 ENRICH APIS wave2: requests=${wave2Urls.length} responses=${wave2Responses.length} httpMs=${wave2Ms} (users=${userIds.length} parentClients=${parentIdsToFetch.length}${hasPreloadedSubmittals ? "" : ` submittals=${submittalOps.length}`})`
  );

  const userById = new Map();
  const submittalByKey = new Map();

  for (let i = 0; i < wave2Ops.length; i++) {
    const op = wave2Ops[i];
    const json = wave2Responses[i];
    if (op.k === "user") userById.set(op.id, json);
    else if (op.k === "par") parentClientById.set(op.id, json);
    else submittalByKey.set(`${op.jobId}:${op.recruiterId}:${op.candId}`, pickAllowedSubmittalFromRun(json, op.candId));
  }

  /** @type {Map<string, object[]>} */
  const terminationByPlacementId = new Map();

  const submittalCtx = {
    hasPreloadedSubmittals,
    preloadedSubmittals,
    dealSheetById,
    submittalByKey,
  };

  /** @type {Map<string, object[]>} */
  const notesByPlacementId = new Map();
  const notesPlacementIds = new Set();
  for (const c of candidates) {
    const submittalRow = resolveSubmittalRowForCandidate(c, submittalCtx);
    const jobId = normalizeNexusResourceId(c?.job);
    const jobObj = jobId == null || String(jobId).trim() === "" ? null : jobById.get(String(jobId)) ?? null;
    const submittalPart = mapJobSubmittalToBq(submittalRow, jobObj);
    const placementId = submittalPart?.PLACEMENT_ID;
    if (placementId != null) notesPlacementIds.add(String(placementId));
  }

  const notesPlacementIdList = [...notesPlacementIds];
  if (notesPlacementIdList.length > 0) {
    logLine(
      `[enriched sync] STEP 3/4 ENRICH APIS submittal-notes: uniqueCalls=${notesPlacementIdList.length}`
    );
    const notesStart = Date.now();
    const maxPerBatch = config.fetchAllMax;
    let notesWithData = 0;
    let notesFailed = 0;
    for (let i = 0; i < notesPlacementIdList.length; i += maxPerBatch) {
      const batch = notesPlacementIdList.slice(i, i + maxPerBatch);
      const results = await Promise.all(
        batch.map(async (pid) => {
          try {
            const items = await fetchAllJobSubmittalNotesForPlacement(pid, accessToken);
            return { pid, items, error: null };
          } catch (e) {
            return { pid, items: [], error: e };
          }
        })
      );
      for (const { pid, items, error } of results) {
        if (error) {
          notesFailed++;
          logLine(
            `[enriched sync] WARN submittal-notes placement=${pid} failed: ${String(error.message || error).slice(0, 100)}`
          );
          continue;
        }
        if (items.length > 0) {
          notesByPlacementId.set(pid, items);
          notesWithData++;
        }
      }
    }
    logLine(
      `[enriched sync] STEP 3/4 ENRICH APIS submittal-notes: responses=${notesPlacementIdList.length} withData=${notesWithData} failed=${notesFailed} httpMs=${Date.now() - notesStart}`
    );
  }

  if (fetchTerminationDetails) {
    const eligiblePlacementIds = new Set();
    for (const c of candidates) {
      const submittalRow = resolveSubmittalRowForCandidate(c, submittalCtx);
      const jobId = normalizeNexusResourceId(c?.job);
      const jobObj = jobId == null || String(jobId).trim() === "" ? null : jobById.get(String(jobId)) ?? null;
      const submittalPart = mapJobSubmittalToBq(submittalRow, jobObj);
      const placementId = submittalPart?.PLACEMENT_ID;
      if (placementId == null) continue;
      if (!isTerminationApiEligiblePlacementStatus(submittalPart?.PLACEMENT_STATUS)) continue;
      eligiblePlacementIds.add(String(placementId));
    }

    const wave3Urls = [];
    const wave3PlacementIds = [];
    for (const pid of eligiblePlacementIds) {
      wave3Urls.push(
        buildUrl(`${config.nexus.baseUrl}/api/job-submittal-cancellation-termination-details/`, {
          job_submittal_id: pid,
        })
      );
      wave3PlacementIds.push(pid);
    }

    if (wave3Urls.length > 0) {
      logLine(
        `[enriched sync] STEP 3/4 ENRICH APIS wave3: termination-details uniqueCalls=${wave3Urls.length}`
      );
      const wave3Start = Date.now();
      let wave3Responses;
      try {
        wave3Responses = await nexusFetchAllJsonBatched(wave3Urls, accessToken);
      } catch (err) {
        logLine(
          `[enriched sync] WARN: wave3 termination batch threw error, attempting individual fallback: ${String(err.message || err).slice(0, 200)}`
        );
        wave3Responses = [];
        for (let i = 0; i < wave3Urls.length; i++) {
          try {
            wave3Responses.push(await nexusGetJson(wave3Urls[i], accessToken));
          } catch (e) {
            logLine(
              `[enriched sync] SKIP wave3 termination placement=${wave3PlacementIds[i]} due to error: ${String(e.message || e).slice(0, 100)}`
            );
            wave3Responses.push({});
          }
        }
      }
      for (let i = 0; i < wave3PlacementIds.length; i++) {
        const items = extractItems(wave3Responses[i]);
        if (items.length > 0) terminationByPlacementId.set(wave3PlacementIds[i], items);
      }
      logLine(
        `[enriched sync] STEP 3/4 ENRICH APIS wave3: responses=${wave3Responses.length} withData=${terminationByPlacementId.size} httpMs=${Date.now() - wave3Start}`
      );
    }
  }

  for (const c of candidates) {
    const dealSheetId = normalizeNexusResourceId(c?.deal_sheet);
    if (dealSheetId == null || dealSheetId === "") continue;

    const jobId = normalizeNexusResourceId(c?.job);
    const candId = normalizeNexusResourceId(c?.candidate);
    const clientId = normalizeNexusResourceId(c?.client);
    let submittalRow = hasPreloadedSubmittals
      ? getPreloadedSubmittalRow(preloadedSubmittals, jobId, candId)
      : null;

    const failedKinds = collectCandidateApiFailureKinds({
      dealSheetId,
      jobId,
      candId,
      clientId,
      skipClientDetailFetchIds,
      skipClientOfferingsFetchIds,
      failedIdsByKind,
      failedSubmittalKeys,
      dealSheetById,
      clientById,
      hasPreloadedSubmittals,
    });
    if (submittalRow?.client && isEmbeddedClientGeoSufficient(submittalRow.client)) {
      const parentKeyEmbedded = normalizeParentClientIdRef(submittalRow.client?.parent_client);
      if (
        parentKeyEmbedded
        && !parentClientNameFromEmbedded(submittalRow.client)
        && failedIdsByKind.par.has(parentKeyEmbedded)
      ) {
        failedKinds.push(`par:${parentKeyEmbedded}`);
      }
    }
    if (failedKinds.length > 0) {
      const placementId = normalizeNexusResourceId(c?.placement) || "";
      const dsKey = String(dealSheetId);
      const jobKey = jobId == null ? "" : String(jobId);
      const candKey = candId == null ? "" : String(candId);
      logLine(
        `[enriched sync] SKIP candidate ds=${dsKey} placement=${placementId} job=${jobKey} cand=${candKey} due to failed APIs: ${failedKinds.slice(0, 6).join(",")}${failedKinds.length > 6 ? ` +${failedKinds.length - 6}` : ""} (will retry next run)`
      );
      skippedDueToApiFailure++;
      continue;
    }

    const candidatePart = mapDealSheetCandidateToBq(c, { persistDealSheetStatusFromCandidate });
    const embeddedClient = submittalRow?.client;
    const useEmbeddedClient =
      isEmbeddedClientGeoSufficient(embeddedClient) &&
      clientId != null &&
      clientId !== "" &&
      String(embeddedClient?.id ?? "") === String(clientId);
    const clientObj = useEmbeddedClient
      ? embeddedClient
      : clientId == null || clientId === ""
        ? null
        : clientById.get(String(clientId)) ?? null;
    const parentKey = normalizeParentClientIdRef(clientObj?.parent_client);
    const parentNameEmbedded = parentClientNameFromEmbedded(clientObj);
    const parentRec = parentKey ? parentClientById.get(parentKey) ?? null : null;
    const parentNameFromApi =
      parentRec && parentRec.name != null ? String(parentRec.name).trim() || null : null;
    const parentName = parentNameEmbedded ?? parentNameFromApi;
    const clientPart = mapClientToBq(clientObj, parentName);
    const clientStateRaw = clientPart?.CLIENT_STATE ?? null;
    const clientStateNorm = clientStateRaw == null || String(clientStateRaw).trim() === ""
      ? null
      : String(clientStateRaw).trim().toUpperCase();

    const detail = dealSheetById.get(String(dealSheetId));
    if (!detail) continue;

    const dealSheetPart = mapDealSheetDetailToBq(detail);
    const hoursRow = hoursByDs.get(String(dealSheetId)) ?? null;
    const hoursPart = mapDealSheetHoursDetailsToBq(hoursRow, clientStateNorm);
    const revenueRow = revByDs.get(String(dealSheetId)) ?? null;
    const revenuePart = mapDealSheetRevenueDetailsToBq(revenueRow);
    const addCostRows = additionalCostsByDs.get(String(dealSheetId)) ?? [];
    const travelRows = travelAllowancesByDs.get(String(dealSheetId)) ?? [];
    const clientCostRows = clientCostsByDs.get(String(dealSheetId)) ?? [];
    const addCostBonusPart = mapDealSheetAdditionalCostsToBq(addCostRows);
    const travelBonusPart = mapTravelAllowanceToAdditionalBonus(travelRows);
    const clientCostBonusPart = mapDealSheetClientCostsToAdditionalBonus(clientCostRows);
    const addCostPart = {
      ADDITIONAL_BONUS:
        (addCostBonusPart.ADDITIONAL_BONUS || 0) +
        (travelBonusPart.ADDITIONAL_BONUS || 0) +
        (clientCostBonusPart.ADDITIONAL_BONUS || 0),
    };

    const rateChangePart = mapDealSheetRateChangeToBq(
      rateChangesByDs.get(String(dealSheetId)) ?? [], jobId
    );
    const jobObj = jobId == null || String(jobId).trim() === "" ? null : jobById.get(String(jobId)) ?? null;
    const jobPart = mapJobToBq(jobObj);

    const apiOfferings = clientId == null || clientId === ""
      ? []
      : clientOfferingsByClient.get(String(clientId)) ?? [];
    const clientOfferingRow = resolveClientOfferingForEnrich(submittalRow, apiOfferings, jobObj);
    const mspPart = mapMspFromClientOfferingRow(clientOfferingRow);

    const ratesList = ratesByDs.get(String(dealSheetId)) ?? [];
    const ratesPart = mapDealSheetRatesListToBq(ratesList, clientStateNorm);
    const positionPart = mapJobProfessionSpecialtyFromJob(jobObj);

    if (!submittalRow && !hasPreloadedSubmittals) {
      const recruiterIdForSub = detail?.recruiter;
      const subKey = jobId != null && recruiterIdForSub != null && candId != null
        ? `${jobId}:${recruiterIdForSub}:${candId}` : null;
      submittalRow = subKey ? submittalByKey.get(subKey) ?? null : null;
    }
    const submittalPart = mapJobSubmittalToBq(submittalRow, jobObj);

    const recruiterId = detail?.recruiter;
    const salesRepId = detail?.sales_rep;
    const recruiterUser = recruiterId == null || String(recruiterId).trim() === ""
      ? null : userById.get(String(recruiterId)) ?? null;
    const salesRepUser = salesRepId == null || String(salesRepId).trim() === ""
      ? null : userById.get(String(salesRepId)) ?? null;
    const userPart = mapDealSheetUsersToBq(detail, recruiterUser, salesRepUser, submittalRow);

    const isCanadaRecruiter = isCynetHealthCanadaRecruiter(userPart?.ASSIGNMENT_RECRUITER_EMAIL);
    const hoursPartForRow = isCanadaRecruiter ? pickCanadaDealSheetHoursPart(hoursPart) : hoursPart;
    const bonusTotalsPart = isCanadaRecruiter
      ? {}
      : computeBonusTotals(addCostRows, travelRows, hoursRow, clientCostRows);
    const weekSplitPart = isCanadaRecruiter
      ? {}
      : computeWeekSplit({
        scheduleHours1: hoursPart.SCHEDULE_HOURS_1,
        scheduleHours2: hoursPart.SCHEDULE_HOURS_2,
        initialWeeks: dealSheetPart.INITIAL_PROJECT_DURATION_IN_WEEKS,
      });

    const candidateObj = !candId
      ? null : candidateById.get(String(candId)) ?? null;
    const candidateDetailPart = mapCandidateToBq(candidateObj);

    const candTypeRows = !candId
      ? [] : candidateTypesByCand.get(String(candId)) ?? [];
    const providerTypePart = mapCandidateCandidateTypesToBq(candTypeRows);

    const mspNameRaw = mspPart?.MSP_NAME ?? null;
    const mspNameNorm = mspNameRaw == null || String(mspNameRaw).trim() === "" ? null : String(mspNameRaw).trim();
    const jobTypeRaw = jobPart?.JOB_TYPE ?? null;
    const jobTypeNorm = jobTypeRaw == null || String(jobTypeRaw).trim() === "" ? null : String(jobTypeRaw).trim();
    const lineOfBusiness =
      mspNameNorm != null && mspNameNorm.toLowerCase() === "direct"
        ? "Staffing"
        : jobTypeNorm != null && jobTypeNorm.toLowerCase() === "permanent"
          ? "FT Hire"
          : mspNameNorm;

    let terminationReason = null;
    if (fetchTerminationDetails && submittalPart?.PLACEMENT_ID != null) {
      const termItems = terminationByPlacementId.get(String(submittalPart.PLACEMENT_ID)) ?? [];
      const latestTerm = pickLatestTerminationDetailItem(termItems);
      terminationReason = latestTerm ? extractTerminationReasonValue(latestTerm) : null;
    }

    const placementIdForNotes = submittalPart?.PLACEMENT_ID;
    const notesForPlacement = placementIdForNotes != null
      ? notesByPlacementId.get(String(placementIdForNotes)) ?? []
      : [];
    const newHireDate = resolveNewHireDateForDealRow(dealSheetPart?.DEAL_TYPE, notesForPlacement);

    const canadaTypePart = isCynetHealthCanadaRecruiter(userPart?.ASSIGNMENT_RECRUITER_EMAIL)
      ? { TYPE: mapCanadaTypeFromTenNintyNine(detail) }
      : {};

    const row = {
      ...candidatePart,
      ...clientPart,
      ...dealSheetPart,
      ...hoursPartForRow,
      ...revenuePart,
      ...addCostPart,
      ...bonusTotalsPart,
      ...weekSplitPart,
      ...rateChangePart,
      ...jobPart,
      ...mspPart,
      ...ratesPart,
      ...positionPart,
      ...submittalPart,
      ...userPart,
      ...candidateDetailPart,
      ...providerTypePart,
      ...canadaTypePart,
      CLIENT_TYPE: mspPart?.CLIENT_TYPE ?? null,
      LINE_OF_BUSINESS: lineOfBusiness,
      START_DATE: submittalPart?.START_DATE ?? null,
      TENTATIVE_DATE: resolveTentativeDateForPlacementRow(
        submittalPart?.PLACEMENT_STATUS,
        submittalPart?.TENTATIVE_DATE ?? jobPart?.TENTATIVE_DATE ?? null
      ),
      TERMINATION_REASON: terminationReason,
      NEW_HIRE_DATE: newHireDate,
    };
    const newRateFamilyPart = isCynetHealthCanadaRecruiter(row?.ASSIGNMENT_RECRUITER_EMAIL)
      ? {}
      : computeNewRateFamily(row);
    const derivedPart = computeDerivedPlacementFields(row);
    const finalRow = sanitizeCanadaDealSheetRow(coerceApiFloatNullsToZero({
      ...row,
      ...newRateFamilyPart,
      ...derivedPart,
    }));
    if (shouldExcludeRowFromBigQuery(finalRow)) {
      excludedDummyOrTraining++;
      continue;
    }
    const captureTs = new Date().toISOString();
    const costLogs = mapAdditionalCostLogRowsForDealSheet(addCostRows, finalRow, captureTs);
    const travelLogs = mapTravelAllowanceLogRowsForDealSheet(travelRows, finalRow, captureTs);
    const clientCostLogs = mapClientCostLogRowsForDealSheet(clientCostRows, finalRow, captureTs);
    if (costLogs.length) additionalCostLogRows.push(...costLogs);
    if (travelLogs.length) additionalCostLogRows.push(...travelLogs);
    if (clientCostLogs.length) additionalCostLogRows.push(...clientCostLogs);
    combined.push(finalRow);
  }

  if (excludedDummyOrTraining > 0) {
    logLine(
      `[enriched sync] STEP 3/4 ENRICH: excluded ${excludedDummyOrTraining} row(s) (training/dummy/candidate-name filters — not synced to BigQuery)`
    );
  }

  if (skippedDueToApiFailure > 0) {
    logLine(
      `[enriched sync] STEP 3/4 ENRICH: skipped ${skippedDueToApiFailure} candidate(s) due to API failures (no BigQuery insert; will retry next scheduled run)`
    );
  }

  if (!options.skip_contract_id) {
    await resolveContractIdsForRows(combined, {
      skipAllocation: true,
      allocateContractIdsFn: allocateContractIds,
      fetchContractIdsByDealSheetIdsFn: fetchContractIdsByDealSheetIds,
      fetchContractIdsForExtensionsFn: fetchContractIdsForExtensions,
      resolveTableIdFn: (row) => resolveActiveDealSheetTableId(row?.ASSIGNMENT_RECRUITER_EMAIL),
    });
  } else {
    logLine("[enriched sync] STEP 3/4 ENRICH: skip_contract_id — CONTRACT_ID resolution skipped");
  }

  if (fetchTerminationDetails && terminationByPlacementId.size > 0) {
    const captureTs = new Date().toISOString();
    for (const finalRow of combined) {
      const pid = finalRow?.PLACEMENT_ID;
      if (pid == null) continue;
      const items = terminationByPlacementId.get(String(pid)) ?? [];
      for (const item of items) {
        const logRow = mapTerminationReasonLogRowForDealSheet(item, finalRow, captureTs);
        if (logRow) terminationLogRows.push(logRow);
      }
    }
  }

  return { rows: combined, additionalCostLogRows, terminationLogRows };
}

module.exports = {
  buildEnrichedRowsFromDealSheetCandidates,
  extractSubmittalStatusRaw,
  isAllowedSubmittalStatus,
  createFailedIdsByKind,
  collectCandidateApiFailureKinds,
  isEmbeddedClientGeoSufficient,
  isEmbeddedClientOfferingMspSufficient,
  embeddedClientOfferingsSkippable,
  registerEmbeddedClientSkips,
};
