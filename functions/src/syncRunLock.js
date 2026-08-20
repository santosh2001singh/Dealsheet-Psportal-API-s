/**
 * Lease-based run lock, so two copies of the same sync can never run at once.
 *
 * Why this exists (Aug 19 2026 incident): a run hit a socket hangup on a Nexus page. The hangup does
 * not kill the function — the retry layer keeps going and the page checkpoint keeps `hasMore=yes` —
 * so the first run was still alive and advancing. A manual re-run started on top of it, and for the
 * next 25 minutes BOTH loops processed the same submittal pages. Every insert batch landed twice
 * (identical row counts one second apart: 249/249, 257/257, 251/251 …), which put 1,546 duplicate
 * rows in cynet_health_deal_sheet and doubled ownership_change_logs.
 *
 * The existing `reject_if_existing_deal_sheet_or_placement` guard could not stop it: both runs read
 * BigQuery at the same moment, both saw the row absent, both minted an id from their own Firestore
 * block, and both inserted. The two blocks were 17 apart, so 52 placements ended up with two
 * different CONTRACT_IDs (CHC23259 vs CHC23276, CHC23263 vs CHC23280, …). A read-then-write guard
 * cannot serialise concurrent writers; only a lock can.
 *
 * LEASE, not a plain flag. A crashed run must not block its domain forever, and a function that is
 * killed mid-run (OOM, timeout, deploy) never gets to release anything. So the lock carries an
 * expiry: a run refreshes it while it works, and a lock whose expiry has passed is treated as dead
 * and may be taken over. Pick a TTL comfortably longer than the gap between heartbeats but shorter
 * than the patience for a stuck domain.
 *
 * Firestore layout: workspaces/{docId}/dealSheetSyncRunLocks/{lockKey}
 */

const { getWorkspaceSubcollectionRef, resolveFirestore } = require("./firestoreWorkspace");
const { logDetail } = require("./logger");

const RUN_LOCK_COLLECTION = "dealSheetSyncRunLocks";

/**
 * Lease length. A run must refresh within this or it is considered dead.
 *
 * Deliberately well under the 30-min function timeout. A run killed by that timeout never reaches its
 * `finally`, so it cannot release the lock and the lease expiry is the only way the domain frees up —
 * every minute of lease is a minute the next run is blocked. Observed on Aug 19 2026: a run stalled on
 * one Nexus page, was killed at the 30-min timeout, and the lock then sat held until its lease ran
 * out. Refreshes happen every lease/3, so 8 min still tolerates two consecutive failed refreshes.
 */
const DEFAULT_LEASE_MS = 8 * 60 * 1000; // 8 min

/**
 * How stale a heartbeat may get before a takeover is allowed even if the lease has not expired.
 * Must stay above the refresh interval (lease/3) or a healthy run would look dead between beats.
 */
const DEFAULT_HEARTBEAT_GRACE_MS = 4 * 60 * 1000; // 4 min

function lockRef(lockKey, firestore) {
  const key = lockKey == null ? "" : String(lockKey).trim();
  if (!key) throw new Error("syncRunLock: lockKey is required");
  return getWorkspaceSubcollectionRef(RUN_LOCK_COLLECTION, firestore).doc(key);
}

function toMillis(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  // Firestore Timestamp
  if (typeof value.toMillis === "function") {
    const n = value.toMillis();
    return Number.isFinite(n) ? n : null;
  }
  if (value instanceof Date) {
    const n = value.getTime();
    return Number.isFinite(n) ? n : null;
  }
  const n = Date.parse(String(value));
  return Number.isFinite(n) ? n : null;
}

/**
 * True when an existing lock is dead and may be taken over: either its lease has expired, or its
 * heartbeat has gone quiet for longer than the grace period. The heartbeat check catches a run that
 * took the lock and then died without ever refreshing, without waiting out the full lease.
 */
function isLockStale(data, nowMs, { leaseMs, heartbeatGraceMs }) {
  if (!data) return true;
  const expiresAtMs = toMillis(data.expiresAt);
  const heartbeatAtMs = toMillis(data.heartbeatAt) ?? toMillis(data.acquiredAt);

  if (expiresAtMs != null && nowMs >= expiresAtMs) return true;
  if (heartbeatAtMs != null && nowMs - heartbeatAtMs > heartbeatGraceMs) return true;
  // No usable timestamps at all — a malformed doc must not wedge the domain permanently.
  if (expiresAtMs == null && heartbeatAtMs == null) return true;
  // Defensive: a lease longer than configured means the doc was written by something else.
  if (expiresAtMs != null && expiresAtMs - nowMs > leaseMs * 4) return true;
  return false;
}

/**
 * Try to take the lock for `lockKey`.
 *
 * Atomic: the read and the write happen in one Firestore transaction, so two runs racing here cannot
 * both win — that is the whole point, and why this cannot be done with get-then-set.
 *
 * @param {string} lockKey - one lock per thing that must not overlap (e.g. "insert-health")
 * @param {object} [options]
 * @param {string} [options.runId] - identifies the holder in logs / for release
 * @param {number} [options.leaseMs]
 * @param {number} [options.heartbeatGraceMs]
 * @param {number} [options.nowMs] - injectable clock, for tests
 * @param {object} [options.firestore]
 * @returns {Promise<{acquired: boolean, runId: string|null, heldBy: string|null, reason: string,
 *                    expiresAtMs: number|null, tookOverStaleLock: boolean}>}
 */
async function acquireRunLock(lockKey, options = {}) {
  const fs = resolveFirestore(options.firestore);
  const ref = lockRef(lockKey, options.firestore);
  const leaseMs = Number.isFinite(options.leaseMs) ? Number(options.leaseMs) : DEFAULT_LEASE_MS;
  const heartbeatGraceMs = Number.isFinite(options.heartbeatGraceMs)
    ? Number(options.heartbeatGraceMs)
    : DEFAULT_HEARTBEAT_GRACE_MS;
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const runId =
    typeof options.runId === "string" && options.runId.trim() !== ""
      ? options.runId.trim()
      : `${nowMs}-${Math.random().toString(36).slice(2, 10)}`;

  try {
    return await fs.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap && typeof snap.data === "function" ? snap.data() : null;
      const exists = snap ? snap.exists !== false && data != null : false;

      if (exists && !isLockStale(data, nowMs, { leaseMs, heartbeatGraceMs })) {
        return {
          acquired: false,
          runId: null,
          heldBy: data.runId == null ? null : String(data.runId),
          reason: "already held by a live run",
          expiresAtMs: toMillis(data.expiresAt),
          tookOverStaleLock: false,
        };
      }

      const tookOverStaleLock = exists;
      const expiresAtMs = nowMs + leaseMs;
      tx.set(ref, {
        runId,
        lockKey: String(lockKey).trim(),
        acquiredAt: new Date(nowMs),
        heartbeatAt: new Date(nowMs),
        expiresAt: new Date(expiresAtMs),
        leaseMs,
        // Kept for forensics: which run was displaced, if any.
        previousRunId: tookOverStaleLock && data?.runId != null ? String(data.runId) : null,
      });

      return {
        acquired: true,
        runId,
        heldBy: runId,
        reason: tookOverStaleLock ? "took over a stale lock" : "acquired",
        expiresAtMs,
        tookOverStaleLock,
      };
    });
  } catch (err) {
    // A lock we cannot evaluate must not silently become "no lock" — that is exactly the state that
    // let two runs overlap. Refuse to run instead.
    logDetail(
      `[sync run lock] acquire FAILED for ${lockKey} (refusing to start): ${String(err?.message || err).slice(0, 200)}`
    );
    return {
      acquired: false,
      runId: null,
      heldBy: null,
      reason: `lock unavailable: ${String(err?.message || err).slice(0, 120)}`,
      expiresAtMs: null,
      tookOverStaleLock: false,
    };
  }
}

/**
 * Push the lease out. Only the holder may refresh — a run that lost its lock to a takeover must not
 * quietly reclaim it, or both runs would believe they hold it.
 *
 * @returns {Promise<{refreshed: boolean, expiresAtMs: number|null, reason: string}>}
 */
async function refreshRunLock(lockKey, runId, options = {}) {
  const holder = runId == null ? "" : String(runId).trim();
  if (!holder) return { refreshed: false, expiresAtMs: null, reason: "no runId" };

  const fs = resolveFirestore(options.firestore);
  const ref = lockRef(lockKey, options.firestore);
  const leaseMs = Number.isFinite(options.leaseMs) ? Number(options.leaseMs) : DEFAULT_LEASE_MS;
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();

  try {
    return await fs.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap && typeof snap.data === "function" ? snap.data() : null;
      if (!data || String(data.runId ?? "") !== holder) {
        return { refreshed: false, expiresAtMs: null, reason: "lock no longer held by this run" };
      }
      const expiresAtMs = nowMs + leaseMs;
      tx.set(
        ref,
        { heartbeatAt: new Date(nowMs), expiresAt: new Date(expiresAtMs) },
        { merge: true }
      );
      return { refreshed: true, expiresAtMs, reason: "refreshed" };
    });
  } catch (err) {
    // Non-fatal: the run keeps going and the lease simply ages. Worst case it expires and another
    // run may take over, which is the designed failure mode.
    logDetail(
      `[sync run lock] refresh failed for ${lockKey} (run continues): ${String(err?.message || err).slice(0, 200)}`
    );
    return { refreshed: false, expiresAtMs: null, reason: "refresh error" };
  }
}

/**
 * Release the lock, but only if this run still holds it. Deleting unconditionally would let a
 * finishing run wipe the lock a newer run had already taken over.
 *
 * @returns {Promise<{released: boolean, reason: string}>}
 */
async function releaseRunLock(lockKey, runId, options = {}) {
  const holder = runId == null ? "" : String(runId).trim();
  if (!holder) return { released: false, reason: "no runId" };

  const fs = resolveFirestore(options.firestore);
  const ref = lockRef(lockKey, options.firestore);

  try {
    return await fs.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap && typeof snap.data === "function" ? snap.data() : null;
      if (!data) return { released: false, reason: "no lock present" };
      if (String(data.runId ?? "") !== holder) {
        return { released: false, reason: "lock held by another run" };
      }
      tx.delete(ref);
      return { released: true, reason: "released" };
    });
  } catch (err) {
    // Non-fatal: the lease expiry is the backstop, so a failed release delays the next run by at
    // most one lease rather than losing the lock permanently.
    logDetail(
      `[sync run lock] release failed for ${lockKey} (lease will expire): ${String(err?.message || err).slice(0, 200)}`
    );
    return { released: false, reason: "release error" };
  }
}

/**
 * Run `fn` while holding the lock, releasing it afterwards even if `fn` throws.
 *
 * When the lock is already held this does NOT run `fn` and does NOT throw — it returns
 * `{ ran: false }`. A second run arriving is normal operation (a manual re-run on top of a live
 * one), not an error to alert on.
 *
 * @param {string} lockKey
 * @param {object} options - as acquireRunLock, plus optional `label` for logs
 * @param {() => Promise<any>} fn
 * @returns {Promise<{ran: boolean, result: any, lock: object}>}
 */
async function withRunLock(lockKey, options, fn) {
  const label = typeof options?.label === "string" && options.label ? options.label : lockKey;
  const lock = await acquireRunLock(lockKey, options);

  if (!lock.acquired) {
    logDetail(
      `[sync run lock] ${label}: SKIPPED — ${lock.reason}` +
        (lock.heldBy ? ` (holder=${lock.heldBy})` : "") +
        (lock.expiresAtMs ? ` leaseExpires=${new Date(lock.expiresAtMs).toISOString()}` : "")
    );
    return { ran: false, result: null, lock };
  }

  logDetail(
    `[sync run lock] ${label}: acquired runId=${lock.runId}` +
      (lock.tookOverStaleLock ? " (took over a stale lock)" : "") +
      (lock.expiresAtMs ? ` leaseExpires=${new Date(lock.expiresAtMs).toISOString()}` : "")
  );

  // Keep the lease alive for as long as the body runs. Without this a long run (the incident's run
  // took 63 minutes, four times the default lease) would let its own lock expire and a second run
  // could take over while it was still writing — the very overlap this is meant to prevent.
  // Refresh at a third of the lease so a couple of failed refreshes in a row are survivable.
  const leaseMs = Number.isFinite(options?.leaseMs) ? Number(options.leaseMs) : DEFAULT_LEASE_MS;
  // Injectable so a test can drive the heartbeat without waiting out a real interval.
  const heartbeatEveryMs = Number.isFinite(options?.heartbeatIntervalMs)
    ? Number(options.heartbeatIntervalMs)
    : Math.max(30_000, Math.floor(leaseMs / 3));
  const heartbeat = setInterval(() => {
    // Drop any pinned `nowMs` from options: a heartbeat must advance the lease against the real
    // clock, otherwise it would keep rewriting the same expiry it started with.
    const { nowMs: _pinned, ...refreshOptions } = options || {};
    refreshRunLock(lockKey, lock.runId, refreshOptions).catch(() => {});
  }, heartbeatEveryMs);
  // Never hold the process open on this timer alone.
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  try {
    const result = await fn({ runId: lock.runId, lockKey });
    return { ran: true, result, lock };
  } finally {
    clearInterval(heartbeat);
    const released = await releaseRunLock(lockKey, lock.runId, options);
    logDetail(`[sync run lock] ${label}: ${released.released ? "released" : released.reason}`);
  }
}

module.exports = {
  RUN_LOCK_COLLECTION,
  DEFAULT_LEASE_MS,
  DEFAULT_HEARTBEAT_GRACE_MS,
  acquireRunLock,
  refreshRunLock,
  releaseRunLock,
  withRunLock,
  isLockStale,
};
