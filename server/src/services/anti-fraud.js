// ─────────────────────────────────────────────────────────────────────
// Anti-gaming detection beyond the per-user reputation flags.
//
// Three graph/velocity checks surface coordinated, fabricated history
// to moderators — each with a specific, explainable signal:
//   • closed_loop_clique   — a connected group that mostly trades with
//                            itself (few outside parties)
//   • velocity_suspicious  — a verified/signed-up account that racked up
//                            many confirmed deals within 48h
//   • device_cluster / ip_cluster — several new accounts from the same
//                            device fingerprint or narrow IP range
//
// These are simple connected-components + edge-density checks, exactly
// as appropriate for an MVP — no graph-ML.
// ─────────────────────────────────────────────────────────────────────
import { db } from '../db.js';
import { mergeFraudFlags } from './reputation.js';

const CLIQUE_MIN_MEMBERS = 3;
const CLIQUE_MIN_DENSITY = 0.5;          // internal edges / possible edges
const VELOCITY_DEALS = 10;               // confirmed deals…
const VELOCITY_WINDOW_MS = 48 * 3600e3;  // …within 48 hours
const CLUSTER_MIN_ACCOUNTS = 3;          // accounts sharing a signal…
const CLUSTER_WINDOW_MS = 7 * 86400e3;   // …created within 7 days

// Union-find so we can extract connected components cheaply.
class UnionFind {
  constructor() { this.parent = new Map(); }
  find(x) { if (!this.parent.has(x)) this.parent.set(x, x); while (this.parent.get(x) !== x) { this.parent.set(x, this.parent.get(this.parent.get(x))); x = this.parent.get(x); } return x; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent.set(ra, rb); }
}

/** Connected components of the confirmed/failed transaction graph. */
function componentsOf(deals) {
  const uf = new UnionFind();
  for (const d of deals) uf.union(d.party_a_id, d.party_b_id);
  const comps = new Map();
  for (const d of deals) {
    for (const uid of [d.party_a_id, d.party_b_id]) {
      const root = uf.find(uid);
      if (!comps.has(root)) comps.set(root, new Set());
      comps.get(root).add(uid);
    }
  }
  return [...comps.values()];
}

/**
 * Flag every member of a small, dense, mostly-closed trading group.
 * Returns a map userId -> flag descriptor.
 */
export function detectCliques(deals) {
  const flags = new Map();
  const edges = new Set();
  for (const d of deals) edges.add(`${Math.min(d.party_a_id, d.party_b_id)}:${Math.max(d.party_a_id, d.party_b_id)}`);

  for (const comp of componentsOf(deals)) {
    const members = [...comp];
    if (members.length < CLIQUE_MIN_MEMBERS) continue;
    const possible = (members.length * (members.length - 1)) / 2;
    let internal = 0;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        if (edges.has(`${Math.min(members[i], members[j])}:${Math.max(members[i], members[j])}`)) internal++;
      }
    }
    const density = internal / possible;
    if (density >= CLIQUE_MIN_DENSITY) {
      const desc = {
        code: 'closed_loop_clique',
        label: `Part of a closed trading clique (${members.length} accounts, ${Math.round(density * 100)}% internal) — possible coordinated accounts`,
      };
      for (const uid of members) flags.set(uid, desc);
    }
  }
  return flags;
}

/** Flag accounts whose confirmation history is implausibly fast. */
export async function detectVelocity() {
  const rows = await db.all(
    `SELECT u.id, u.verified_at, u.created_at, t.status, t.confirmed_at
     FROM users u
     LEFT JOIN transactions t ON (t.party_a_id = u.id OR t.party_b_id = u.id)`
  );
  const counts = new Map(); // userId -> fast confirmations
  for (const r of rows) {
    if (r.status !== 'confirmed' || !r.confirmed_at) continue;
    const t0 = r.verified_at || r.created_at; // signup or verification
    if (!t0) continue;
    const confirmedMs = Date.parse(r.confirmed_at);
    if (confirmedMs >= Date.parse(t0) && confirmedMs <= Date.parse(t0) + VELOCITY_WINDOW_MS) {
      counts.set(r.id, (counts.get(r.id) || 0) + 1);
    }
  }
  const flags = new Map();
  for (const [uid, n] of counts) {
    if (n >= VELOCITY_DEALS) {
      flags.set(uid, {
        code: 'velocity_suspicious',
        label: `${n} confirmed deals within 48 hours of signup/verification — implausibly fast trust-building`,
      });
    }
  }
  return flags;
}

/** Flag clusters of new accounts sharing a device fingerprint or /24 IP. */
export async function detectClusters() {
  const flags = new Map();
  const users = await db.all(
    `SELECT id, device_fingerprint, signup_ip, created_at FROM users
     WHERE device_fingerprint <> '' OR signup_ip <> ''`
  );
  const windowStart = new Date(Date.now() - CLUSTER_WINDOW_MS).toISOString();

  const group = (keyFn, code, kind) => {
    const buckets = new Map();
    for (const u of users) {
      const key = keyFn(u);
      if (!key) continue;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(u);
    }
    for (const [key, list] of buckets) {
      const fresh = list.filter((u) => u.created_at >= windowStart);
      if (fresh.length >= CLUSTER_MIN_ACCOUNTS) {
        const desc = {
          code,
          label: `${fresh.length} new accounts share the same ${kind} (${key}) — possible duplicate accounts`,
        };
        for (const u of fresh) flags.set(u.id, desc);
      }
    }
  };

  group((u) => u.device_fingerprint, 'device_cluster', 'device fingerprint');
  group((u) => u.signup_ip, 'ip_cluster', 'IP range');
  return flags;
}

/**
 * Recompute every graph/velocity/cluster flag and merge them into each
 * affected user's reputation flags (layered on top of the per-user
 * reputation flags, which are owned by computeReputation). Call after
 * reputation recomputes (deal confirmed / dispute resolved) or from the
 * moderator refresh endpoint.
 */
export async function runFraudChecks() {
  const deals = await db.all(
    `SELECT party_a_id, party_b_id, status, confirmed_at FROM transactions
     WHERE status IN ('confirmed', 'failed')`
  );
  const all = new Map();
  for (const m of [detectCliques(deals), await detectVelocity(), await detectClusters()]) {
    for (const [uid, desc] of m) all.set(uid, desc);
  }
  for (const [uid, desc] of all) {
    await mergeFraudFlags(uid, [desc]);
  }
  return { flaggedUsers: all.size };
}
