/**
 * Nexus API Client
 * Handles authentication, token refresh, and HTTP requests to Nexus API
 */

const axios = require("axios");
const config = require("./config");
const { logLine } = require("./logger");

let cachedAccessToken = null;
let cachedAccessTokenExp = 0;
let cachedRefreshToken = null;

/**
 * Build URL with query parameters
 */
function buildUrl(baseUrl, params = {}) {
  const url = new URL(baseUrl);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.append(key, String(value));
    }
  });
  return url.toString();
}

/**
 * Authenticate with Nexus API and get tokens
 */
async function authNexusToken(username, password) {
  const url = `${config.nexus.baseUrl}/api/auth/token/`;
  const response = await axios.post(
    url,
    { username, password },
    {
      headers: {
        accept: "application/json",
        "Content-Type": "application/json",
        "X-CSRFTOKEN": config.nexus.csrfToken,
      },
    }
  );

  const { access, refresh } = response.data;
  if (!access || !refresh) {
    throw new Error(`Auth response missing tokens: ${JSON.stringify(response.data)}`);
  }

  cachedAccessToken = access;
  cachedRefreshToken = refresh;
  cachedAccessTokenExp = Date.now() + 55 * 60 * 1000;

  logLine("Obtained new Nexus access+refresh token.");
  return access;
}

/**
 * Refresh Nexus access token
 */
async function refreshNexusToken(refreshToken) {
  const url = `${config.nexus.baseUrl}/api/auth/token/refresh/`;
  const response = await axios.post(
    url,
    { refresh: refreshToken },
    {
      headers: {
        accept: "application/json",
        "Content-Type": "application/json",
        "X-CSRFTOKEN": config.nexus.csrfToken,
      },
    }
  );

  const { access, refresh: newRefresh } = response.data;
  if (!access) {
    throw new Error(`Refresh response missing access token: ${JSON.stringify(response.data)}`);
  }

  cachedAccessToken = access;
  cachedRefreshToken = newRefresh || refreshToken;
  cachedAccessTokenExp = Date.now() + 55 * 60 * 1000;

  logLine("Refreshed Nexus access token.");
  return access;
}

/**
 * Get Nexus access token (with caching and auto-refresh)
 */
async function getNexusAccessToken() {
  const nowMs = Date.now();
  if (cachedAccessToken && cachedAccessTokenExp && nowMs < cachedAccessTokenExp - 60000) {
    return cachedAccessToken;
  }

  if (cachedRefreshToken) {
    try {
      return await refreshNexusToken(cachedRefreshToken);
    } catch (e) {
      logLine(`WARN refresh token failed; re-authing. ${e.message}`);
      const msg = String(e.message || e);
      if (/401|403|token_not_valid|blacklisted|not valid/i.test(msg)) {
        cachedRefreshToken = null;
        cachedAccessToken = null;
        cachedAccessTokenExp = 0;
      }
    }
  }

  const { username, password } = config.nexus;
  if (!username || !password) {
    throw new Error("Missing Nexus credentials. Set NEXUS_USERNAME and NEXUS_PASSWORD environment variables.");
  }
  return authNexusToken(username, password);
}

/**
 * Make a GET request to Nexus API
 */
async function nexusGetJson(url, accessToken) {
  const response = await axios.get(url, {
    headers: {
      accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });
  return response.data;
}

/**
 * Rich axios error text for logs (status / code / body snippet)
 */
function formatNexusRequestError(err, url) {
  if (!err) return "unknown error";
  const code = err.code ? `code=${err.code}` : "";
  const msg = err.message ? String(err.message) : "";
  if (err.response) {
    const st = err.response.status;
    const stText = err.response.statusText || "";
    let body = "";
    const d = err.response.data;
    if (d != null) {
      body = typeof d === "string" ? d : JSON.stringify(d);
      if (body.length > 240) body = body.slice(0, 237) + "...";
    }
    return [`HTTP ${st} ${stText}`.trim(), url, code, body || msg].filter(Boolean).join(" | ");
  }
  return [url, code || "no HTTP response", msg || "(empty message)"].filter(Boolean).join(" | ");
}

/** Walk Error.cause chain for a synthetic or real axios error */
function rootAxiosError(err) {
  let e = err;
  const seen = new Set();
  while (e && typeof e === "object" && !seen.has(e)) {
    seen.add(e);
    if (e.isAxiosError) return e;
    e = e.cause;
  }
  return null;
}

/**
 * Retry-worthy: no HTTP response (reset/hang-up), 429/500/502/503/504, or errno-style failures
 */
function isTransientNexusError(err) {
  const ax = rootAxiosError(err);
  if (ax) {
    const st = ax.response?.status;
    if (st === 429 || st === 500 || st === 502 || st === 503 || st === 504) return true;
    if (!ax.response) return true;
    return false;
  }
  const msg = `${String(err?.message || "")} ${String(err?.code || "")}`;
  return /address unavailable|timeout|ECONNRESET|ETIMEDOUT|socket|EPIPE|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ECANCELED|ERR_SOCKET|UND_ERR_SOCKET|network|HTTP 500|HTTP 502|HTTP 503|HTTP 504|HTTP 429/i.test(
    msg
  );
}

/** True when the error is an HTTP 404 (e.g. a job-submittals page number past the last page). */
function isNotFoundNexusError(err) {
  const ax = rootAxiosError(err);
  if (ax && ax.response?.status === 404) return true;
  return /\bHTTP 404\b|status code 404/i.test(String(err?.message || ""));
}

/**
 * Make parallel GET requests to Nexus API
 */
async function nexusFetchAllJson(urls, accessToken) {
  if (!urls || urls.length === 0) return [];

  const requests = urls.map((url) =>
    axios.get(url, {
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      validateStatus: () => true,
    })
  );

  const responses = await Promise.all(
    requests.map((p) => p.catch((e) => ({ error: e })))
  );

  return responses.map((resp, i) => {
    if (resp.error) {
      const wrapped = new Error(formatNexusRequestError(resp.error, urls[i]));
      wrapped.cause = resp.error;
      throw wrapped;
    }
    const r = resp;
    if (r.status >= 400) {
      const ax = {
        isAxiosError: true,
        message: r.statusText,
        response: { status: r.status, statusText: r.statusText, data: r.data },
      };
      const wrapped = new Error(formatNexusRequestError(ax, urls[i]));
      wrapped.cause = ax;
      throw wrapped;
    }
    return r.data;
  });
}

/**
 * Retry wrapper for nexusFetchAllJson with exponential backoff
 */
async function nexusFetchAllJsonWithRetry(urls, accessToken, maxRetries = config.maxRetries) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await nexusFetchAllJson(urls, accessToken);
    } catch (e) {
      lastError = e;
      const msg = String(e.message || e);
      const isTransient = isTransientNexusError(e);
      if (attempt < maxRetries && isTransient) {
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        logLine(`[retry] attempt ${attempt}/${maxRetries} failed: ${msg.slice(0, 100)}... retrying in ${delayMs}ms`);
        await sleep(delayMs);
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

/**
 * GET with retries for transient network / 5xx (submittal list pagination).
 */
async function nexusGetJsonWithRetry(url, accessToken, maxRetries = config.maxRetries) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await nexusGetJson(url, accessToken);
    } catch (e) {
      lastError = e;
      const isTransient = isTransientNexusError(e);
      if (attempt < maxRetries && isTransient) {
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        logLine(
          `[retry] nexusGetJson attempt ${attempt}/${maxRetries} ${shortUrlForLog(url)}: ${String(e?.message || e).slice(0, 120)} — retry in ${delayMs}ms`
        );
        await sleep(delayMs);
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

/**
 * Runs nexusFetchAllJson in chunks with retry and inter-batch delay
 */
async function nexusFetchAllJsonBatched(urls, accessToken) {
  const out = [];
  const maxPerBatch = config.fetchAllMax;

  for (let i = 0; i < urls.length; i += maxPerBatch) {
    if (i > 0) await sleep(config.batchDelayMs);
    const chunk = urls.slice(i, i + maxPerBatch);
    const results = await nexusFetchAllJsonWithRetry(chunk, accessToken);
    out.push(...results);
  }

  return out;
}

/**
 * Normalize paged API response
 */
function normalizePagedResponse(json) {
  if (Array.isArray(json)) return { items: json, next: null };
  const items =
    (Array.isArray(json?.results) && json.results) ||
    (Array.isArray(json?.data) && json.data) ||
    (Array.isArray(json?.items) && json.items) ||
    [];
  const next = typeof json?.next === "string" && json.next ? json.next : null;
  return { items, next };
}

/**
 * Get first item from paged response
 */
function firstPagedItemOrNull(page) {
  const { items } = normalizePagedResponse(page);
  return items.length ? items[0] : null;
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Nexus list/detail payloads sometimes use scalar ids and sometimes nested { id, ... }.
 * Never pass String(object) into URLs (becomes "[object Object]").
 * @returns {string|null}
 */
function normalizeNexusResourceId(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "object" && raw.id != null) {
    const id = String(raw.id).trim();
    return id || null;
  }
  const s = String(raw).trim();
  if (!s || s === "[object Object]") return null;
  return s;
}

/**
 * Shorten URL for logging
 */
function shortUrlForLog(fullUrl) {
  const base = config.nexus.baseUrl || "";
  let s = fullUrl.startsWith(base) ? fullUrl.slice(base.length) : fullUrl;
  if (s.length > 240) s = s.slice(0, 237) + "...";
  return s || fullUrl;
}

module.exports = {
  buildUrl,
  getNexusAccessToken,
  nexusGetJson,
  nexusGetJsonWithRetry,
  nexusFetchAllJson,
  nexusFetchAllJsonWithRetry,
  nexusFetchAllJsonBatched,
  normalizePagedResponse,
  firstPagedItemOrNull,
  normalizeNexusResourceId,
  sleep,
  shortUrlForLog,
  isTransientNexusError,
  isNotFoundNexusError,
};
