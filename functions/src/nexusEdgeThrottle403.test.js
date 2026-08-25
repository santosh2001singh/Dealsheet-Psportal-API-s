const test = require("node:test");
const assert = require("node:assert/strict");

const { isTransientNexusError } = require("./nexusClient");

/**
 * Nexus is a Django API: a genuine auth/permission failure always answers with JSON. The edge in
 * front of it (Cloud Armor / load balancer) answers with an HTML error page instead, and that kind
 * of 403 is a throttle — the same URL succeeds moments later and from a different IP.
 *
 * On 2026-08-24 a Canada run firing 3222 requests in one wave started getting HTML 403s mid-batch.
 * Because 403 was not retryable, every affected deal sheet was silently skipped and landed with
 * missing enrich data.
 */

const HTML_403 =
  '<!doctype html><meta charset="utf-8"><meta name=viewport content="width=device-width, ' +
  'initial-scale=1"><title>403</title>';

/** Build the shape nexusFetchAllJson throws: an Error whose cause is a synthetic axios error. */
function nexusError(status, data) {
  const ax = {
    isAxiosError: true,
    message: "",
    response: { status, statusText: "", data },
  };
  const body = typeof data === "string" ? data : JSON.stringify(data);
  const err = new Error(`HTTP ${status} | https://nexusapi.example/api/deal-sheets/1/ | ${body}`);
  err.cause = ax;
  return err;
}

test("an HTML 403 from the edge is retried", () => {
  assert.equal(isTransientNexusError(nexusError(403, HTML_403)), true);
});

test("a JSON 403 from Nexus is NOT retried", () => {
  // A real permission decision must fail fast — retrying it just burns the run's budget.
  assert.equal(
    isTransientNexusError(
      nexusError(403, { detail: "You do not have permission to perform this action." })
    ),
    false
  );
});

test("a JSON 401 is NOT retried", () => {
  assert.equal(
    isTransientNexusError(nexusError(401, { detail: "Authentication credentials were not provided." })),
    false
  );
});

test("an empty-bodied 403 is NOT retried", () => {
  // Nothing to identify it as an edge page, so treat it as a real refusal.
  assert.equal(isTransientNexusError(nexusError(403, "")), false);
});

test("the existing transient set still retries", () => {
  for (const st of [429, 500, 502, 503, 504]) {
    assert.equal(isTransientNexusError(nexusError(st, "Service Unavailable")), true, String(st));
  }
});

test("404 and 400 stay non-transient", () => {
  assert.equal(isTransientNexusError(nexusError(404, { detail: "Not found." })), false);
  assert.equal(isTransientNexusError(nexusError(400, { detail: "bad request" })), false);
});

test("a message-only edge 403 is retried (batch fallback path)", () => {
  // nexusFetchAllJson wraps failures in a plain Error; callers downstream may only see the text.
  const err = new Error(
    `HTTP 403 Forbidden | https://nexusapi.example/api/deal-sheet-hours-details/?deal_sheet_id=1 | ${HTML_403}`
  );
  assert.equal(isTransientNexusError(err), true);
});

test("a message-only JSON 403 is not retried", () => {
  const err = new Error(
    'HTTP 403 Forbidden | https://nexusapi.example/api/deal-sheets/1/ | {"detail":"You do not have permission to perform this action."}'
  );
  assert.equal(isTransientNexusError(err), false);
});

test("network-level failures with no response are still retried", () => {
  const ax = { isAxiosError: true, message: "socket hang up", code: "ECONNRESET" };
  const err = new Error("socket hang up");
  err.cause = ax;
  assert.equal(isTransientNexusError(err), true);
});
