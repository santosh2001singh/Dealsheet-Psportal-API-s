/**
 * Contract guard on the identity-only EXTENSION inherit tiers.
 *
 * Both tiers match on CANDIDATE_ID + email + phone + CLIENT_ID, which is IDENTICAL across a
 * candidate's successive contracts at one client, and their date guard only rejects sources that
 * start AFTER the extension. A PREVIOUS, already-ended contract predates the extension and sailed
 * straight through. The id comparison meant to catch it was written as
 * `resolved_contract_id = '' OR <id match>`, which went inert on exactly the rows that needed it —
 * a brand-new extension has no CONTRACT_ID yet, so '' disabled the guard entirely.
 *
 * Live case (CANDIDATE_ID 21472994, Sep 2026): CHC18361 ran 2025-05-07 to 2026-05-07; its
 * replacement CHC22011 started 2026-06-17. CHC22011's extensions inherited CHC18361's
 * INITIAL_START_DATE, BACKOUT_OR_TERMINATION ("Termination - Contract Ended", on a contract that is
 * still running), COMMENTS and ST_DT_PUSHBACK_REASON.
 *
 * The guard now REQUIRES a resolved id and an exact match, so an unresolved row inherits nothing
 * here and waits for backfillExtensionParentInherit, which runs post-sync when the id is known.
 * These tests pin that, and pin that no date- or job-id-based proxy for "same contract" comes back:
 * every one of them is an estimate. A date gap picks an arbitrary cutoff and wrongly rejects a
 * genuine extension that resumed after a long break; a job id identifies a POSTING, not a contract.
 *
 * The SQL is captured by stubbing the BigQuery client, so these assert what the tiers actually send.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const bqLib = require("@google-cloud/bigquery");

/** Every query string the module sends while `fn` runs. */
async function captureSql(fn) {
  const captured = [];
  const original = bqLib.BigQuery.prototype.query;
  bqLib.BigQuery.prototype.query = async function (opts) {
    captured.push(typeof opts === "string" ? opts : opts.query);
    return [[]];
  };
  try {
    await fn();
  } finally {
    bqLib.BigQuery.prototype.query = original;
  }
  return captured;
}

const {
  fetchExtensionParentDealInheritByPlacementId,
  fetchExtensionPriorExtensionInheritByPlacementId,
} = require("./bigQueryClient");

/** The Lorena row: a CHC22011 extension that has not been assigned its CONTRACT_ID yet. */
const UNRESOLVED_EXTENSION_ROW = {
  PLACEMENT_ID: 1453556,
  CANDIDATE_ID: 21472994,
  CLIENT_ID: 2205827,
  CANDIDATE_EMAIL: "lmartinez8610@gmail.com",
  CELL_PHONE: "(786) 602-0197",
  START_DATE: "2026-06-17",
  CONTRACT_ID: null,
};

const TIERS = [
  {
    label: "parent-DEAL tier",
    fn: fetchExtensionParentDealInheritByPlacementId,
    alias: "d",
  },
  {
    label: "prior-EXTENSION tier",
    fn: fetchExtensionPriorExtensionInheritByPlacementId,
    alias: "p",
    // This tier also accepts SKU_NUMBER as the identity of a row that has no id yet. See the
    // dedicated tests below for why, and for what that arm must NOT let through.
    skuFallback: true,
  },
];

for (const { label, fn, alias, skuFallback } of TIERS) {
  test(`${label}: the source must carry the row's own resolved CONTRACT_ID`, async () => {
    const [sql] = await captureSql(() =>
      fn([UNRESOLVED_EXTENSION_ROW], { tableId: "cynet_health_deal_sheet" })
    );

    assert.match(
      sql,
      new RegExp(`${alias}\\.CONTRACT_ID = ext\\.resolved_contract_id`),
      "the source's contract must match the row's own"
    );
    assert.match(
      sql,
      /ext\.resolved_contract_id != ''/,
      "the id arm must require a resolved id, never treat '' as a match"
    );
    // The pre-fix form: '' disabled the guard on exactly the brand-new rows that needed it.
    assert.ok(
      !new RegExp(
        `\\(ext\\.resolved_contract_id = '' OR ${alias}\\.CONTRACT_ID = ext\\.resolved_contract_id\\)`
      ).test(sql),
      "the inert \"'' OR id\" form must not come back"
    );
    if (!skuFallback) {
      // The struct is shared, so resolved_sku_number appears in every tier's SQL. What must not
      // appear here is the GUARD arm that acts on it: this tier keeps the strict rule — no id,
      // no inherit.
      assert.ok(
        !new RegExp(`${alias}\\.SKU_NUMBER = ext\\.resolved_sku_number`).test(sql),
        "only the prior-EXTENSION tier may fall back to SKU_NUMBER"
      );
    }
  });

  test(`${label}: "same contract" is never inferred from dates`, async () => {
    const [sql] = await captureSql(() =>
      fn([UNRESOLVED_EXTENSION_ROW], { tableId: "cynet_health_deal_sheet" })
    );
    // A gap cutoff is a guess in both directions: it lets a replaced contract through when the
    // break is short, and rejects a genuine extension that resumed after a long one.
    assert.ok(!/DATE_SUB\(ext\.extension_start_date/.test(sql), "no date-gap window");
    assert.ok(!/INTERVAL \d+ DAY/.test(sql), "no day-count interval");
    assert.ok(
      !new RegExp(`COALESCE\\(${alias}\\.END_DATE, ${alias}\\.TENTATIVE_END_DATE\\)`).test(sql),
      "no contract-continuity end-date comparison"
    );
  });

  test(`${label}: "same contract" is never inferred from a job id`, async () => {
    const [sql] = await captureSql(() =>
      fn([UNRESOLVED_EXTENSION_ROW], { tableId: "cynet_health_deal_sheet" })
    );
    // VMS_JOB_ID / INTERNAL_JOB_ID identify a POSTING. One posting can carry several candidates,
    // and one contract can be re-posted, so neither separates a candidate's contracts.
    assert.ok(
      !new RegExp(`${alias}\\.VMS_JOB_ID\\s*=`).test(sql),
      "VMS_JOB_ID must not be used as a contract key"
    );
    assert.ok(
      !new RegExp(`${alias}\\.INTERNAL_JOB_ID\\s*=`).test(sql),
      "INTERNAL_JOB_ID must not be used as a contract key"
    );
  });

  test(`${label}: the date guard still rejects a source starting after the extension`, async () => {
    const [sql] = await captureSql(() =>
      fn([UNRESOLVED_EXTENSION_ROW], { tableId: "cynet_health_deal_sheet" })
    );
    // Removing the gap window must not take the original forward-looking guard with it.
    assert.match(
      sql,
      new RegExp(`${alias}\\.START_DATE <= ext\\.extension_start_date`),
      "a source that starts after the extension is still never its parent"
    );
  });
}

/**
 * The SKU arm of the prior-EXTENSION guard.
 *
 * Requiring a resolved CONTRACT_ID alone shut this tier for the one chain shape it exists to serve:
 * a contract that only ever appears as EXTENSION rows (no DEAL row anywhere), whose next segment
 * starts after a gap so the run-rate window cannot place it either. Every tier missed, and the row
 * minted a second id for a contract that already had one.
 *
 * Live case (CANDIDATE_ID 16009590 "Ashley Saunders", PLACEMENT_ID 1469883, Sep 2026): CHC20745 ran
 * as four EXTENSION segments on SKU H14126 from 2025-11-24. The fourth began 2026-09-21 — nine days
 * after the third ended 2026-09-12 — and came out as CHC23663 with INITIAL_START_DATE reset to its
 * own start.
 *
 * SKU_NUMBER is per-contract, so it draws the same line CONTRACT_ID would; it is simply available
 * earlier, since the legacy run-rate lookup fills it on EXTENSION rows before this tier runs.
 */

/** Ashley's fourth segment: no id yet, but the chain's SKU already on the row. */
const SKU_ONLY_EXTENSION_ROW = {
  PLACEMENT_ID: 1469883,
  CANDIDATE_ID: 16009590,
  CLIENT_ID: 3640336,
  CANDIDATE_EMAIL: "anmitchell30@gmail.com",
  CELL_PHONE: "(336) 420-0180",
  START_DATE: "2026-09-21",
  CONTRACT_ID: null,
  SKU_NUMBER: "H14126",
};

test("prior-EXTENSION tier: an unresolved row falls back to its SKU, so an EXTENSION-only chain stays on one contract", async () => {
  const [sql] = await captureSql(() =>
    fetchExtensionPriorExtensionInheritByPlacementId([SKU_ONLY_EXTENSION_ROW], {
      tableId: "cynet_health_deal_sheet",
    })
  );

  assert.match(
    sql,
    /ext\.resolved_contract_id = ''\s*\n?\s*AND ext\.resolved_sku_number != ''/,
    "the SKU arm engages only where the id is still blank"
  );
  assert.match(
    sql,
    /p\.SKU_NUMBER = ext\.resolved_sku_number/,
    "the source's SKU must match the row's own"
  );
});

test("prior-EXTENSION tier: the row's SKU reaches the query", async () => {
  const [sql] = await captureSql(() =>
    fetchExtensionPriorExtensionInheritByPlacementId([SKU_ONLY_EXTENSION_ROW], {
      tableId: "cynet_health_deal_sheet",
    })
  );
  assert.match(sql, /'H14126' AS resolved_sku_number/, "SKU_NUMBER must be carried in the struct");
});

test("prior-EXTENSION tier: a row with NO sku and no id still inherits nothing", async () => {
  const [sql] = await captureSql(() =>
    fetchExtensionPriorExtensionInheritByPlacementId([UNRESOLVED_EXTENSION_ROW], {
      tableId: "cynet_health_deal_sheet",
    })
  );
  // Both arms are unsatisfiable for this row: no id, and '' never equals a real SKU. The Lorena
  // case (CHC22011 taking ended CHC18361's detail) therefore stays blocked.
  assert.match(sql, /'' AS resolved_sku_number/, "an absent SKU is an empty string, never NULL");
  assert.match(
    sql,
    /ext\.resolved_sku_number != ''/,
    "a blank SKU must not satisfy the fallback arm"
  );
});

test("prior-EXTENSION tier: the SKU arm cannot fire on a row that already has an id", async () => {
  const [sql] = await captureSql(() =>
    fetchExtensionPriorExtensionInheritByPlacementId(
      [{ ...SKU_ONLY_EXTENSION_ROW, CONTRACT_ID: "CHC20745" }],
      { tableId: "cynet_health_deal_sheet" }
    )
  );
  // A resolved row is judged by its id alone — the SKU arm is gated on resolved_contract_id = ''.
  assert.match(sql, /'CHC20745' AS resolved_contract_id/);
  assert.match(
    sql,
    /ext\.resolved_contract_id = ''\s*\n?\s*AND ext\.resolved_sku_number != ''/,
    "the SKU arm stays gated on an unresolved id"
  );
});

test("prior-EXTENSION tier: SKU is a contract key, never a substitute for the identity join", async () => {
  const [sql] = await captureSql(() =>
    fetchExtensionPriorExtensionInheritByPlacementId([SKU_ONLY_EXTENSION_ROW], {
      tableId: "cynet_health_deal_sheet",
    })
  );
  // The 4-field identity and the forward-date guard both still apply on top of the SKU arm.
  assert.match(sql, /p\.CANDIDATE_ID = ext\.candidate_nexus_id/);
  assert.match(sql, /p\.CLIENT_ID = ext\.client_id/);
  assert.match(sql, /p\.START_DATE <= ext\.extension_start_date/);
});
