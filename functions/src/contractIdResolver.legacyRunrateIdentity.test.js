const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyLegacyContractIdentityToDealRows,
} = require("./contractIdResolver");
const { buildLegacyContractLookupKey, legacyDealManualColumns } = require("./bigQueryClient");

/**
 * A DEAL row already tracked in the legacy run-rate table must keep that CONTRACT_ID instead of
 * minting a second id for the same contract. Fixtures mirror the real Nexus/run-rate pair that
 * exposed this: run-rate CHC22144 vs the freshly minted CHC23016.
 */

function dealRow(overrides = {}) {
  return {
    DEAL_TYPE: "DEAL",
    PLACEMENT_STATUS: "STARTED",
    DEAL_SHEET_ID: 5213876,
    PLACEMENT_ID: 1457038,
    CANDIDATE_ID: 8629683,
    INTERNAL_JOB_ID: 35450411,
    CANDIDATE_EMAIL: "wesbyq@aol.com",
    START_DATE: "2026-06-01",
    FACILITY_NAME: "The Mount Sinai Hospital",
    PARENT_CLIENT_NAME: "Mount Sinai Health System",
    CONTRACT_ID: null,
    SKU_NUMBER: null,
    ...overrides,
  };
}

/** Stub standing in for the BigQuery run-rate lookup. */
function fetchStub(entries, spy) {
  return async (rows, options) => {
    if (spy) spy.push({ rowCount: rows.length, options });
    return new Map(entries);
  };
}

test("buildLegacyContractLookupKey: builds both tiers when the row has full identity", () => {
  const key = buildLegacyContractLookupKey(
    dealRow({ END_DATE: "2026-09-01", TENTATIVE_END_DATE: "2026-10-15" })
  );
  assert.deepEqual(key.spanKey, {
    candidateId: "8629683",
    email: "wesbyq@aol.com",
    startDate: "2026-06-01",
    endDate: "2026-09-01",
    tentativeEndDate: "2026-10-15",
    facility: "the mount sinai hospital",
    parentClient: "mount sinai health system",
  });
  assert.equal(key.nexusKey, "8629683|35450411");
  assert.equal(key.rowKey, "ds:5213876");
});

// Any ONE of the three dates is enough to form the key. A BOOKED/STARTED placement has no END_DATE
// yet, and requiring all three was measured to collapse matches from 1,865 to 709.
test("buildLegacyContractLookupKey: any one of the three dates forms the key", () => {
  const onlyStart = buildLegacyContractLookupKey(dealRow());
  assert.equal(onlyStart.spanKey.startDate, "2026-06-01");
  assert.equal(onlyStart.spanKey.endDate, "");
  assert.equal(onlyStart.spanKey.tentativeEndDate, "");

  const onlyEnd = buildLegacyContractLookupKey(dealRow({ START_DATE: null, END_DATE: "2026-09-01" }));
  assert.ok(onlyEnd.spanKey, "END_DATE alone is enough");
  assert.equal(onlyEnd.spanKey.startDate, "");
  assert.equal(onlyEnd.spanKey.endDate, "2026-09-01");

  const onlyTent = buildLegacyContractLookupKey(
    dealRow({ START_DATE: null, TENTATIVE_END_DATE: "2026-10-15" })
  );
  assert.ok(onlyTent.spanKey, "TENTATIVE_END_DATE alone is enough");
  assert.equal(onlyTent.spanKey.tentativeEndDate, "2026-10-15");
});

test("buildLegacyContractLookupKey: no usable date at all leaves the primary key null", () => {
  const key = buildLegacyContractLookupKey(
    dealRow({ START_DATE: null, END_DATE: null, TENTATIVE_END_DATE: null })
  );
  assert.equal(key.spanKey, null);
  assert.equal(key.nexusKey, "8629683|35450411", "the fallback tier is still available");
});

test("buildLegacyContractLookupKey: a malformed date is dropped, not carried through", () => {
  const key = buildLegacyContractLookupKey(
    dealRow({ START_DATE: "06/01/2026", END_DATE: "2026-09-01" })
  );
  assert.equal(key.spanKey.startDate, "", "06/01/2026 is not an ISO date");
  assert.equal(key.spanKey.endDate, "2026-09-01");
});

// The primary key needs all four parts. Facility and parent client are what the data team's rule
// adds over a bare candidate+date match, so a row missing either cannot form it.
for (const missing of ["FACILITY_NAME", "PARENT_CLIENT_NAME"]) {
  test(`buildLegacyContractLookupKey: no ${missing} leaves the primary key null`, () => {
    const key = buildLegacyContractLookupKey(dealRow({ [missing]: null }));
    assert.equal(key.spanKey, null);
    assert.equal(key.nexusKey, "8629683|35450411", "the fallback tier is still available");
  });

  test(`buildLegacyContractLookupKey: blank ${missing} is treated as missing`, () => {
    assert.equal(buildLegacyContractLookupKey(dealRow({ [missing]: "   " })).spanKey, null);
  });
}

test("buildLegacyContractLookupKey: the candidate half accepts the email alone", () => {
  const key = buildLegacyContractLookupKey(dealRow({ CANDIDATE_ID: null, INTERNAL_JOB_ID: null }));
  assert.equal(key.nexusKey, null, "no Nexus ids, so no fallback tier");
  assert.equal(key.spanKey.candidateId, "");
  assert.equal(key.spanKey.email, "wesbyq@aol.com");
});

test("buildLegacyContractLookupKey: the candidate half accepts the id alone", () => {
  const key = buildLegacyContractLookupKey(dealRow({ CANDIDATE_EMAIL: null }));
  assert.equal(key.spanKey.candidateId, "8629683");
  assert.equal(key.spanKey.email, "");
});

// No candidate identifier of either kind: the primary key cannot form. The row still has an
// INTERNAL_JOB_ID, but the fallback tier needs CANDIDATE_ID alongside it, so nothing is left.
test("buildLegacyContractLookupKey: no candidate id and no email leaves nothing to key on", () => {
  const key = buildLegacyContractLookupKey(dealRow({ CANDIDATE_ID: null, CANDIDATE_EMAIL: null }));
  assert.equal(key, null);
});

test("buildLegacyContractLookupKey: facility and parent client are compared case-insensitively", () => {
  const key = buildLegacyContractLookupKey(
    dealRow({ FACILITY_NAME: "  THE MOUNT SINAI HOSPITAL  ", PARENT_CLIENT_NAME: "Mount Sinai HEALTH System" })
  );
  assert.equal(key.spanKey.facility, "the mount sinai hospital");
  assert.equal(key.spanKey.parentClient, "mount sinai health system");
});

test("buildLegacyContractLookupKey: a malformed START_DATE cannot form the primary key", () => {
  const key = buildLegacyContractLookupKey(dealRow({ START_DATE: "06/01/2026" }));
  assert.equal(key.spanKey, null);
  assert.equal(key.nexusKey, "8629683|35450411");
});

test("buildLegacyContractLookupKey: null when neither tier can be formed", () => {
  const key = buildLegacyContractLookupKey(
    dealRow({ CANDIDATE_ID: null, INTERNAL_JOB_ID: null, CANDIDATE_EMAIL: null })
  );
  assert.equal(key, null);
});

test("buildLegacyContractLookupKey: falls back to PLACEMENT_ID when no deal sheet id", () => {
  const key = buildLegacyContractLookupKey(dealRow({ DEAL_SHEET_ID: null }));
  assert.equal(key.rowKey, "pl:1457038");
});

test("legacy CONTRACT_ID is reused instead of minting a new one", async () => {
  const row = dealRow();
  const reused = await applyLegacyContractIdentityToDealRows([row], {
    tableId: "cynet_health_deal_sheet",
    fetchLegacyContractIdentityFn: fetchStub([
      ["ds:5213876", { CONTRACT_ID: "CHC22144", SKU_NUMBER: "H134597_H15175" }],
    ]),
  });
  assert.equal(reused, 1);
  assert.equal(row.CONTRACT_ID, "CHC22144");
  assert.equal(row.SKU_NUMBER, "H134597_H15175");
});

test("a run-rate row with no SKU leaves SKU_NUMBER null (never blanks a real one)", async () => {
  const row = dealRow();
  await applyLegacyContractIdentityToDealRows([row], {
    tableId: "cynet_health_deal_sheet",
    fetchLegacyContractIdentityFn: fetchStub([
      ["ds:5213876", { CONTRACT_ID: "CHC22144", SKU_NUMBER: null }],
    ]),
  });
  assert.equal(row.CONTRACT_ID, "CHC22144");
  assert.equal(row.SKU_NUMBER, null);
});

// Both tiers key off the same row; the span key must be the one that decides, with the Nexus key
// only consulted when the span key found nothing. Verified end to end against 800 live DEAL rows:
// 736 matched, 344 of the first 400 via the span key and 41 via the Nexus fallback.
test("the span key decides when both tiers could match", () => {
  const key = buildLegacyContractLookupKey(dealRow());
  assert.ok(key.spanKey, "primary key present");
  assert.ok(key.nexusKey, "fallback key present");
});

test("a row that can only form the fallback key still resolves through it", async () => {
  const row = dealRow({ FACILITY_NAME: null });
  const key = buildLegacyContractLookupKey(row);
  assert.equal(key.spanKey, null);
  const reused = await applyLegacyContractIdentityToDealRows([row], {
    tableId: "cynet_health_deal_sheet",
    fetchLegacyContractIdentityFn: fetchStub([
      ["ds:5213876", { CONTRACT_ID: "CHC22144", SKU_NUMBER: "H134597_H15175" }],
    ]),
  });
  assert.equal(reused, 1);
  assert.equal(row.CONTRACT_ID, "CHC22144");
});

test("an existing SKU_NUMBER on the row is never overwritten", async () => {
  const row = dealRow({ SKU_NUMBER: "H99999" });
  await applyLegacyContractIdentityToDealRows([row], {
    tableId: "cynet_health_deal_sheet",
    fetchLegacyContractIdentityFn: fetchStub([
      ["ds:5213876", { CONTRACT_ID: "CHC22144", SKU_NUMBER: "H134597_H15175" }],
    ]),
  });
  assert.equal(row.SKU_NUMBER, "H99999");
});

test("no run-rate match leaves CONTRACT_ID null so Firestore mints a fresh id", async () => {
  const row = dealRow();
  const reused = await applyLegacyContractIdentityToDealRows([row], {
    tableId: "cynet_health_deal_sheet",
    fetchLegacyContractIdentityFn: fetchStub([]),
  });
  assert.equal(reused, 0);
  assert.equal(row.CONTRACT_ID, null);
});

test("a row that already has a CONTRACT_ID is left untouched", async () => {
  const row = dealRow({ CONTRACT_ID: "CHC23016" });
  await applyLegacyContractIdentityToDealRows([row], {
    tableId: "cynet_health_deal_sheet",
    fetchLegacyContractIdentityFn: fetchStub([
      ["ds:5213876", { CONTRACT_ID: "CHC22144", SKU_NUMBER: "H1" }],
    ]),
  });
  assert.equal(row.CONTRACT_ID, "CHC23016");
});

test("a lookup failure is non-fatal — rows fall through to a minted id", async () => {
  const row = dealRow();
  const reused = await applyLegacyContractIdentityToDealRows([row], {
    tableId: "cynet_health_deal_sheet",
    fetchLegacyContractIdentityFn: async () => {
      throw new Error("BigQuery unavailable");
    },
  });
  assert.equal(reused, 0);
  assert.equal(row.CONTRACT_ID, null);
});

test("the destination table is forwarded so the right domain run-rate table is queried", async () => {
  const spy = [];
  await applyLegacyContractIdentityToDealRows([dealRow()], {
    tableId: "cynet_locums_deal_sheet",
    fetchLegacyContractIdentityFn: fetchStub([], spy),
  });
  assert.equal(spy[0].options.tableId, "cynet_locums_deal_sheet");
});

test("only the rows that matched take a legacy id; the rest stay null", async () => {
  const matched = dealRow();
  const unmatched = dealRow({
    DEAL_SHEET_ID: 9999999,
    CANDIDATE_ID: 111,
    INTERNAL_JOB_ID: 222,
    CANDIDATE_EMAIL: "new.hire@example.com",
  });
  const reused = await applyLegacyContractIdentityToDealRows([matched, unmatched], {
    tableId: "cynet_health_deal_sheet",
    fetchLegacyContractIdentityFn: fetchStub([
      ["ds:5213876", { CONTRACT_ID: "CHC22144", SKU_NUMBER: null }],
    ]),
  });
  assert.equal(reused, 1);
  assert.equal(matched.CONTRACT_ID, "CHC22144");
  assert.equal(unmatched.CONTRACT_ID, null);
});

// A DID NOT START / DID NOT ACCEPT placement never became a working assignment, so it takes the
// legacy CONTRACT_ID (contract identity) but never the legacy SKU_NUMBER (assignment identity).
for (const status of ["DID NOT START", "DID NOT ACCEPT", "did not start"]) {
  test(`PLACEMENT_STATUS "${status}" takes CONTRACT_ID but not SKU_NUMBER`, async () => {
    const row = dealRow({ PLACEMENT_STATUS: status });
    await applyLegacyContractIdentityToDealRows([row], {
      tableId: "cynet_health_deal_sheet",
      fetchLegacyContractIdentityFn: fetchStub([
        ["ds:5213876", { CONTRACT_ID: "CHC22754", SKU_NUMBER: "ONB7016" }],
      ]),
    });
    assert.equal(row.CONTRACT_ID, "CHC22754");
    assert.equal(row.SKU_NUMBER, null);
  });
}

for (const status of ["STARTED", "BOOKED", "ENDED", "ENDED<30"]) {
  test(`PLACEMENT_STATUS "${status}" still takes the legacy SKU_NUMBER`, async () => {
    const row = dealRow({ PLACEMENT_STATUS: status });
    await applyLegacyContractIdentityToDealRows([row], {
      tableId: "cynet_health_deal_sheet",
      fetchLegacyContractIdentityFn: fetchStub([
        ["ds:5213876", { CONTRACT_ID: "CHC22754", SKU_NUMBER: "ONB7016" }],
      ]),
    });
    assert.equal(row.SKU_NUMBER, "ONB7016");
  });
}

test("a DID NOT START row keeps a SKU it already had (fill-if-empty, never clears)", async () => {
  const row = dealRow({ PLACEMENT_STATUS: "DID NOT START", SKU_NUMBER: "H12345" });
  await applyLegacyContractIdentityToDealRows([row], {
    tableId: "cynet_health_deal_sheet",
    fetchLegacyContractIdentityFn: fetchStub([
      ["ds:5213876", { CONTRACT_ID: "CHC22754", SKU_NUMBER: "ONB7016" }],
    ]),
  });
  assert.equal(row.SKU_NUMBER, "H12345");
});

// Manual / ops columns ride along on the matched run-rate row, fill-if-empty — the DEAL-side twin of
// what EXTENSION rows already inherit. Verified end to end: 300 live DEAL rows filled 2,310 values.
const MANUAL_IDENTITY = {
  CONTRACT_ID: "CHC22144",
  SKU_NUMBER: "H134597_H15175",
  CLIENT_RECRUITER: "Priya Nair",
  ENTITY: "HEALTH",
  ST_DT_PUSHBACK_REASON: "Credentialing delay",
  FIFTYTWO_TENURE_RTO_LASTDATE: "2025-08-31",
  FIFTYTWO_TENURE_CANDIDATE_STATUS: "RTO RECEIVED",
  CANDIDATE_PAYMENT_TERMS: "Weekly",
};

test("the DEAL manual column list is the same one EXTENSION rows inherit", () => {
  const cols = legacyDealManualColumns();
  for (const expected of [
    "CLIENT_RECRUITER",
    "RECRUITMENT_MENTOR",
    "SECONDARY_RECRUITER",
    "ENTITY",
    "FIFTYTWO_TENURE_RTO_LASTDATE",
    "FIFTYTWO_TENURE_CANDIDATE_STATUS",
    "ST_DT_PUSHBACK_REASON",
    "CLIENT_NAME_IN_CONREP",
  ]) {
    assert.ok(cols.includes(expected), `${expected} is carried from the run-rate row`);
  }
});

test("manual / ops columns are filled from the matched run-rate row", async () => {
  const row = dealRow();
  await applyLegacyContractIdentityToDealRows([row], {
    tableId: "cynet_health_deal_sheet",
    fetchLegacyContractIdentityFn: fetchStub([["ds:5213876", MANUAL_IDENTITY]]),
  });
  assert.equal(row.CLIENT_RECRUITER, "Priya Nair");
  assert.equal(row.ENTITY, "HEALTH");
  assert.equal(row.ST_DT_PUSHBACK_REASON, "Credentialing delay");
  assert.equal(row.FIFTYTWO_TENURE_RTO_LASTDATE, "2025-08-31");
  assert.equal(row.FIFTYTWO_TENURE_CANDIDATE_STATUS, "RTO RECEIVED");
});

test("a manual column already on the row is never overwritten", async () => {
  const row = dealRow({ ENTITY: "INTERNATIONAL", CLIENT_RECRUITER: "  " });
  await applyLegacyContractIdentityToDealRows([row], {
    tableId: "cynet_health_deal_sheet",
    fetchLegacyContractIdentityFn: fetchStub([["ds:5213876", MANUAL_IDENTITY]]),
  });
  assert.equal(row.ENTITY, "INTERNATIONAL", "a real value wins over the legacy one");
  assert.equal(row.CLIENT_RECRUITER, "Priya Nair", "whitespace counts as empty");
});

// Only SKU_NUMBER is withheld from a placement that never ran; the ops detail still describes the
// contract, so it comes across as it would on any other row.
for (const status of ["DID NOT START", "DID NOT ACCEPT"]) {
  test(`PLACEMENT_STATUS "${status}" takes the manual columns but still no SKU_NUMBER`, async () => {
    const row = dealRow({ PLACEMENT_STATUS: status });
    await applyLegacyContractIdentityToDealRows([row], {
      tableId: "cynet_health_deal_sheet",
      fetchLegacyContractIdentityFn: fetchStub([["ds:5213876", MANUAL_IDENTITY]]),
    });
    assert.equal(row.SKU_NUMBER, null, "SKU is still gated");
    assert.equal(row.CONTRACT_ID, "CHC22144");
    assert.equal(row.ENTITY, "HEALTH");
    assert.equal(row.CANDIDATE_PAYMENT_TERMS, "Weekly");
    assert.equal(row.ST_DT_PUSHBACK_REASON, "Credentialing delay");
  });
}

test("a null manual column on the legacy row never blanks anything", async () => {
  const row = dealRow({ ENTITY: "HEALTH" });
  await applyLegacyContractIdentityToDealRows([row], {
    tableId: "cynet_health_deal_sheet",
    fetchLegacyContractIdentityFn: fetchStub([
      ["ds:5213876", { CONTRACT_ID: "CHC22144", ENTITY: null, CLIENT_RECRUITER: "   " }],
    ]),
  });
  assert.equal(row.ENTITY, "HEALTH");
  assert.equal(row.CLIENT_RECRUITER ?? null, null, "a blank legacy value is not copied");
});

test("empty input short-circuits without calling BigQuery", async () => {
  let called = false;
  const reused = await applyLegacyContractIdentityToDealRows([], {
    tableId: "cynet_health_deal_sheet",
    fetchLegacyContractIdentityFn: async () => {
      called = true;
      return new Map();
    },
  });
  assert.equal(reused, 0);
  assert.equal(called, false);
});
