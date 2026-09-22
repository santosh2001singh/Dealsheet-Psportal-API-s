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
  },
];

for (const { label, fn, alias } of TIERS) {
  test(`${label}: the source must carry the row's own resolved CONTRACT_ID`, async () => {
    const [sql] = await captureSql(() =>
      fn([UNRESOLVED_EXTENSION_ROW], { tableId: "cynet_health_deal_sheet" })
    );

    assert.match(
      sql,
      /AND ext\.resolved_contract_id != ''/,
      "an unresolved row must inherit nothing, not fall through the guard"
    );
    assert.match(
      sql,
      new RegExp(`AND ${alias}\\.CONTRACT_ID = ext\\.resolved_contract_id`),
      "the source's contract must match the row's own"
    );
    // The pre-fix form: '' disabled the guard on exactly the brand-new rows that needed it.
    assert.ok(
      !new RegExp(
        `\\(ext\\.resolved_contract_id = '' OR ${alias}\\.CONTRACT_ID = ext\\.resolved_contract_id\\)`
      ).test(sql),
      "the inert \"'' OR id\" form must not come back"
    );
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
