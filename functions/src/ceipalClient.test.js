const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("./config");
const client = require("./ceipalClient");

function configure() {
  Object.assign(config.ceipal, {
    authUrl: "https://auth.test/token",
    email: "e",
    password: "p",
    apiKey: "k",
    reportUrl: "https://report.test/data",
    reportPageLimit: 2,
    reportMaxPages: 50,
    maxRetries: 0,
    pageDelayMs: 0,
  });
}

const rec = (n) => ({ PlacementCode: `PLC-${n}` });

test("auth token is read from access_token and cached", async () => {
  configure();
  client.resetCeipalTokenCacheForTests();
  let calls = 0;
  const http = { request: async (req) => { calls++; assert.equal(req.data.json, "1"); return { data: { access_token: "T1" } }; } };
  assert.equal(await client.getCeipalAccessToken({ http, now: 0 }), "T1");
  assert.equal(await client.getCeipalAccessToken({ http, now: 1000 }), "T1");
  assert.equal(calls, 1);
});

test("token is renewed after it expires, using expires_in from the auth response", async () => {
  configure();
  client.resetCeipalTokenCacheForTests();
  let n = 0;
  const http = { request: async () => ({ data: { access_token: `T${++n}`, expires_in: 3600 } }) };
  assert.equal(await client.getCeipalAccessToken({ http, now: 0 }), "T1");
  assert.equal(await client.getCeipalAccessToken({ http, now: 49 * 60 * 1000 }), "T1", "still valid at 49 min");
  assert.equal(await client.getCeipalAccessToken({ http, now: 51 * 60 * 1000 }), "T2", "renewed before the 1 hour expiry");
});

test("pages by page number until a short page", async () => {
  configure();
  const pages = { 1: [rec(1), rec(2)], 2: [rec(3), rec(4)], 3: [rec(5)] };
  const seen = [];
  const http = { request: async (req) => { seen.push(req.params.page); assert.equal(req.headers.Authorization, "Bearer T"); return { data: { results: pages[req.params.page] } }; } };
  const out = await client.fetchAllReportRecords({ http, getToken: async () => "T" });
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(out.records.length, 5);
});

test("CEIPAL envelope: records in result, pages until has_next_page is 0, page_count ignored", async () => {
  configure();
  const seen = [];
  const http = {
    request: async (req) => {
      const p = req.params.page;
      seen.push(p);
      assert.equal(req.params.limit, 2);
      const result = p === 1 ? [rec(1), rec(2)] : p === 2 ? [rec(3), rec(4)] : [rec(5)];
      return { data: { success: 1, record_count: 5, page_count: 100, page_number: p, has_next_page: p < 3 ? 1 : 0, next_page: "https://x?page=" + (p + 1), result } };
    },
  };
  const out = await client.fetchAllReportRecords({ http, getToken: async () => "T" });
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(out.records.length, 5);
  assert.equal(out.recordCount, 5);
});

test("record_count > 0 with no readable records fails instead of syncing nothing", async () => {
  configure();
  const http = { request: async () => ({ data: { success: 1, record_count: 1204, rows: [{}] } }) };
  await assert.rejects(() => client.fetchAllReportRecords({ http, getToken: async () => "T" }), /record_count=1204/);
});

test("follows a next URL when the envelope has one", async () => {
  configure();
  const http = {
    request: async (req) =>
      req.url === "https://report.test/data"
        ? { data: { results: [rec(1), rec(2)], next: "https://report.test/data?page=2" } }
        : { data: { results: [rec(3)], next: null } },
  };
  const out = await client.fetchAllReportRecords({ http, getToken: async () => "T" });
  assert.equal(out.records.length, 3);
});

test("stops when the endpoint ignores paging and repeats page 1", async () => {
  configure();
  const http = { request: async () => ({ data: [rec(1), rec(2)] }) };
  const out = await client.fetchAllReportRecords({ http, getToken: async () => "T" });
  assert.equal(out.records.length, 2);
});

test("refreshes the token once on 401", async () => {
  configure();
  let n = 0;
  const http = {
    request: async (req) => {
      n++;
      if (req.headers.Authorization === "Bearer OLD") {
        const e = new Error("401");
        e.response = { status: 401 };
        throw e;
      }
      return { data: { results: [rec(1)] } };
    },
  };
  const out = await client.fetchAllReportRecords({ http, getToken: async (d) => (d?.forceRefresh ? "NEW" : "OLD") });
  assert.equal(out.records.length, 1);
  assert.equal(n, 2);
});

test("missing credentials fail with the env var names", async () => {
  configure();
  config.ceipal.password = "";
  await assert.rejects(() => client.fetchAllReportRecords({ getToken: async () => "T" }), /CEIPAL_PASSWORD/);
});

test("fetchReportPage asks for one page with our limit and renews the token on 401", async () => {
  configure();
  const calls = [];
  const http = {
    request: async (req) => {
      calls.push([req.params.page, req.headers.Authorization]);
      if (req.headers.Authorization === "Bearer OLD") {
        const e = new Error("401");
        e.response = { status: 401 };
        throw e;
      }
      return { data: { record_count: 3, has_next_page: 0, result: [rec(1)] } };
    },
  };
  const pg = await client.fetchReportPage(7, { http, getToken: async (d) => (d?.forceRefresh ? "NEW" : "OLD") });
  assert.deepEqual(calls, [[7, "Bearer OLD"], [7, "Bearer NEW"]]);
  assert.equal(pg.records.length, 1);
  assert.equal(pg.hasNext, false);
  assert.equal(pg.recordCount, 3);
});
