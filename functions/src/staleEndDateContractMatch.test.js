const test = require("node:test");
const assert = require("node:assert/strict");

const { buildLegacyContractLookupKey, runrateEntryForResolvedContract } = require("./bigQueryClient");
const { applyLegacyContractIdentityToDealRows } = require("./contractIdResolver");

// Live case (CANDIDATE_ID 25280540 "Melody Bonongwe", Sep 2026): extension 1454462 started
// 2026-06-22 but Nexus carried the previous assignment's TENTATIVE_END_DATE 2026-05-16. That stale
// date sat inside the old contract's window (CHC18029) and the row took the old contract; the new
// one is CHC22056 (run-rate 2026-06-24..2026-09-19, same INTERNAL_JOB_ID 35431600).
const melody = (over = {}) => ({
  DEAL_SHEET_ID: "5200261",
  PLACEMENT_ID: "1454462",
  DEAL_TYPE: "EXTENSION",
  CANDIDATE_ID: "25280540",
  CANDIDATE_EMAIL: "mbonongwe41@gmail.com",
  INTERNAL_JOB_ID: "35431600",
  FACILITY_NAME: "Union Hospital Clinton",
  PARENT_CLIENT_NAME: "Union Health - ML",
  CLIENT_ID: "1448683",
  NEXUS_PARENT_CLIENT_ID: "2542959",
  START_DATE: "2026-06-22",
  TENTATIVE_END_DATE: "2026-05-16",
  END_DATE: null,
  ...over,
});

test("an end date before the row's own start is not used as a window probe", () => {
  const key = buildLegacyContractLookupKey(melody());
  assert.equal(key.spanKey.startDate, "2026-06-22");
  assert.equal(key.spanKey.tentativeEndDate, "");
  assert.equal(key.spanKey.endDate, "");
});

test("end dates on or after the start are kept", () => {
  const key = buildLegacyContractLookupKey(
    melody({ TENTATIVE_END_DATE: "2026-09-19", END_DATE: "2026-06-22" })
  );
  assert.equal(key.spanKey.tentativeEndDate, "2026-09-19");
  assert.equal(key.spanKey.endDate, "2026-06-22");
});

test("the job-id tier stays available for the stale-date row", () => {
  assert.equal(buildLegacyContractLookupKey(melody()).nexusKey, "25280540|35431600");
});

test("run-rate backfill entry for a different contract is ignored", () => {
  const entry = { CONTRACT_ID: "CHC18029", SKU_NUMBER: "H12951", INITIAL_START_DATE: "2025-05-11" };
  assert.equal(runrateEntryForResolvedContract({ CONTRACT_ID: "CHC22056", SKU_NUMBER: "H15300" }, entry), null);
  assert.equal(runrateEntryForResolvedContract({ SKU_NUMBER: "H15300" }, { SKU_NUMBER: "H12951" }), null);
});

test("run-rate backfill entry for the same contract, or an unresolved row, is kept", () => {
  const entry = { CONTRACT_ID: "CHC22056", SKU_NUMBER: "H15300" };
  assert.equal(runrateEntryForResolvedContract({ CONTRACT_ID: "chc22056" }, entry), entry);
  assert.equal(runrateEntryForResolvedContract({}, entry), entry);
  assert.equal(runrateEntryForResolvedContract({ CONTRACT_ID: "CHC22056" }, undefined), undefined);
});

test("initial start after the row's own start falls back to the row's start when empty", async () => {
  const row = melody({ TENTATIVE_END_DATE: "2026-09-19", INITIAL_START_DATE: null, CONTRACT_ID: null });
  const identity = { CONTRACT_ID: "CHC22056", SKU_NUMBER: "H15300", INITIAL_START_DATE: "2026-06-24" };
  await applyLegacyContractIdentityToDealRows([row], {
    tableId: "cynet_health_deal_sheet",
    fetchLegacyContractIdentityFn: async () => new Map([["ds:5200261", identity]]),
  });
  assert.equal(row.CONTRACT_ID, "CHC22056");
  assert.equal(row.INITIAL_START_DATE, "2026-06-22");
});

test("an existing initial start is left alone when the proposal is later than the row", async () => {
  const row = melody({ TENTATIVE_END_DATE: "2026-09-19", INITIAL_START_DATE: "2026-06-01", CONTRACT_ID: null });
  const identity = { CONTRACT_ID: "CHC22056", SKU_NUMBER: "H15300", INITIAL_START_DATE: "2026-06-24" };
  await applyLegacyContractIdentityToDealRows([row], {
    tableId: "cynet_health_deal_sheet",
    fetchLegacyContractIdentityFn: async () => new Map([["ds:5200261", identity]]),
  });
  assert.equal(row.INITIAL_START_DATE, "2026-06-01");
});
