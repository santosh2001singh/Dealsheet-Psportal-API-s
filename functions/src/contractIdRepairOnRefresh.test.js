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

// ---------------------------------------------------------------------------------------------
// Own run-rate rows excluded from the window (Nov 2026). Jacob Mauro Dominguez, PLACEMENT_ID
// 1469558: a DID NOT ACCEPT DEAL whose job start moved 11-16 -> 11-30 -> 12-14. Its only run-rate
// row was its own approved copy (11-16..11-16), so every move minted a new id.
// ---------------------------------------------------------------------------------------------
const { buildRunrateWindowForContractIdSql } = require("./bigQueryClient");

test("revalidate passes the placement id so its own run-rate rows are left out of the window", async () => {
  const windowSpy = [];
  await revalidateDealContractIdAgainstRunrate(
    juanDeal(),
    { CONTRACT_ID: "CHC19805" },
    { tableId: "cynet_health_deal_sheet" },
    deps({ window: windowAfterEnd, windowSpy })
  );
  assert.equal(windowSpy.length, 1);
  assert.equal(String(windowSpy[0].opts.excludePlacementId), "1464679");
  assert.equal(windowSpy[0].opts.tableId, "cynet_health_deal_sheet");
});

test("DNA DEAL whose only run-rate rows are its own: no window -> id kept", async () => {
  // With its own rows excluded the contract has no other rows, so the fetch returns null.
  const allocSpy = [];
  const verdict = await revalidateDealContractIdAgainstRunrate(
    {
      DEAL_TYPE: "DEAL",
      DEAL_SHEET_ID: 5270166,
      PLACEMENT_ID: 1469558,
      PLACEMENT_STATUS: "DID NOT ACCEPT",
      START_DATE: "2026-12-14",
      END_DATE: "2026-12-14",
      TENTATIVE_END_DATE: null,
      CONTRACT_ID: "CHC23736",
    },
    { CONTRACT_ID: "CHC23736", PLACEMENT_ID: 1469558 },
    { tableId: "cynet_health_deal_sheet" },
    deps({ window: null, allocSpy })
  );
  assert.equal(verdict.needsRepair, false);
  assert.equal(allocSpy.length, 0);
});

test("window SQL: own placement excluded, legacy rows (PLACEMENT_ID NULL) always kept", () => {
  const sql = buildRunrateWindowForContractIdSql("CHC23736", {
    datasetId: "rr_project_data",
    runrateTableId: "all_CH_data_runrate",
    excludePlacementId: 1469558,
  });
  assert.match(sql, /AND \(PLACEMENT_ID IS NULL OR CAST\(PLACEMENT_ID AS STRING\) != '1469558'\)/);
  assert.match(sql, /'CHC23736'/);
});

test("window SQL without a placement id is the old query (no placement filter)", () => {
  const sql = buildRunrateWindowForContractIdSql("CHC19805", {
    datasetId: "rr_project_data",
    runrateTableId: "all_CH_data_runrate",
  });
  assert.doesNotMatch(sql.slice(sql.indexOf("WHERE")), /PLACEMENT_ID/);
  assert.match(sql, /COALESCE\(END_DATE, TENTATIVE_END_DATE\) IS NOT NULL\s*$/);
});

// ---------------------------------------------------------------------------------------------
// Chain overwrite / DNA-DNS / preview (Nov 2026). Christina Leifried: DEAL 1451239 (04-20..10-17)
// on CHC21832; extension 1470918 was approved on the same id and RR overwrote the run-rate row, so
// the window became the extension's. The DEAL was re-minted to CHC24281 (21 DEALs like this).
// ---------------------------------------------------------------------------------------------
const { isEarlierLinkOfSameChain } = require("./bigQueryClient");

function chainDeal(overrides = {}) {
  return {
    DEAL_TYPE: "DEAL",
    DEAL_SHEET_ID: 5185994,
    PLACEMENT_ID: 1451239,
    PLACEMENT_STATUS: "ENDED",
    START_DATE: "2026-04-20",
    END_DATE: "2026-10-17",
    TENTATIVE_END_DATE: "2026-10-17",
    CONTRACT_ID: "CHC21832",
    ...overrides,
  };
}

test("chain: DEAL before a window built from a later placement's row keeps its id", async () => {
  const allocSpy = [];
  const verdict = await revalidateDealContractIdAgainstRunrate(
    chainDeal(),
    { CONTRACT_ID: "CHC21832" },
    { tableId: "cynet_health_deal_sheet" },
    deps({
      window: { __WINDOW_START_DATE: "2026-10-18", __WINDOW_END_DATE: "2026-12-12", __HAS_PLACEMENT_ROWS: true },
      allocSpy,
    })
  );
  assert.equal(verdict.needsRepair, false);
  assert.equal(allocSpy.length, 0);
});

test("chain: back-to-back continuation (starts the day after the window ends) keeps its id", async () => {
  // Darcia Tooafoo-Cruickshank 1452502: Apr-1 rebook after CHC20946 ended 03-31.
  const verdict = await revalidateDealContractIdAgainstRunrate(
    chainDeal({ PLACEMENT_ID: 1452502, START_DATE: "2026-04-01", END_DATE: "2026-04-04", TENTATIVE_END_DATE: "2026-04-04", CONTRACT_ID: "CHC20946" }),
    null,
    { tableId: "cynet_health_deal_sheet" },
    deps({ window: { __WINDOW_START_DATE: "2026-01-05", __WINDOW_END_DATE: "2026-03-31", __HAS_PLACEMENT_ROWS: true } })
  );
  assert.equal(verdict.needsRepair, false);
});

test("Juan M Silva is still re-minted: a booking weeks after the window ends is a new contract", async () => {
  const verdict = await revalidateDealContractIdAgainstRunrate(
    juanDeal(),
    { CONTRACT_ID: "CHC19805" },
    { tableId: "cynet_health_deal_sheet" },
    deps({ window: { ...windowAfterEnd, __HAS_PLACEMENT_ROWS: true } })
  );
  assert.equal(verdict.needsRepair, true);
  assert.equal(verdict.newContractId, "CHC23516");
});

test("data-team-only window keeps the old rule (no chain exemption)", async () => {
  const verdict = await revalidateDealContractIdAgainstRunrate(
    chainDeal(),
    { CONTRACT_ID: "CHC21832" },
    { tableId: "cynet_health_deal_sheet" },
    deps({ window: { __WINDOW_START_DATE: "2026-10-18", __WINDOW_END_DATE: "2026-12-12", __HAS_PLACEMENT_ROWS: false } })
  );
  assert.equal(verdict.needsRepair, true);
});

for (const status of ["DID NOT ACCEPT", "DID NOT START"]) {
  test(`${status} DEAL is never revalidated`, async () => {
    const windowSpy = [];
    const allocSpy = [];
    const verdict = await revalidateDealContractIdAgainstRunrate(
      chainDeal({ PLACEMENT_STATUS: status, START_DATE: "2026-03-30", END_DATE: "2026-03-30" }),
      null,
      { tableId: "cynet_health_deal_sheet" },
      deps({ window: { __WINDOW_START_DATE: "2026-03-16", __WINDOW_END_DATE: "2026-03-16" }, windowSpy, allocSpy })
    );
    assert.equal(verdict.needsRepair, false);
    assert.equal(windowSpy.length, 0);
    assert.equal(allocSpy.length, 0);
  });
}

test("preview reports the repair without minting an id", async () => {
  const allocSpy = [];
  const verdict = await revalidateDealContractIdAgainstRunrate(
    juanDeal(),
    { CONTRACT_ID: "CHC19805" },
    { tableId: "cynet_health_deal_sheet" },
    { ...deps({ window: windowAfterEnd, allocSpy }), previewOnly: true }
  );
  assert.equal(verdict.needsRepair, true);
  assert.equal(verdict.newContractId, null);
  assert.equal(allocSpy.length, 0);
});

test("isEarlierLinkOfSameChain edges", () => {
  const w = { __WINDOW_START_DATE: "2026-05-01", __WINDOW_END_DATE: "2026-08-31" };
  assert.equal(isEarlierLinkOfSameChain({ startDate: "2026-01-01", endDate: "2026-04-30" }, w), true);
  assert.equal(isEarlierLinkOfSameChain({ startDate: "2026-09-01" }, w), true);
  assert.equal(isEarlierLinkOfSameChain({ startDate: "2026-09-02" }, w), false);
  assert.equal(isEarlierLinkOfSameChain({ startDate: "2026-04-01", endDate: "2026-09-10" }, w), false);
  assert.equal(isEarlierLinkOfSameChain({}, w), false);
});

test("window SQL reports whether system (placement) rows are in the window", () => {
  const sql = buildRunrateWindowForContractIdSql("CHC21832", {
    datasetId: "rr_project_data",
    runrateTableId: "all_CH_data_runrate",
    excludePlacementId: 1451239,
  });
  assert.match(sql, /COUNTIF\(PLACEMENT_ID IS NOT NULL\) AS placement_row_count/);
});
