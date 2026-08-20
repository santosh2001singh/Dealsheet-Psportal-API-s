const test = require("node:test");
const assert = require("node:assert/strict");

const {
  acquireRunLock,
  refreshRunLock,
  releaseRunLock,
  withRunLock,
  isLockStale,
  DEFAULT_LEASE_MS,
  DEFAULT_HEARTBEAT_GRACE_MS,
} = require("./syncRunLock");

// The Aug 19 2026 incident: a socket hangup did not kill the run, a manual re-run started on top of
// it, and both loops processed the same pages for 25 minutes — 1,546 duplicate deal-sheet rows and 52
// placements with two different CONTRACT_IDs. reject_if_existing_deal_sheet_or_placement could not
// stop it because both runs read BigQuery before either wrote. These tests cover the lock that can.

/**
 * Minimal Firestore stand-in with the transaction semantics this module relies on: reads see
 * committed state and writes buffer until commit.
 */
function fakeFirestore() {
  const store = new Map();
  return {
    _store: store,
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: (d2) => ({ _path: `lock/${d2}` }),
        }),
      }),
    }),
    async runTransaction(fn) {
      const writes = [];
      const tx = {
        async get(ref) {
          const data = store.get(ref._path);
          return {
            exists: data !== undefined,
            data: () => (data === undefined ? undefined : { ...data }),
          };
        },
        set(ref, value, opts) {
          writes.push({ ref, value, merge: Boolean(opts && opts.merge) });
        },
        delete(ref) {
          writes.push({ ref, delete: true });
        },
      };
      const result = await fn(tx);
      for (const w of writes) {
        if (w.delete) store.delete(w.ref._path);
        else if (w.merge) store.set(w.ref._path, { ...(store.get(w.ref._path) || {}), ...w.value });
        else store.set(w.ref._path, w.value);
      }
      return result;
    },
  };
}

const T0 = 1_760_000_000_000; // fixed clock; Date.now() is never used in these tests

test("a second run cannot take a lock that is already held", async () => {
  const firestore = fakeFirestore();
  const first = await acquireRunLock("insert-health", { firestore, runId: "runA", nowMs: T0 });
  assert.equal(first.acquired, true);

  // The manual re-run, arriving one second later while run A is still working.
  const second = await acquireRunLock("insert-health", {
    firestore,
    runId: "runB",
    nowMs: T0 + 1000,
  });
  assert.equal(second.acquired, false);
  assert.equal(second.heldBy, "runA");
});

test("different lock keys do not block each other", async () => {
  // The three domains are staggered but must never contend; only same-domain overlap is the problem.
  const firestore = fakeFirestore();
  const health = await acquireRunLock("insert-health", { firestore, runId: "h", nowMs: T0 });
  const canada = await acquireRunLock("insert-canada", { firestore, runId: "c", nowMs: T0 });
  assert.equal(health.acquired, true);
  assert.equal(canada.acquired, true);
});

test("an expired lease can be taken over, so a dead run never wedges its domain", async () => {
  const firestore = fakeFirestore();
  await acquireRunLock("insert-health", { firestore, runId: "dead", nowMs: T0 });

  const later = await acquireRunLock("insert-health", {
    firestore,
    runId: "fresh",
    nowMs: T0 + DEFAULT_LEASE_MS + 1,
  });
  assert.equal(later.acquired, true);
  assert.equal(later.tookOverStaleLock, true);
  assert.equal(later.runId, "fresh");
});

test("a quiet heartbeat allows takeover before the full lease elapses", async () => {
  // A function killed mid-run (OOM / timeout / deploy) never releases and never refreshes. Waiting
  // out the whole lease would stall the domain longer than necessary.
  const firestore = fakeFirestore();
  await acquireRunLock("insert-health", { firestore, runId: "killed", nowMs: T0 });

  const takeover = await acquireRunLock("insert-health", {
    firestore,
    runId: "next",
    // Just past the heartbeat grace but still inside the lease — derived from the constants so the
    // test keeps testing takeover-before-expiry if the timings are ever retuned.
    nowMs: T0 + DEFAULT_HEARTBEAT_GRACE_MS + 1000,
  });
  assert.equal(takeover.acquired, true);
  assert.equal(takeover.tookOverStaleLock, true);
});

test("refreshing keeps a long run's lock alive", async () => {
  const firestore = fakeFirestore();
  const got = await acquireRunLock("insert-health", { firestore, runId: "long", nowMs: T0 });
  assert.equal(got.acquired, true);

  // The real run ran far longer than one lease, so refreshing is what keeps it valid. Refresh just
  // before the lease would lapse, which also resets the heartbeat clock.
  const refreshAt = T0 + DEFAULT_LEASE_MS - 1000;
  const refreshed = await refreshRunLock("insert-health", "long", {
    firestore,
    nowMs: refreshAt,
  });
  assert.equal(refreshed.refreshed, true);

  // Probe PAST the point the original lease would have expired. Only the refresh can be keeping the
  // lock alive here — and the probe stays inside the refreshed lease and heartbeat grace.
  const probeAt = T0 + DEFAULT_LEASE_MS + 1000;
  assert.ok(probeAt > T0 + DEFAULT_LEASE_MS, "probe must be past the original lease");
  assert.ok(
    probeAt - refreshAt < DEFAULT_HEARTBEAT_GRACE_MS,
    "probe must stay within the heartbeat grace of the refresh"
  );
  const intruder = await acquireRunLock("insert-health", {
    firestore,
    runId: "intruder",
    nowMs: probeAt,
  });
  assert.equal(intruder.acquired, false);
  assert.equal(intruder.heldBy, "long");
});

test("only the holder may refresh", async () => {
  const firestore = fakeFirestore();
  await acquireRunLock("insert-health", { firestore, runId: "owner", nowMs: T0 });
  const bogus = await refreshRunLock("insert-health", "someone-else", {
    firestore,
    nowMs: T0 + 60,
  });
  assert.equal(bogus.refreshed, false);
});

test("a displaced run cannot release the lock its successor now holds", async () => {
  const firestore = fakeFirestore();
  await acquireRunLock("insert-health", { firestore, runId: "old", nowMs: T0 });
  const taken = await acquireRunLock("insert-health", {
    firestore,
    runId: "new",
    nowMs: T0 + DEFAULT_LEASE_MS + 1,
  });
  assert.equal(taken.acquired, true);

  // The old run finally finishes and tries to clean up — it must not wipe the new holder's lock.
  const released = await releaseRunLock("insert-health", "old", {
    firestore,
    nowMs: T0 + DEFAULT_LEASE_MS + 2,
  });
  assert.equal(released.released, false);

  const stillHeld = await acquireRunLock("insert-health", {
    firestore,
    runId: "third",
    nowMs: T0 + DEFAULT_LEASE_MS + 3,
  });
  assert.equal(stillHeld.acquired, false, "the successor must still hold the lock");
});

test("releasing frees the lock for the next run", async () => {
  const firestore = fakeFirestore();
  const got = await acquireRunLock("insert-health", { firestore, runId: "a", nowMs: T0 });
  const rel = await releaseRunLock("insert-health", got.runId, { firestore, nowMs: T0 + 100 });
  assert.equal(rel.released, true);

  const next = await acquireRunLock("insert-health", { firestore, runId: "b", nowMs: T0 + 200 });
  assert.equal(next.acquired, true);
  assert.equal(next.tookOverStaleLock, false, "a released lock is gone, not stale");
});

test("withRunLock runs the body and releases afterwards", async () => {
  const firestore = fakeFirestore();
  let ran = 0;
  const out = await withRunLock("insert-health", { firestore, runId: "w", nowMs: T0 }, async () => {
    ran++;
    return "done";
  });
  assert.equal(out.ran, true);
  assert.equal(out.result, "done");
  assert.equal(ran, 1);

  const next = await acquireRunLock("insert-health", { firestore, runId: "after", nowMs: T0 + 10 });
  assert.equal(next.acquired, true);
});

test("withRunLock skips the body when the lock is held, without throwing", async () => {
  // A manual re-run landing on a live run is normal operation, not an error.
  const firestore = fakeFirestore();
  await acquireRunLock("insert-health", { firestore, runId: "live", nowMs: T0 });

  let ran = 0;
  const out = await withRunLock(
    "insert-health",
    { firestore, runId: "manual", nowMs: T0 + 1000 },
    async () => {
      ran++;
    }
  );
  assert.equal(out.ran, false);
  assert.equal(ran, 0, "the body must not run");
});

test("withRunLock releases even when the body throws", async () => {
  const firestore = fakeFirestore();
  await assert.rejects(
    withRunLock("insert-health", { firestore, runId: "boom", nowMs: T0 }, async () => {
      throw new Error("socket hang up");
    }),
    /socket hang up/
  );

  // The lock must not be stranded by the failure — this is the exact path the incident took.
  const next = await acquireRunLock("insert-health", { firestore, runId: "retry", nowMs: T0 + 10 });
  assert.equal(next.acquired, true);
  assert.equal(next.tookOverStaleLock, false, "a released lock is gone, not merely stale");
});

test("a lock that cannot be read refuses the run rather than assuming it is free", async () => {
  // Treating an unreadable lock as "no lock" would recreate the overlap it exists to prevent.
  const firestore = {
    collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ _path: "x" }) }) }) }),
    runTransaction: async () => {
      throw new Error("firestore unavailable");
    },
  };
  const got = await acquireRunLock("insert-health", { firestore, runId: "r", nowMs: T0 });
  assert.equal(got.acquired, false);
  assert.match(got.reason, /lock unavailable/);
});

test("isLockStale treats a malformed doc as dead so it cannot wedge the domain", () => {
  const opts = { leaseMs: DEFAULT_LEASE_MS, heartbeatGraceMs: 5 * 60 * 1000 };
  assert.equal(isLockStale(null, T0, opts), true);
  assert.equal(isLockStale({ runId: "x" }, T0, opts), true, "no timestamps at all");
  // A lease far beyond what we configure was not written by this module.
  assert.equal(
    isLockStale(
      { runId: "x", expiresAt: new Date(T0 + DEFAULT_LEASE_MS * 10), heartbeatAt: new Date(T0) },
      T0,
      opts
    ),
    true
  );
  // A healthy, freshly-refreshed lock is not stale.
  assert.equal(
    isLockStale({ runId: "x", expiresAt: new Date(T0 + 60_000), heartbeatAt: new Date(T0) }, T0, opts),
    false
  );
});

test("withRunLock keeps refreshing the lease for as long as the body runs", async () => {
  // The incident's run lasted 63 minutes against a 15-minute lease. Without an in-flight refresh the
  // holder's own lock expires mid-write and a second run can take over — exactly the overlap the
  // lock exists to stop. heartbeatIntervalMs keeps this deterministic instead of waiting 30s.
  const firestore = fakeFirestore();
  let refreshes = 0;
  const inner = firestore.runTransaction.bind(firestore);
  firestore.runTransaction = async (fn) => {
    const out = await inner(fn);
    if (out && out.refreshed === true) refreshes++;
    return out;
  };

  const seenExpiries = [];
  await withRunLock(
    "insert-health",
    { firestore, runId: "slow", heartbeatIntervalMs: 5 },
    async () => {
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 12));
        const held = firestore._store.get("lock/insert-health");
        if (held) seenExpiries.push(held.expiresAt.getTime());
      }
    }
  );

  assert.ok(refreshes >= 2, `expected repeated refreshes, got ${refreshes}`);
  // The expiry must actually move forward, not be rewritten to the same instant.
  assert.ok(
    seenExpiries[seenExpiries.length - 1] > seenExpiries[0],
    `lease should extend over time, saw ${JSON.stringify(seenExpiries)}`
  );
  // And the lock is still released once the body finishes.
  assert.equal(firestore._store.size, 0, "lock released; heartbeat cleared");
});

test("auto-generated runIds are unique, so a finishing run cannot release its successor's lock", async () => {
  // Regression: the triggers derived runId from event.jobName, which is IDENTICAL on every scheduled
  // firing. Two runs then shared an id and the "only the holder may release" guard became a no-op —
  // a stale run finishing would delete the lock a live successor had just taken over.
  const firestore = fakeFirestore();

  // Run A takes the lock and its lease goes stale.
  const a = await acquireRunLock("insert-health", { firestore, nowMs: T0 });
  assert.equal(a.acquired, true);

  // Run B takes over. With no runId supplied, each acquire mints its own.
  const b = await acquireRunLock("insert-health", { firestore, nowMs: T0 + DEFAULT_LEASE_MS + 1 });
  assert.equal(b.acquired, true);
  assert.notEqual(a.runId, b.runId, "each acquire must mint a distinct runId");

  // Run A finally finishes and tries to clean up — it must not touch B's lock.
  const relA = await releaseRunLock("insert-health", a.runId, {
    firestore,
    nowMs: T0 + DEFAULT_LEASE_MS + 2,
  });
  assert.equal(relA.released, false);

  const intruder = await acquireRunLock("insert-health", {
    firestore,
    nowMs: T0 + DEFAULT_LEASE_MS + 3,
  });
  assert.equal(intruder.acquired, false, "B must still hold the lock");
});
