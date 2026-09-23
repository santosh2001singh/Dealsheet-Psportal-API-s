const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { domainWritesEnrichLogs } = require("./syncService");
const { isCynetLocumsRecruiter } = require("./locumsDerivedPlacementFields");
const { RATE_CHANGE_LOG_EXCLUDED_TABLE_IDS } = require("./bigQueryClient");

/**
 * While Locums is being validated, dealSheetSyncTriggerLocums must write ONE table —
 * cynet_locums_deal_sheet — and no log table at all. Four independent mechanisms cover that, the
 * same four Canada uses; this file asserts each one from the Locums side.
 *
 * Cynet health must be unaffected by every one of them.
 */

const LOCUMS_EMAIL = "recruiter@cynetlocums.com";
const HEALTH_EMAIL = "recruiter@cynethealth.com";

// 1. Per-row enrich logs (ch_additional_cost_logs / ch_termination_reason_logs)
test("locums does not write the per-row enrich logs", () => {
  assert.equal(domainWritesEnrichLogs({ sync_domain: "locums" }), false);
});

test("the locums check is case- and whitespace-insensitive", () => {
  for (const v of ["LOCUMS", "Locums", "  locums  "]) {
    assert.equal(domainWritesEnrichLogs({ sync_domain: v }), false, v);
  }
});

test("health keeps writing the per-row enrich logs", () => {
  assert.equal(domainWritesEnrichLogs({ sync_domain: "health" }), true);
});

// 2. Table-wide audit scans (ownership / inorganic), gated in index.js
const INDEX_SRC = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");

test("locums skips the table-wide audit-log scans", () => {
  const m = /const SYNC_DOMAINS_WITHOUT_AUDIT_LOG_SCANS = new Set\(\[([^\]]*)\]\)/.exec(INDEX_SRC);
  assert.ok(m, "SYNC_DOMAINS_WITHOUT_AUDIT_LOG_SCANS must exist");
  const domains = m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  assert.ok(domains.includes("locums"));
});

// 3. Insert-time contract-chain ownership logs, gated inside insertAll
const BQ_SRC = fs.readFileSync(path.join(__dirname, "bigQueryClient.js"), "utf8");

test("the locums log kill-switch is on", () => {
  assert.ok(/const LOG_WRITES_DISABLED_FOR_LOCUMS = true;/.test(BQ_SRC));
});

test("insert-time ownership logs filter locums rows out", () => {
  // Mirrors the filter applied in insertAll: gated on the ROW's recruiter email, so every insert
  // path (scheduled trigger, manual HTTP sync, refresh endpoint) hits the same gate.
  const rows = [
    { ASSIGNMENT_RECRUITER_EMAIL: LOCUMS_EMAIL, PLACEMENT_ID: 1 },
    { ASSIGNMENT_RECRUITER_EMAIL: HEALTH_EMAIL, PLACEMENT_ID: 2 },
    { ASSIGNMENT_RECRUITER_EMAIL: LOCUMS_EMAIL, PLACEMENT_ID: 3 },
  ];
  const kept = rows.filter((r) => !isCynetLocumsRecruiter(r.ASSIGNMENT_RECRUITER_EMAIL));
  assert.deepEqual(kept.map((r) => r.PLACEMENT_ID), [2]);
});

test("a batch of only locums rows writes no ownership logs at all", () => {
  const rows = [{ ASSIGNMENT_RECRUITER_EMAIL: LOCUMS_EMAIL }, { ASSIGNMENT_RECRUITER_EMAIL: LOCUMS_EMAIL }];
  assert.equal(rows.filter((r) => !isCynetLocumsRecruiter(r.ASSIGNMENT_RECRUITER_EMAIL)).length, 0);
});

// 4. ch_rate_change_logs — a separate scheduled function, so it is excluded by table id
test("the rate-change scan excludes both locums tables", () => {
  assert.ok(RATE_CHANGE_LOG_EXCLUDED_TABLE_IDS.has("cynet_locums_deal_sheet"));
  assert.ok(RATE_CHANGE_LOG_EXCLUDED_TABLE_IDS.has("cynet_locums_ended_deal_sheet"));
});

test("health tables stay in the rate-change scan", () => {
  assert.ok(!RATE_CHANGE_LOG_EXCLUDED_TABLE_IDS.has("cynet_health_deal_sheet"));
  assert.ok(!RATE_CHANGE_LOG_EXCLUDED_TABLE_IDS.has("cynet_health_ended_deal_sheet"));
});
