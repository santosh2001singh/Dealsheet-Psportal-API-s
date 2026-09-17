const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveUpdateLoopBudgetMs } = require("./syncService");

/**
 * The update trigger used to be killed by Cloud Run's 1800s timeout every hour (2026-09-15/16):
 * SIGKILL raises no exception, so no catch ran, no checkpoint was written, and the logs just stopped
 * mid-line. Because the checkpoint never advanced, each run restarted at the same offset and re-did
 * the same placements forever.
 *
 * The loop now stops on its own wall-clock budget instead. These tests pin the two things that make
 * that safe: the budget can never exceed the function timeout, and a budget-stopped run must not be
 * mistaken for a completed pass.
 */

test("default budget leaves room under the 1800s function timeout", () => {
  delete process.env.UPDATE_LOOP_BUDGET_MS;
  const ms = resolveUpdateLoopBudgetMs();
  assert.equal(ms, 1320000, "default is 22 minutes");
  assert.ok(ms < 1800 * 1000, "must be under the function timeout");
  // The remainder has to cover the checkpoint write AND the audit-log scans that run after the loop.
  assert.ok(1800 * 1000 - ms >= 7 * 60 * 1000, "at least ~7 min of margin after the loop");
});

test("UPDATE_LOOP_BUDGET_MS overrides the default", () => {
  process.env.UPDATE_LOOP_BUDGET_MS = "600000";
  assert.equal(resolveUpdateLoopBudgetMs(), 600000);
  delete process.env.UPDATE_LOOP_BUDGET_MS;
});

test("a budget above the function timeout is clamped, never honoured", () => {
  // Honouring this would reinstate the SIGKILL: the loop would still be running at 1800s.
  process.env.UPDATE_LOOP_BUDGET_MS = "3600000";
  const ms = resolveUpdateLoopBudgetMs();
  assert.ok(ms <= 1800 * 1000 * 0.9, `clamped to 90% of timeout, got ${ms}`);
  delete process.env.UPDATE_LOOP_BUDGET_MS;
});

test("garbage and non-positive values fall back to the default", () => {
  for (const bad of ["", "abc", "0", "-5", "  "]) {
    process.env.UPDATE_LOOP_BUDGET_MS = bad;
    assert.equal(resolveUpdateLoopBudgetMs(), 1320000, `input ${JSON.stringify(bad)}`);
  }
  delete process.env.UPDATE_LOOP_BUDGET_MS;
});

/**
 * The checkpoint offset must reflect what the run actually processed.
 *
 * slice = [...priorityTargets, ...batchSlice] and priority always runs first, so batch progress is
 * whatever was processed beyond the priority tier. Advancing by batchSlice.length (the old
 * behaviour) on a partial run would skip every placement the run never reached — they would sit
 * un-refreshed until the pass wrapped all the way around.
 */
function batchOffsetEndFor({ batchOffset, processedFromSlice, priorityPlanned }) {
  const batchProcessedThisRun = Math.max(0, processedFromSlice - priorityPlanned);
  return batchOffset + batchProcessedThisRun;
}

test("a full run advances the batch offset by the whole batch slice", () => {
  // 40 priority + 100 batch, all processed.
  assert.equal(
    batchOffsetEndFor({ batchOffset: 200, processedFromSlice: 140, priorityPlanned: 40 }),
    300
  );
});

test("a budget-stopped run advances only by the batch work it really did", () => {
  // Same run, but the budget hit after 90 of the 140 planned: 40 priority + 50 batch.
  assert.equal(
    batchOffsetEndFor({ batchOffset: 200, processedFromSlice: 90, priorityPlanned: 40 }),
    250,
    "must not claim the full 100-wide batch slice"
  );
});

test("stopping inside the priority tier does not advance the batch offset at all", () => {
  // A priority tier large enough to eat the whole budget: no batch work happened.
  assert.equal(
    batchOffsetEndFor({ batchOffset: 200, processedFromSlice: 25, priorityPlanned: 40 }),
    200
  );
});

/**
 * Deleting the checkpoint means "pass complete, restart from 0 next run". A run stopped by its
 * budget has not completed anything — and when it stopped inside the priority tier with batchTotal
 * 0, hasMore is false, which is exactly the shape that would have triggered the delete.
 */
function shouldDeleteCheckpoint({ hasMore, clearOnComplete, budgetExhausted }) {
  return !hasMore && clearOnComplete && !budgetExhausted;
}

test("a completed pass clears its checkpoint", () => {
  assert.equal(
    shouldDeleteCheckpoint({ hasMore: false, clearOnComplete: true, budgetExhausted: false }),
    true
  );
});

test("a budget-stopped run keeps its checkpoint even when hasMore is false", () => {
  assert.equal(
    shouldDeleteCheckpoint({ hasMore: false, clearOnComplete: true, budgetExhausted: true }),
    false,
    "deleting here would restart the pass from 0 and lose all progress"
  );
});
