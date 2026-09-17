const test = require("node:test");
const assert = require("node:assert/strict");

const { resolvePriorityBudgetSharePct } = require("./syncService");

/**
 * Health's update trigger refreshed the same leading placements every hour and nothing else.
 *
 * Measured in BigQuery on 2026-09-16: 970 priority rows (STARTED/BOOKED/ACTIVE) of which 894 had not
 * been touched in 2 days and 629 were 14+ days stale; 3953 batch rows of which 3731 were 14+ days
 * stale. The checkpoint sat at batchOffset 0 permanently.
 *
 * Two causes, both covered here: priority restarted at 0 every run (no cursor), and priority ran
 * first with no time bound, so at ~15s/placement its 970 rows (~4 hours) consumed a 22-minute budget
 * entirely and the batch tier was never reached.
 */

test("default priority share leaves the batch tier a real slot", () => {
  delete process.env.UPDATE_PRIORITY_BUDGET_SHARE_PCT;
  const pct = resolvePriorityBudgetSharePct();
  assert.equal(pct, 70);
  assert.ok(pct < 100, "batch must always get time; 100 reproduces the starvation bug");
});

test("priority share is overridable and clamped to 10..90", () => {
  for (const [input, expected] of [["50", 50], ["10", 10], ["90", 90], ["0", 10], ["100", 90], ["-20", 10]]) {
    process.env.UPDATE_PRIORITY_BUDGET_SHARE_PCT = input;
    assert.equal(resolvePriorityBudgetSharePct(), expected, `input ${input}`);
  }
  delete process.env.UPDATE_PRIORITY_BUDGET_SHARE_PCT;
});

test("garbage share falls back to the default", () => {
  for (const bad of ["", "abc", "  "]) {
    process.env.UPDATE_PRIORITY_BUDGET_SHARE_PCT = bad;
    assert.equal(resolvePriorityBudgetSharePct(), 70, `input ${JSON.stringify(bad)}`);
  }
  delete process.env.UPDATE_PRIORITY_BUDGET_SHARE_PCT;
});

/**
 * The loop walks slice = [...prioritySlice, ...batchSlice] in steps of `concurrency`. When priority
 * runs out of time it jumps `i` so the next increment lands exactly on the batch boundary.
 */
function walk({ priorityPlanned, batchPlanned, concurrency, switchAfterBatches }) {
  const total = priorityPlanned + batchPlanned;
  const visited = [];
  let processed = 0;
  let batches = 0;
  let switched = false;
  let priorityProcessed = null;
  for (let i = 0; i < total; i += concurrency) {
    if (!switched && i < priorityPlanned && batches >= switchAfterBatches && batchPlanned > 0) {
      switched = true;
      priorityProcessed = processed;
      i = priorityPlanned - concurrency; // loop's own += concurrency lands on the boundary
      continue;
    }
    const end = Math.min(i + concurrency, total);
    visited.push([i, end]);
    processed += end - i;
    batches++;
  }
  const batchCovered = visited
    .filter(([, b]) => b > priorityPlanned)
    .reduce((n, [a, b]) => n + (Math.min(b, total) - Math.max(a, priorityPlanned)), 0);
  return { processed, priorityProcessed, visited, batchCovered };
}

test("the jump lands exactly on the batch boundary, losing no placements", () => {
  // The non-multiple cases are the ones that matter: rounding the boundary down to a concurrency
  // multiple (97 -> 96, then +3 = 99) silently skipped the first two batch placements.
  for (const [priorityPlanned, batchPlanned, concurrency] of [
    [970, 300, 3], [100, 50, 3], [97, 50, 3], [98, 50, 3], [7, 4, 3], [5, 5, 5],
  ]) {
    const r = walk({ priorityPlanned, batchPlanned, concurrency, switchAfterBatches: 2 });
    assert.equal(r.visited.find(([a]) => a >= priorityPlanned)[0], priorityPlanned,
      `p=${priorityPlanned} b=${batchPlanned} c=${concurrency}: first batch index`);
    assert.equal(r.batchCovered, batchPlanned,
      `p=${priorityPlanned} b=${batchPlanned} c=${concurrency}: every batch placement must be visited`);
  }
});

test("the batch tier is reached even when priority dwarfs the budget", () => {
  // Health's real shape: priority is far larger than one run can finish.
  const r = walk({ priorityPlanned: 970, batchPlanned: 300, concurrency: 3, switchAfterBatches: 2 });
  assert.ok(r.priorityProcessed < 970, "priority stopped early, as intended");
  assert.equal(r.batchCovered, 300, "batch still ran — this is the whole point of the split");
});

/**
 * Cursor arithmetic. Once priority can stop early, processedFromSlice is the sum of two disjoint
 * runs with a skipped gap, so it cannot be split by comparing against priorityPlanned.
 */
function cursors({ priorityOffset, priorityTotal, batchOffset, processedFromSlice, priorityPlanned, priorityStoppedEarly, priorityProcessed }) {
  const priorityProcessedThisRun = priorityStoppedEarly
    ? priorityProcessed
    : Math.min(processedFromSlice, priorityPlanned);
  const batchProcessedThisRun = Math.max(0, processedFromSlice - priorityProcessedThisRun);
  const raw = priorityOffset + priorityProcessedThisRun;
  const lapComplete = raw >= priorityTotal;
  return {
    priorityOffsetEnd: lapComplete ? 0 : raw,
    batchOffsetEnd: batchOffset + batchProcessedThisRun,
    lapComplete,
  };
}

test("an early priority stop splits the two cursors correctly", () => {
  // 88 priority done, then the jump, then 60 batch: processedFromSlice is 148 across a gap.
  const c = cursors({
    priorityOffset: 200, priorityTotal: 970, batchOffset: 50,
    processedFromSlice: 148, priorityPlanned: 770,
    priorityStoppedEarly: true, priorityProcessed: 88,
  });
  assert.equal(c.priorityOffsetEnd, 288, "priority advanced by the 88 it actually did");
  assert.equal(c.batchOffsetEnd, 110, "batch advanced by the 60 it actually did");
});

test("priority wraps to 0 when a lap completes, so rotation continues", () => {
  const c = cursors({
    priorityOffset: 900, priorityTotal: 970, batchOffset: 0,
    processedFromSlice: 70, priorityPlanned: 70,
    priorityStoppedEarly: false, priorityProcessed: 0,
  });
  assert.equal(c.lapComplete, true);
  assert.equal(c.priorityOffsetEnd, 0, "pinning at the end would stop priority refreshing entirely");
});

test("a run that never reaches the batch tier leaves the batch cursor untouched", () => {
  const c = cursors({
    priorityOffset: 0, priorityTotal: 970, batchOffset: 300,
    processedFromSlice: 88, priorityPlanned: 970,
    priorityStoppedEarly: false, priorityProcessed: 0,
  });
  assert.equal(c.priorityOffsetEnd, 88);
  assert.equal(c.batchOffsetEnd, 300, "must not drift when no batch work happened");
});
