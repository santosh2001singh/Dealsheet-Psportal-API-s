/**
 * Nexus API Client
 * Handles authentication, token refresh, and HTTP requests to Nexus API
 */

const axios = require("axios");
const https = require("https");
const config = require("./config");
const { logLine } = require("./logger");

/**
 * Shared keep-alive agent for every Nexus request.
 *
 * Node's default agent runs with keepAlive:false, so axios opened a fresh TCP connection and a fresh
 * TLS handshake for EVERY call — thousands per run. On Cloud Run that churn is fatal in two ways:
 * each closed socket sits in TIME_WAIT until the ephemeral port pool runs dry (EPIPE on connect),
 * and the instance's egress NAT saturates on concurrent connection setups, so new sockets die
 * *before* the handshake completes — exactly the "Client network socket disconnected before secure
 * TLS connection was established" / "socket hang up" / 45s ECONNABORTED wall seen on 2026-09-05.
 *
 * The give-away that this was never a load or throttle problem: that run logged concurrency=8 with
 * deal_sheets=1 jobs=1 candidates=1 and still burned 5 retries on a single job_id, while the same
 * URLs answered 200 in 400-500ms from a laptop. One request, 45s timeout, no server-side pressure.
 *
 * Reusing connections removes the handshake per request entirely. maxSockets caps concurrent
 * connections below what the NAT will bear; maxFreeSockets keeps a warm pool between waves.
 */
const nexusHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 15000,
  // Above the highest fan-out any domain uses (fetchAllMax 20 / candidate fetch 20) so the agent
  // never becomes the bottleneck, while still bounding what one instance opens at once.
  maxSockets: 25,
  maxFreeSockets: 10,
  // Drop an idle pooled socket before Nexus/the LB would close it from its side; a server-closed
  // socket handed back out is what surfaces as ECONNRESET on the next request.
  timeout: 60000,
});

/**
 * Every Nexus call goes through this instance so the keep-alive agent can never be missed at a call
 * site. Per-request options (timeout, validateStatus, headers) still override as usual.
 */
const nexusHttp = axios.create({ httpsAgent: nexusHttpsAgent });

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
  const response = await nexusHttp.post(
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
  const response = await nexusHttp.post(
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
 * Log a FAILED Nexus request.
 *
 * Failures only, and always on — no env var to remember, because the lines that matter are rare by
 * definition. A healthy run prints nothing from here; a run in trouble prints exactly the requests
 * that are in trouble, which is what the logs are read for.
 *
 * Successes are deliberately NOT logged. They carry candidate PII (names, emails, phone numbers,
 * pay rates) that would then sit in Cloud Logging under the project's retention policy, and one
 * update run makes ~5000 of them — the failures would be buried in their own noise.
 *
 * The error BODY is included and is the whole point of the line: it is what separates an
 * edge-throttle HTML 403 ("<!doctype html>...", a rate limit, retryable) from a genuine Django JSON
 * 403 ({"detail": "You do not have permission..."}, a real refusal that retrying will never fix).
 * See isEdgeThrottle403. Error bodies carry no candidate data.
 *
 * @param {string} url
 * @param {number} ms - wall time before the failure
 * @param {*} err - axios error, or a synthetic one from the parallel path
 */
function logNexusFailure(url, ms, err) {
  const ax = rootAxiosError(err) || err;
  logLine(`[nexus] GET ${shortUrlForLog(url)} -> FAILED ${ms}ms ${formatNexusRequestError(ax, url)}`);
}

/**
 * Make a GET request to Nexus API
 */
async function nexusGetJson(url, accessToken) {
  const startedMs = Date.now();
  try {
    const response = await nexusHttp.get(url, {
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      // A hung socket would otherwise wait forever and drain the whole run's time budget — see
      // config.requestTimeoutMs. ECONNABORTED from a timeout is already treated as transient by
      // isTransientNexusError, so the retry wrapper picks it up.
      timeout: config.requestTimeoutMs,
    });
    return response.data;
  } catch (err) {
    logNexusFailure(url, Date.now() - startedMs, err);
    throw err;
  }
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
 * True when a 403 came from the edge (Cloud Armor / load balancer) rather than from Nexus itself.
 *
 * Nexus is a Django API: every genuine auth/permission failure returns JSON, e.g.
 *   {"detail": "Authentication credentials were not provided."}   (401)
 *   {"detail": "You do not have permission to perform this action."} (403)
 *
 * The edge returns an HTML error page instead — `<!doctype html>...<title>403</title>`. That kind of
 * 403 is a throttle, not a permission decision: the same request succeeds moments later and from
 * other IPs. Seen on 2026-08-24, when a Canada run firing 3222 requests in one wave started getting
 * HTML 403s mid-batch while the identical URLs worked fine from a laptop.
 *
 * Treating it as transient lets the existing backoff ride it out; a real JSON 403 still fails fast.
 *
 * @param {*} ax - root axios error
 * @returns {boolean}
 */
function isEdgeThrottle403(ax) {
  if (!ax || ax.response?.status !== 403) return false;
  const body = ax.response?.data;
  // A JSON body (object, or a string that parses) means Nexus answered — a real permission error.
  if (body && typeof body === "object") return false;
  const text = String(body ?? "");
  if (text.trim() === "") return false;
  return /<!doctype html|<html|<title>\s*403/i.test(text);
}

/**
 * Retry-worthy: no HTTP response (reset/hang-up), 429/500/502/503/504, an edge-throttle HTML 403,
 * or errno-style failures
 */
function isTransientNexusError(err) {
  const ax = rootAxiosError(err);
  if (ax) {
    const st = ax.response?.status;
    if (st === 429 || st === 500 || st === 502 || st === 503 || st === 504) return true;
    if (isEdgeThrottle403(ax)) return true;
    if (!ax.response) return true;
    return false;
  }
  const msg = `${String(err?.message || "")} ${String(err?.code || "")}`;
  // Same edge-throttle rule, for callers that only have the formatted message (the batch fallback
  // wraps the axios error in a plain Error whose text keeps the HTML snippet).
  if (/HTTP 403/i.test(msg) && /<!doctype html|<html|<title>\s*403/i.test(msg)) return true;
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

  // One timing for the whole wave: these requests are issued together, so a per-request duration
  // would just restate the wave's own elapsed time.
  const waveStartMs = Date.now();

  const requests = urls.map((url) =>
    nexusHttp.get(url, {
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      validateStatus: () => true,
      // Bounds every parallel request in the wave. One stuck URL used to hold up its whole batch,
      // and with retries on top a single dead socket could consume tens of minutes.
      timeout: config.requestTimeoutMs,
    })
  );

  const responses = await Promise.all(
    requests.map((p) => p.catch((e) => ({ error: e })))
  );

  // Log EVERY failure in the wave before the map below throws on the first one. Without this pass a
  // wave where 4 of 11 URLs 403'd would surface a single error line, hiding the other three — and
  // the shape of a throttle (how many of the wave it hit) is exactly what you need to see.
  const waveMs = Date.now() - waveStartMs;
  responses.forEach((resp, i) => {
    if (resp && resp.error) {
      logNexusFailure(urls[i], waveMs, resp.error);
      return;
    }
    // validateStatus is `() => true` on this path, so a 4xx/5xx arrives as a normal response rather
    // than a rejection — it still has to be logged as the failure it is.
    if (resp && resp.status >= 400) {
      logNexusFailure(urls[i], waveMs, {
        isAxiosError: true,
        message: resp.statusText,
        response: { status: resp.status, statusText: resp.statusText, data: resp.data },
      });
    }
  });

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
