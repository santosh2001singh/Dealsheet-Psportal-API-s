const test = require("node:test");
const assert = require("node:assert/strict");

const {
  revalidateDealContractIdAgainstRunrate,
  legacyInheritedColumnsForDealRow,
} = require("./bigQueryClient");

/**
 * Refresh-time repair for a CONTRACT_ID that stopped matching its run-rate window.
 *
 * The window is START_DATE .. COALESCE(END_DATE, TENTATIVE_END_DATE), so it SHRINKS when the
 * previous placement ends and its real END_DATE lands. A booking matched while that placement was
 * still running can then fall outside the window — see the Juan M Silva timeline below.
 */

/** Juan M Silva's DEAL: DEAL_SHEET_ID 5255548 / PLACEMENT_ID 1464679. */
function juanDeal(overrides = {}) {
  return {
    DEAL_TYPE: "DEAL",
    DEAL_SHEET_ID: 5255548,
    PLACEMENT_ID: 1464679,
    CANDIDATE_ID: 7976807,
    START_DATE: "2026-10-12",
    END_DATE: null,
    TENTATIVE_END_DATE: "2027-01-09",
    INITIAL_START_DATE: "2025-09-08",
    CONTRACT_ID: "CHC19805",
    ...overrides,
  };
}

/** CHC19805 AFTER placement 1455761 ended: 2026-06-07..2026-09-05. */
const windowAfterEnd = { __WINDOW_START_DATE: "2026-06-07", __WINDOW_END_DATE: "2026-09-05" };
/** CHC19805 BEFORE it ended: END_DATE null, so the window ran to the tentative end. */
const windowWhileRunning = { __WINDOW_START_DATE: "2026-06-07", __WINDOW_END_DATE: "2027-01-09" };

function deps({ window, newId = "CHC23516", allocSpy, windowSpy } = {}) {
  return {
    fetchWindowFn: async (id, opts) => {
      if (windowSpy) windowSpy.push({ id, opts });
      return window;
    },
    allocateFn: async (opts) => {
      if (allocSpy) allocSpy.push(opts);
      return newId;
    },
  };
}

test("Juan M Silva: once the previous placement ended, the id no longer fits and is replaced", async () => {
  const verdict = await revalidateDealContractIdAgainstRunrate(
    juanDeal(),
    { CONTRACT_ID: "CHC19805" },
    { tableId: "cynet_health_deal_sheet" },
    deps({ window: windowAfterEnd })
  );

  assert.equal(verdict.needsRepair, true);
  assert.equal(verdict.previousContractId, "CHC19805");
  assert.equal(verdict.newContractId, "CHC23516");
});

test("the same row was legitimately matched while that placement was still running", async () => {
  // END_DATE was null on 2026-08-31, so the window reached 2027-01-09 and the booking sat inside it.
  // This is why the id was not wrong when assigned — it BECAME wrong.
  const verdict = await revalidateDealContractIdAgainstRunrate(
    juanDeal(),
    null,
    { tableId: "cynet_health_deal_sheet" },
    deps({ window: windowWhileRunning })
  );

  assert.equal(verdict.needsRepair, false);
  assert.equal(verdict.newContractId, null);
});

test("the row never ends up without an id: the replacement is minted before any write", async () => {
  const allocSpy = [];
  const verdict = await revalidateDealContractIdAgainstRunrate(
    juanDeal(),
    null,
    { tableId: "cynet_health_deal_sheet" },
    deps({ window: windowAfterEnd, allocSpy })
  );

  assert.equal(allocSpy.length, 1, "one id minted");
  assert.equal(typeof verdict.newContractId, "string");
  assert.notEqual(verdict.newContractId, null);
});

test("a mint failure leaves the stored id alone rather than clearing it", async () => {
  const verdict = await revalidateDealContractIdAgainstRunrate(
    juanDeal(),
    null,
    { tableId: "cynet_health_deal_sheet" },
    {
      fetchWindowFn: async () => windowAfterEnd,
      allocateFn: async () => {
        throw new Error("Firestore unavailable");
      },
    }
  );

  assert.equal(verdict.needsRepair, false);
  assert.equal(verdict.newContractId, null);
});

test("a mint returning nothing is treated the same way", async () => {
  const verdict = await revalidateDealContractIdAgainstRunrate(
    juanDeal(),
    null,
    { tableId: "cynet_health_deal_sheet" },
    deps({ window: windowAfterEnd, newId: null })
  );
  assert.equal(verdict.needsRepair, false);
});

test("everything inherited from the wrong run-rate row is cleared, not just the id", async () => {
  const verdict = await revalidateDealContractIdAgainstRunrate(
    juanDeal(),
    null,
    { tableId: "cynet_health_deal_sheet" },
    deps({ window: windowAfterEnd })
  );

  const cleared = new Set(verdict.clearedColumns);
  // The narrative that made the bad match visible.
  assert.ok(cleared.has("COMMENTS"));
  assert.ok(cleared.has("ST_DT_PUSHBACK_REASON"));
  assert.ok(cleared.has("BACKOUT_OR_TERMINATION"));
  // The other contract's SKU and ops/credentialing setup.
  assert.ok(cleared.has("SKU_NUMBER"));
  assert.ok(cleared.has("CREDENTIALING_SPECIALIST"));
  assert.ok(cleared.has("CLIENT_RECRUITER"));
  assert.ok(cleared.has("TYPE_OF_CLIENT"));
  // INITIAL_START_DATE is reset to the row's own START_DATE by the UPDATE, never blanked.
  assert.ok(!cleared.has("INITIAL_START_DATE"));
  // And it is the full inherited set, not a hand-picked subset.
  assert.deepEqual(
    [...cleared].sort(),
    [...legacyInheritedColumnsForDealRow("all_CH_data_runrate")].sort()
  );
});

test("EXTENSION rows are never judged by this rule", async () => {
  // An extension legitimately starts after its contract's window closes.
  const windowSpy = [];
  const verdict = await revalidateDealContractIdAgainstRunrate(
    juanDeal({ DEAL_TYPE: "EXTENSION" }),
    { CONTRACT_ID: "CHC19805" },
    { tableId: "cynet_health_deal_sheet" },
    deps({ window: windowAfterEnd, windowSpy })
  );

  assert.equal(verdict.needsRepair, false);
  assert.equal(windowSpy.length, 0, "not even looked up");
});

test("the id under test comes from the baseline when the incoming row has none", async () => {
  const windowSpy = [];
  const verdict = await revalidateDealContractIdAgainstRunrate(
    juanDeal({ CONTRACT_ID: null }),
    { CONTRACT_ID: "CHC19805" },
    { tableId: "cynet_health_deal_sheet" },
    deps({ window: windowAfterEnd, windowSpy })
  );

  assert.equal(windowSpy[0].id, "CHC19805");
  assert.equal(verdict.needsRepair, true);
});

test("absent evidence never triggers a repair", async () => {
  const t = { tableId: "cynet_health_deal_sheet" };
  // No id anywhere.
  assert.equal(
    (await revalidateDealContractIdAgainstRunrate(juanDeal({ CONTRACT_ID: null }), null, t, deps({ window: windowAfterEnd }))).needsRepair,
    false
  );
  // Run-rate has no window for this id (freshly minted).
  assert.equal(
    (await revalidateDealContractIdAgainstRunrate(juanDeal(), null, t, deps({ window: null }))).needsRepair,
    false
  );
  // The row contributes no dates of its own.
  assert.equal(
    (await revalidateDealContractIdAgainstRunrate(
      juanDeal({ START_DATE: null, END_DATE: null, TENTATIVE_END_DATE: null }),
      null, t, deps({ window: windowAfterEnd })
    )).needsRepair,
    false
  );
  // A window lookup failure.
  assert.equal(
    (await revalidateDealContractIdAgainstRunrate(juanDeal(), null, t, {
      fetchWindowFn: async () => { throw new Error("BigQuery unavailable"); },
    })).needsRepair,
    false
  );
});

test("a DEAL whose own dates still fall inside the window is untouched", async () => {
  const verdict = await revalidateDealContractIdAgainstRunrate(
    juanDeal({ START_DATE: "2026-06-07", TENTATIVE_END_DATE: "2026-09-05" }),
    null,
    { tableId: "cynet_health_deal_sheet" },
    deps({ window: windowAfterEnd })
  );
  assert.equal(verdict.needsRepair, false);
});
