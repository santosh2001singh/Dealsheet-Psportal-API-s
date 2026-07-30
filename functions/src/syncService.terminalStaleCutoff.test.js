const test = require("node:test");
const assert = require("node:assert/strict");

const { filterStaleTerminalBatchTargets } = require("./syncService");

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-24T12:00:00Z");

const target = (status, daysAgo, over = {}) => ({
  deal_sheet_id: `ds-${status}-${daysAgo}`,
  placement_id: null,
  table_id: "tbl",
  placement_status: status,
  latest_date_ms: daysAgo == null ? null : NOW - daysAgo * DAY_MS,
  ...over,
});

test("terminal statuses older than cutoff are dropped", () => {
  const batch = [
    target("ENDED", 21),
    target("ENDED<30", 25),
    target("DID NOT START", 30),
    target("DID NOT ACCEPT", 40),
  ];
  const { kept, staleSkipped } = filterStaleTerminalBatchTargets(batch, {
    cutoffDays: 20,
    nowMs: NOW,
  });
  assert.equal(kept.length, 0);
  assert.equal(staleSkipped, 4);
});

test("terminal statuses within cutoff window are kept", () => {
  const batch = [
    target("ENDED", 5),
    target("DID NOT START", 19),
    target("DID NOT ACCEPT", 0),
  ];
  const { kept, staleSkipped } = filterStaleTerminalBatchTargets(batch, {
    cutoffDays: 20,
    nowMs: NOW,
  });
  assert.equal(kept.length, 3);
  assert.equal(staleSkipped, 0);
});

test("terminal status with null latest_date_ms is kept (safe)", () => {
  const batch = [target("ENDED", null)];
  const { kept, staleSkipped } = filterStaleTerminalBatchTargets(batch, {
    cutoffDays: 20,
    nowMs: NOW,
  });
  assert.equal(kept.length, 1);
  assert.equal(staleSkipped, 0);
});

test("non-terminal (unknown) batch status is kept even when old", () => {
  const batch = [target("OFFERED", 100), target("SOMETHING", 365)];
  const { kept, staleSkipped } = filterStaleTerminalBatchTargets(batch, {
    cutoffDays: 20,
    nowMs: NOW,
  });
  assert.equal(kept.length, 2);
  assert.equal(staleSkipped, 0);
});

test("cutoffDays = 0 disables filtering", () => {
  const batch = [target("ENDED", 100), target("DID NOT ACCEPT", 200)];
  const { kept, staleSkipped } = filterStaleTerminalBatchTargets(batch, {
    cutoffDays: 0,
    nowMs: NOW,
  });
  assert.equal(kept.length, 2);
  assert.equal(staleSkipped, 0);
});

test("mixed batch: only old terminal ones dropped, others kept", () => {
  const batch = [
    target("ENDED", 30), // drop
    target("ENDED", 3), // keep (recent)
    target("DID NOT START", null), // keep (no date)
    target("OFFERED", 300), // keep (not terminal)
  ];
  const { kept, staleSkipped } = filterStaleTerminalBatchTargets(batch, {
    cutoffDays: 20,
    nowMs: NOW,
  });
  assert.equal(staleSkipped, 1);
  assert.equal(kept.length, 3);
  assert.ok(!kept.some((t) => t.placement_status === "ENDED" && t.latest_date_ms === NOW - 30 * DAY_MS));
});
