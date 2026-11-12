const test = require("node:test");
const assert = require("node:assert/strict");

const {
  STATE,
  PAYLOAD_FIELDS,
  buildAitaPayload,
  validateAitaPayload,
  buildEventKey,
  isValidPlacementId,
  toIsoDate,
  classifyResult,
  postAitaEvent,
  runAitaWebhookSyncHealth,
} = require("./aitaWebhook");

// CHC22687 extension row, as BigQuery returns it (DATE columns are {value} objects).
function extensionRow(overrides = {}) {
  return {
    DEAL_SHEET_ID: 5280158,
    PLACEMENT_ID: 1471917,
    PLACEMENT_STATUS: "STARTED",
    CANDIDATE_STATUS: "ACTIVE",
    CONTRACT_ID: "CHC22687",
    DEAL_TYPE: "EXTENSION",
    CANDIDATE_ID: 25290395,
    CANDIDATE_NAME: "Perfect Arthur",
    CANDIDATE_EMAIL: "FOCUSPERF@YAHOO.COM",
    INITIAL_START_DATE: { value: "2026-08-10" },
    START_DATE: { value: "2026-11-09" },
    END_DATE: null,
    EXTENSION_START_DATE: { value: "2026-11-09" },
    CLIENT_ID: 973847,
    MSP_ID: 323,
    FACILITY_NAME: "Saint Francis Hospital - Hartford - TT",
    CLIENT_STATE: "CT",
    PAY_RATE: 22.9,
    OT_RATE: 95,
    HOLIDAY_RATE: 55,
    DT_RATE: null,
    ON_CALL_RATE: 3,
    CALL_BACK_RATE: 55,
    BILL_RATE: 90,
    CLIENT_OT_RATE: 117,
    CLIENT_HOLIDAY_RATE: 117,
    CLIENT_DT_RATE: null,
    CLIENT_ON_CALL_RATE: 5,
    CLIENT_CALL_BACK_RATE: 117,
    ...overrides,
  };
}

const SETTINGS = {
  enabled: true,
  url: "https://aita.test/hook",
  token: "tok",
  sourceTableId: "src",
  outboxTableId: "outbox",
  knownCandidatesTableId: "known",
  datasetId: "ds",
  timeoutMs: 1000,
  concurrency: 2,
  maxAttempts: 3,
  maxEventsPerRun: 50,
};

test("START_DATE is the original contract start; EXTENSION_START_DATE is the segment start", () => {
  const p = buildAitaPayload(extensionRow());
  assert.equal(p.START_DATE, "2026-08-10");
  assert.equal(p.EXTENSION_START_DATE, "2026-11-09");
  assert.equal(p.CONTRACT_ID, "CHC22687");
});

test("START_DATE falls back to START_DATE when INITIAL_START_DATE is null", () => {
  const p = buildAitaPayload(extensionRow({ INITIAL_START_DATE: null, DEAL_TYPE: "DEAL" }));
  assert.equal(p.START_DATE, "2026-11-09");
});

test("payload keys are fixed and ordered, so the serialised bytes are stable", () => {
  const a = JSON.stringify(buildAitaPayload(extensionRow()));
  const b = JSON.stringify(buildAitaPayload({ ...extensionRow(), EXTRA_COLUMN: "x" }));
  assert.equal(a, b);
  assert.deepEqual(Object.keys(JSON.parse(a)), PAYLOAD_FIELDS);
});

test("status is normalised and blank strings become null", () => {
  const p = buildAitaPayload(extensionRow({ PLACEMENT_STATUS: " ended<30 ", FACILITY_NAME: "  " }));
  assert.equal(p.PLACEMENT_STATUS, "ENDED<30");
  assert.equal(p.FACILITY_NAME, null);
});

test("toIsoDate handles BigQuery {value}, Date, timestamps and junk", () => {
  assert.equal(toIsoDate({ value: "2026-11-09" }), "2026-11-09");
  assert.equal(toIsoDate({ value: "2026-11-09T16:33:10.870Z" }), "2026-11-09");
  assert.equal(toIsoDate(new Date("2026-01-02T00:00:00Z")), "2026-01-02");
  assert.equal(toIsoDate("nope"), null);
  assert.equal(toIsoDate(null), null);
});

test("PLACEMENT_ID follows AITA's envelope rule", () => {
  assert.equal(isValidPlacementId(1234567), true);
  assert.equal(isValidPlacementId("1234567"), true);
  assert.equal(isValidPlacementId(1234567.5), false);
  assert.equal(isValidPlacementId(0), false);
  assert.equal(isValidPlacementId(-5), false);
  assert.equal(isValidPlacementId(""), false);
  assert.equal(isValidPlacementId(null), false);
});

test("validation skips out-of-scope status, bad ids and end-before-start", () => {
  assert.equal(validateAitaPayload(buildAitaPayload(extensionRow())), null);
  assert.equal(
    validateAitaPayload(buildAitaPayload(extensionRow({ PLACEMENT_STATUS: "BOOKED" }))),
    "status not in AITA scope"
  );
  assert.equal(
    validateAitaPayload(buildAitaPayload(extensionRow({ PLACEMENT_ID: null }))),
    "invalid PLACEMENT_ID"
  );
  assert.equal(
    validateAitaPayload(buildAitaPayload(extensionRow({ CANDIDATE_STATUS: null }))),
    "missing CANDIDATE_STATUS"
  );
  assert.equal(
    validateAitaPayload(
      buildAitaPayload(extensionRow({ PLACEMENT_STATUS: "ENDED", END_DATE: { value: "2026-11-01" } }))
    ),
    "END_DATE before EXTENSION_START_DATE"
  );
  assert.equal(
    validateAitaPayload(
      buildAitaPayload(
        extensionRow({ DEAL_TYPE: "DEAL", EXTENSION_START_DATE: null, PLACEMENT_STATUS: "ENDED<30", END_DATE: { value: "2026-08-01" } })
      )
    ),
    "END_DATE before START_DATE"
  );
});

test("event key is DEAL_SHEET_ID|PLACEMENT_ID|STATUS", () => {
  assert.equal(buildEventKey(extensionRow({ PLACEMENT_STATUS: "ended" })), "5280158|1471917|ENDED");
  assert.equal(buildEventKey({ DEAL_SHEET_ID: null, PLACEMENT_ID: 7, PLACEMENT_STATUS: "STARTED" }), "|7|STARTED");
});

test("classifyResult: 202 sent, else retry until maxAttempts then failed", () => {
  assert.equal(classifyResult({ httpStatus: 202, attempts: 1 }, 3), STATE.SENT);
  assert.equal(classifyResult({ httpStatus: 503, attempts: 1 }, 3), STATE.RETRY);
  assert.equal(classifyResult({ httpStatus: null, attempts: 2 }, 3), STATE.RETRY);
  assert.equal(classifyResult({ httpStatus: 401, attempts: 3 }, 3), STATE.FAILED);
});

test("postAitaEvent sends the exact body string with bearer auth and never throws", async () => {
  let seen;
  const body = '{"PLACEMENT_ID":1,"PLACEMENT_STATUS":"STARTED"}';
  const ok = await postAitaEvent(body, SETTINGS, {
    post: async (url, data, opts) => {
      seen = { url, data: opts.transformRequest[0](data), headers: opts.headers };
      return { status: 202 };
    },
  });
  assert.deepEqual(ok, { httpStatus: 202, error: null });
  assert.equal(seen.data, body);
  assert.equal(seen.headers.Authorization, "Bearer tok");

  const down = await postAitaEvent(body, SETTINGS, {
    post: async () => {
      throw Object.assign(new Error("timeout"), { code: "ECONNABORTED" });
    },
  });
  assert.deepEqual(down, { httpStatus: null, error: "ECONNABORTED" });
});

// Fake BigQuery: routes by SQL shape, records DML.
function fakeBq({ outboxCount = 1, newRows = [], retryRows = null } = {}) {
  const dml = [];
  const posted = [];
  let inserted = [];
  return {
    dml,
    posted,
    deps: {
      queryObjects: async (sql) => {
        if (sql.includes("COUNT(*) AS n")) return [{ n: outboxCount }];
        if (sql.includes("STATE IN")) {
          if (retryRows) return retryRows;
          return inserted.map((e) => ({ EVENT_KEY: e.key, PAYLOAD_JSON: e.body, ATTEMPTS: 0 }));
        }
        return newRows;
      },
      runDml: async (sql) => {
        dml.push(sql);
        if (sql.trim().startsWith("INSERT INTO") && sql.includes("VALUES")) {
          // Capture pending rows the way the real outbox would hold them.
          inserted = newRows
            .map((r) => buildAitaPayload(r))
            .filter((p) => validateAitaPayload(p) == null)
            .map((p, i) => ({ key: `k${i}`, body: JSON.stringify(p) }));
        }
        return 1;
      },
      post: async (url, data) => {
        posted.push(data);
        return { status: 202 };
      },
    },
  };
}

test("disabled: nothing is queried or sent", async () => {
  const bq = fakeBq({ newRows: [extensionRow()] });
  const r = await runAitaWebhookSyncHealth({ settings: { ...SETTINGS, enabled: false } }, bq.deps);
  assert.deepEqual(r, { skipped: true, reason: "disabled" });
  assert.equal(bq.dml.length, 0);
  assert.equal(bq.posted.length, 0);
});

test("first run against an empty outbox seeds the baseline and sends nothing", async () => {
  const bq = fakeBq({ outboxCount: 0, newRows: [extensionRow()] });
  const r = await runAitaWebhookSyncHealth({ settings: SETTINGS }, bq.deps);
  assert.equal(r.sent, 0);
  assert.equal(bq.posted.length, 0);
  assert.ok(bq.dml.some((s) => s.includes(`'${STATE.BASELINE}'`)));
  // Every candidate already in the table is frozen as known, so none of them is ever sent.
  assert.ok(bq.dml.some((s) => /INSERT INTO `[^`]*\.known`/.test(s) && s.includes("SELECT DISTINCT CANDIDATE_ID")));
});

test("only candidates not in the known list are picked up", async () => {
  const seen = [];
  const bq = fakeBq({ newRows: [extensionRow()] });
  const inner = bq.deps.queryObjects;
  bq.deps.queryObjects = async (sql) => {
    seen.push(sql);
    return inner(sql);
  };
  await runAitaWebhookSyncHealth({ dryRun: true, settings: SETTINGS }, bq.deps);
  const newEventsSql = seen.find((s) => s.includes("ROW_NUMBER()"));
  assert.match(newEventsSql, /l\.CANDIDATE_ID IS NOT NULL/);
  assert.match(newEventsSql, /l\.CANDIDATE_ID NOT IN \(SELECT CANDIDATE_ID FROM `[^`]*\.known`\)/);
});

test("dry run returns events without POSTing or writing the outbox", async () => {
  const bq = fakeBq({ newRows: [extensionRow(), extensionRow({ PLACEMENT_ID: null })] });
  const r = await runAitaWebhookSyncHealth({ dryRun: true, settings: { ...SETTINGS, enabled: false } }, bq.deps);
  assert.equal(r.dryRun, true);
  assert.equal(r.events.length, 2);
  assert.equal(r.events[1].state, STATE.SKIPPED);
  assert.equal(bq.posted.length, 0);
  assert.equal(bq.dml.length, 0);
});

test("new events are stored before sending and the stored bytes are what gets POSTed", async () => {
  const bq = fakeBq({ newRows: [extensionRow(), extensionRow({ PLACEMENT_STATUS: "BOOKED" })] });
  const r = await runAitaWebhookSyncHealth({ settings: SETTINGS }, bq.deps);
  assert.equal(r.newEvents, 2);
  assert.equal(r.skipped, 1);
  assert.equal(r.sent, 1);
  assert.equal(bq.posted[0], JSON.stringify(buildAitaPayload(extensionRow())));
  const insertIdx = bq.dml.findIndex((s) => s.includes("VALUES"));
  const mergeIdx = bq.dml.findIndex((s) => s.includes("MERGE"));
  assert.ok(insertIdx > -1 && mergeIdx > insertIdx);
});

test("a 401 stops the run and leaves the events for retry", async () => {
  const retryRows = [1, 2, 3, 4].map((i) => ({ EVENT_KEY: `k${i}`, PAYLOAD_JSON: `{"i":${i}}`, ATTEMPTS: 0 }));
  const bq = fakeBq({ retryRows });
  bq.deps.post = async (url, data) => {
    bq.posted.push(data);
    return { status: 401 };
  };
  const r = await runAitaWebhookSyncHealth({ settings: { ...SETTINGS, concurrency: 1 } }, bq.deps);
  assert.equal(r.authFailed, true);
  assert.equal(bq.posted.length, 1);
  assert.equal(r.retry, 1);
});
