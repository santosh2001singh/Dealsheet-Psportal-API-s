/**
 * CEIPAL API client for the Cynet Systems runrate sync.
 *
 *   1. POST CEIPAL_AUTH_URL with { email, password, apiKey, json: "1" } -> access token. The token
 *      lives 1 hour, so it is cached for 50 minutes (or the response's expires_in minus 10 minutes)
 *      and minted again after that, or straight away if a report call answers 401.
 *   2. GET  CEIPAL_RUNRATE_REPORT_URL?response_type=1&limit=N&page=P, Authorization: Bearer <token>
 *
 * Credentials come from functions/.env only (see .env.example); nothing secret lives in code.
 *
 * The report endpoint's paging envelope is not documented to us, so fetchAllReportRecords accepts
 * every shape CEIPAL's APIs are known to use — a bare array, or an object holding the records under
 * results / data / records, with paging by a `next` URL, by num_pages / total_pages, or by simply
 * asking for the next page until a short (or repeated) page comes back.
 */

const axios = require("axios");
const config = require("./config");
const { logLine, logError } = require("./logger");

/** CEIPAL tokens expire after 1 hour; renew 10 minutes early. */
const TOKEN_TTL_MS = 50 * 60 * 1000;
const TOKEN_RENEW_EARLY_MS = 10 * 60 * 1000;
let cachedToken = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ceipalConfig() {
  return config.ceipal;
}

function assertConfigured(cfg) {
  const missing = ["authUrl", "email", "password", "apiKey", "reportUrl"].filter((k) => !cfg[k]);
  if (missing.length > 0) {
    throw new Error(
      `CEIPAL is not configured: missing ${missing
        .map((k) => ({
          authUrl: "CEIPAL_AUTH_URL",
          email: "CEIPAL_EMAIL",
          password: "CEIPAL_PASSWORD",
          apiKey: "CEIPAL_API_KEY",
          reportUrl: "CEIPAL_RUNRATE_REPORT_URL",
        })[k])
        .join(", ")} in functions/.env`
    );
  }
}

/** Pull the access token out of whatever shape the auth endpoint answers with. */
function extractToken(body) {
  if (!body) return null;
  if (typeof body === "string") return body.trim() || null;
  return (
    body.access_token ||
    body.accessToken ||
    body.token ||
    body.data?.access_token ||
    body.data?.token ||
    null
  );
}

async function requestWithRetry(http, reqConfig, { maxRetries, label }) {
  let attempt = 0;
  for (;;) {
    try {
      return await http.request(reqConfig);
    } catch (e) {
      const status = e?.response?.status;
      const retryable = !status || status === 429 || status >= 500;
      if (!retryable || attempt >= maxRetries) throw e;
      attempt++;
      const waitMs = Math.min(30000, 1000 * 2 ** attempt);
      logError(`[ceipal] ${label} failed (status=${status ?? e.code ?? "network"}); retry ${attempt}/${maxRetries} in ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
}

/**
 * @param {object} [deps] { http, now, forceRefresh }
 * @returns {Promise<string>} bearer token
 */
async function getCeipalAccessToken(deps = {}) {
  const cfg = ceipalConfig();
  assertConfigured(cfg);
  const now = deps.now ?? Date.now();
  if (!deps.forceRefresh && cachedToken && cachedToken.expiresAt > now) return cachedToken.token;

  const http = deps.http ?? axios;
  const headers = { "Content-Type": "application/json" };
  const res = await requestWithRetry(
    http,
    {
      method: "POST",
      url: cfg.authUrl,
      headers,
      data: { email: cfg.email, password: cfg.password, apiKey: cfg.apiKey, json: "1" },
      timeout: cfg.requestTimeoutMs,
    },
    { maxRetries: cfg.maxRetries, label: "auth" }
  );
  const token = extractToken(res?.data);
  if (!token) {
    throw new Error(`CEIPAL auth returned no token (keys: ${Object.keys(res?.data || {}).join(",") || "none"})`);
  }
  const expiresInSec = Number(res?.data?.expires_in ?? res?.data?.data?.expires_in);
  const ttlMs =
    Number.isFinite(expiresInSec) && expiresInSec > 0
      ? Math.max(60 * 1000, expiresInSec * 1000 - TOKEN_RENEW_EARLY_MS)
      : TOKEN_TTL_MS;
  cachedToken = { token, expiresAt: now + ttlMs };
  return token;
}

/**
 * Records + paging hints from one report response body.
 *
 * CEIPAL's get-report-data answers (seen 2026-11-18):
 *   { success, message, record_count, page_count, limit, page_number,
 *     has_prev_page, has_next_page, prev_page, next_page, result: [...] }
 * Two of those fields are NOT trusted: page_count read 100 for 1204 records at limit 100, and the
 * next_page URL drops the limit parameter. Paging is therefore done by asking for page=N with our
 * own limit until has_next_page is 0. Other envelopes (results / data / records, `next`) are still
 * accepted in case the report is rebuilt.
 */
function parseReportPage(body) {
  if (Array.isArray(body)) return { records: body, next: null, hasNext: null, recordCount: null };
  if (!body || typeof body !== "object") return { records: [], next: null, hasNext: null, recordCount: null };
  const records =
    (Array.isArray(body.result) && body.result) ||
    (Array.isArray(body.results) && body.results) ||
    (Array.isArray(body.data) && body.data) ||
    (Array.isArray(body.records) && body.records) ||
    (Array.isArray(body.data?.results) && body.data.results) ||
    [];
  const hasNext =
    body.has_next_page == null ? null : body.has_next_page === true || Number(body.has_next_page) === 1;
  const next = typeof body.next === "string" && body.next ? body.next : null;
  const recordCount = body.record_count == null ? null : Number(body.record_count);
  return { records, next, hasNext, recordCount: Number.isFinite(recordCount) ? recordCount : null };
}

/**
 * Fetch ONE page of the runrate report (page numbers start at 1). An expired token (401) is renewed
 * once and the page retried.
 * @param {number} page
 * @param {object} [deps] { http, getToken }
 * @returns {Promise<{ records: object[], hasNext: boolean|null, next: string|null, recordCount: number|null }>}
 */
async function fetchReportPage(page, deps = {}) {
  const cfg = ceipalConfig();
  assertConfigured(cfg);
  const http = deps.http ?? axios;
  const getToken = deps.getToken ?? getCeipalAccessToken;

  let token = await getToken(deps);
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await requestWithRetry(
        http,
        {
          method: "GET",
          url: cfg.reportUrl,
          params: { response_type: 1, limit: cfg.reportPageLimit, page },
          headers: { Authorization: `Bearer ${token}` },
          timeout: cfg.requestTimeoutMs,
        },
        { maxRetries: cfg.maxRetries, label: `report page ${page}` }
      );
      const parsed = parseReportPage(res?.data);
      if (parsed.records.length === 0 && page === 1 && parsed.recordCount > 0) {
        throw new Error(
          `CEIPAL report says record_count=${parsed.recordCount} but no records were found in the response (keys: ${Object.keys(res?.data || {}).join(",")})`
        );
      }
      return parsed;
    } catch (e) {
      if (e?.response?.status === 401 && attempt === 0) {
        token = await getToken({ ...deps, forceRefresh: true });
        continue;
      }
      throw e;
    }
  }
}

/**
 * Fetch every record of the runrate report.
 * @param {object} [deps] { http, getToken }
 * @returns {Promise<{ records: object[], pages: number, recordCount: number|null }>}
 */
async function fetchAllReportRecords(deps = {}) {
  const cfg = ceipalConfig();
  assertConfigured(cfg);
  const http = deps.http ?? axios;
  const getToken = deps.getToken ?? getCeipalAccessToken;
  const limit = cfg.reportPageLimit;

  let token = await getToken(deps);
  const all = [];
  let pages = 0;
  let page = 1;
  let nextUrl = null;
  let recordCount = null;
  let prevFirstCode = null;
  let refreshedOn401 = false;

  while (pages < cfg.reportMaxPages) {
    const reqConfig = nextUrl
      ? { method: "GET", url: nextUrl }
      : { method: "GET", url: cfg.reportUrl, params: { response_type: 1, limit, page } };
    reqConfig.headers = { Authorization: `Bearer ${token}` };
    reqConfig.timeout = cfg.requestTimeoutMs;

    let res;
    try {
      res = await requestWithRetry(http, reqConfig, { maxRetries: cfg.maxRetries, label: `report page ${page}` });
    } catch (e) {
      if (e?.response?.status === 401 && !refreshedOn401) {
        refreshedOn401 = true;
        token = await getToken({ ...deps, forceRefresh: true });
        continue;
      }
      throw e;
    }

    const parsed = parseReportPage(res?.data);
    pages++;
    if (parsed.recordCount != null && recordCount == null) recordCount = parsed.recordCount;

    if (parsed.records.length === 0) {
      // A first page that says rows exist but carries none means we cannot read the envelope —
      // fail loudly instead of finishing a "successful" run that wrote nothing.
      if (pages === 1 && recordCount > 0) {
        throw new Error(
          `CEIPAL report says record_count=${recordCount} but no records were found in the response (keys: ${Object.keys(res?.data || {}).join(",")})`
        );
      }
      break;
    }

    // An endpoint that ignores the page parameter answers every page with page 1: stop rather than loop.
    const firstCode = parsed.records[0]?.PlacementCode ?? JSON.stringify(parsed.records[0]);
    if (pages > 1 && firstCode === prevFirstCode) {
      logError(`[ceipal] page ${page} repeated the previous page; stopping (check the report's paging parameters)`);
      break;
    }
    prevFirstCode = firstCode;
    all.push(...parsed.records);

    if (parsed.hasNext === false) break;
    if (parsed.hasNext == null) {
      if (parsed.next) nextUrl = parsed.next;
      else if (parsed.records.length < limit) break;
    }
    page++;
    if (cfg.pageDelayMs > 0) await sleep(cfg.pageDelayMs);
  }

  if (pages >= cfg.reportMaxPages) {
    logError(`[ceipal] stopped at CEIPAL_REPORT_MAX_PAGES=${cfg.reportMaxPages}; the report may have more rows`);
  }
  if (recordCount != null && all.length !== recordCount) {
    logError(`[ceipal] fetched ${all.length} records but the report says record_count=${recordCount}`);
  }
  logLine(`[ceipal] runrate report fetched: records=${all.length} record_count=${recordCount ?? "n/a"} pages=${pages}`);
  return { records: all, pages, recordCount };
}

function resetCeipalTokenCacheForTests() {
  cachedToken = null;
}

module.exports = {
  getCeipalAccessToken,
  fetchReportPage,
  fetchAllReportRecords,
  parseReportPage,
  extractToken,
  resetCeipalTokenCacheForTests,
};
