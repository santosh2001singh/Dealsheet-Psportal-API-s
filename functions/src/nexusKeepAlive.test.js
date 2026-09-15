const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

/**
 * Regression cover for the 2026-09-05 health update run that died on the network layer, not on any
 * Nexus response:
 *   ECONNRESET  "Client network socket disconnected before secure TLS connection was established"
 *   ECONNABORTED "timeout of 45000ms exceeded"
 *   EPIPE        "connect EPIPE 34.36.142.228:443"
 *   "socket hang up"
 *
 * It was NOT load: the run logged concurrency=8 with deal_sheets=1 jobs=1 candidates=1 and still
 * burned all 5 retries on a single job_id, while those same URLs answered 200 in ~430ms from a
 * laptop. The failures land *before* the TLS handshake, i.e. the request never reaches Nexus.
 *
 * Cause: no httpsAgent anywhere, so axios used Node's default keepAlive:false agent — a fresh TCP
 * connection and TLS handshake per request, thousands per run. On Cloud Run that exhausts the
 * ephemeral port pool (TIME_WAIT -> EPIPE) and saturates the egress NAT on connection setups.
 *
 * Measured locally against the real API, same 4 deal-sheet ids back to back:
 *   no keep-alive : 27418ms, 2255ms, 463ms, 462ms
 *   keep-alive    :   479ms,  483ms, 486ms, 481ms
 * The 27s first request is all connection setup — that is the 45s timeout wall seen in prod.
 */

const SRC = fs.readFileSync(require.resolve("./nexusClient.js"), "utf8");

test("a keep-alive https agent is configured", () => {
  assert.ok(/require\("https"\)/.test(SRC), "must require https to build an agent");
  assert.ok(/new https\.Agent\(/.test(SRC), "must construct an https.Agent");
  assert.ok(/keepAlive:\s*true/.test(SRC), "the agent must enable keepAlive");
});

test("the agent bounds concurrent sockets and keeps a warm pool", () => {
  const maxSockets = SRC.match(/maxSockets:\s*(\d+)/);
  assert.ok(maxSockets, "agent must set maxSockets so one instance cannot flood the egress NAT");
  // Must clear the widest fan-out any domain uses (fetchAllMax 20, candidate fetch clamp 20) or the
  // agent itself becomes the bottleneck and requests queue behind sockets instead of running.
  assert.ok(
    Number(maxSockets[1]) >= 20,
    `maxSockets must be >= the widest fan-out (20), got ${maxSockets[1]}`
  );
  assert.ok(/maxFreeSockets:\s*\d+/.test(SRC), "agent must keep free sockets warm between waves");
});

test("every Nexus request goes through the agent-bound instance", () => {
  assert.ok(
    /axios\.create\(\{\s*httpsAgent/.test(SRC),
    "must build a shared instance carrying the agent"
  );
  // The whole point of the instance is that a call site cannot forget the agent. Bare axios.get /
  // axios.post would silently fall back to the default keepAlive:false agent.
  const bare = SRC.match(/\baxios\.(get|post|put|request)\(/g) || [];
  assert.deepEqual(
    bare,
    [],
    `all Nexus calls must use the agent-bound instance, found bare: ${bare.join(", ")}`
  );
});

test("the four Nexus call sites are all routed through it", () => {
  // auth token, token refresh, nexusGetJson, nexusFetchAllJson
  const routed = SRC.match(/\bnexusHttp\.(get|post)\(/g) || [];
  assert.equal(routed.length, 4, `expected 4 routed call sites, found ${routed.length}`);
});
