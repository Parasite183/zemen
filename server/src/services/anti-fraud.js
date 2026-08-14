// ─────────────────────────────────────────────────────────────────────
// Anti-gaming detection beyond the per-user reputation flags.
//
// Four graph/velocity checks surface coordinated, fabricated history
// to moderators — each with a specific, explainable signal:
//   • closed_loop_clique   — a connected group that mostly trades with
//                            itself (few outside parties)
//   • velocity_suspicious  — a verified/signed-up account that racked up
//                            many confirmed deals within 48h
//   • device_cluster / ip_cluster — several new accounts from the same
//                            device fingerprint or narrow IP range
//   • hub_spoke_pattern    — a low-density star network where most
//                            spokes were created in a tight window
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
const HUB_SPOKE_MIN_MEMBERS = CLUSTER_MIN_ACCOUNTS + 1; // hub + ≥ CLUSTER_MIN_ACCOUNTS spokes
const HUB_SPOKE_MIN_HUB_SHARE = 0.8;     // one node touches ≥ 80% of the component's edges
const HUB_SPOKE_MIN_FRESH_SHARE = 0.7;   // …and ≥70% of the spokes…
const HUB_SPOKE_FRESH_WINDOW_MS = CLUSTER_WINDOW_MS; // …were created within this window of each other

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
 * Extract dense, mostly-closed trading groups: connected components with
 * enough internal edges. Structured form powers the moderator cluster
 * view; detectCliques turns it into per-user flags.
 */
export function cliqueGroups(deals) {
  const groups = [];
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
    if (density >= CLIQUE_MIN_DENSITY) groups.push({ members, internal, possible, density });
  }
  return groups;
}

/**
 * Flag every member of a small, dense, mostly-closed trading group.
 * Returns a map userId -> flag descriptor.
 */
export function detectCliques(deals) {
  const flags = new Map();
  for (const g of cliqueGroups(deals)) {
    const desc = {
      code: 'closed_loop_clique',
      label: `Part of a closed trading clique (${g.members.length} accounts, ${Math.round(g.density * 100)}% internal) — possible coordinated accounts`,
    };
    for (const uid of g.members) flags.set(uid, desc);
  }
  return flags;
}

/**
 * Extract freshly fabricated star networks: low-density connected
 * components (ones that FAIL the clique density bar) where a single
 * node accounts for most of the internal edges AND most spokes were
 * created within a tight window of each other. Graph shape alone can't
 * separate a fraud ring from a popular vendor with many one-time
 * clients, so the spoke creation-time clustering is what makes this a
 * fraud signal. Structured form powers the moderator cluster view;
 * detectHubSpokes turns it into a per-user flag on the hub only.
 */
export function hubSpokeGroups(deals, users) {
  const groups = [];
  const edges = new Set();
  for (const d of deals) edges.add(`${Math.min(d.party_a_id, d.party_b_id)}:${Math.max(d.party_a_id, d.party_b_id)}`);

  const createdById = new Map();
  for (const u of users || []) {
    const t = Date.parse(u.created_at);
    if (Number.isFinite(t)) createdById.set(u.id, t);
  }

  for (const comp of componentsOf(deals)) {
    const members = [...comp];
    if (members.length < HUB_SPOKE_MIN_MEMBERS) continue;
    const possible = (members.length * (members.length - 1)) / 2;
    let internal = 0;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        if (edges.has(`${Math.min(members[i], members[j])}:${Math.max(members[i], members[j])}`)) internal++;
      }
    }
    if (internal === 0) continue;
    const density = internal / possible;
    if (density >= CLIQUE_MIN_DENSITY) continue; // dense enough to read as a clique — not hub-spoke

    let hub = null, hubShare = 0;
    for (let i = 0; i < members.length; i++) {
      let incident = 0;
      for (let j = 0; j < members.length; j++) {
        if (i === j) continue;
        if (edges.has(`${Math.min(members[i], members[j])}:${Math.max(members[i], members[j])}`)) incident++;
      }
      const share = incident / internal;
      if (share > hubShare) { hubShare = share; hub = members[i]; }
    }
    if (hubShare < HUB_SPOKE_MIN_HUB_SHARE) continue;

    // Freshness gate: a majority of the spokes must have been created
    // within a tight window of each other. A popular vendor's clients
    // sign up organically, months apart; a fabricated ring is minted in
    // a burst. Spokes without a usable created_at simply don't count
    // toward the majority (conservative: they dilute it).
    const spokeTimes = members
      .filter((m) => m !== hub)
      .map((m) => createdById.get(m))
      .filter((t) => t !== undefined)
      .sort((a, b) => a - b);
    let best = 0, lo = 0;
    for (let hi = 0; hi < spokeTimes.length; hi++) {
      while (spokeTimes[hi] - spokeTimes[lo] > HUB_SPOKE_FRESH_WINDOW_MS) lo++;
      best = Math.max(best, hi - lo + 1);
    }
    const freshShare = best / (members.length - 1);
    if (freshShare < HUB_SPOKE_MIN_FRESH_SHARE) continue;

    groups.push({ hub, members, internal, possible, density, hubShare, freshShare });
  }
  return groups;
}

/**
 * Flag the hub of a freshly fabricated star network. Only the hub is
 * flagged — the spokes stay visible as members in the cluster view — so
 * a ring produces one flag rather than one per account.
 */
export function detectHubSpokes(deals, users) {
  const flags = new Map();
  for (const g of hubSpokeGroups(deals, users)) {
    flags.set(g.hub, {
      code: 'hub_spoke_pattern',
      label: `Hub of a low-density star network (${g.members.length} accounts, ${Math.round(g.freshShare * 100)}% of spokes created in a ${Math.round(HUB_SPOKE_FRESH_WINDOW_MS / 86400000)}-day window) — possible freshly fabricated network`,
    });
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

/**
 * Pure grouping: accounts sharing a device fingerprint or /24 IP prefix,
 * split into "fresh" (created within the cluster window) and older ones.
 * Structured form powers the moderator cluster view; detectClusters turns
 * it into per-user flags.
 */
export function clusterGroups(users, windowStart) {
  const bucket = (keyFn) => {
    const buckets = new Map();
    for (const u of users) {
      const key = keyFn(u);
      if (!key) continue;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(u);
    }
    return [...buckets.entries()].map(([key, list]) => ({ key, fresh: list.filter((u) => u.created_at >= windowStart) }));
  };
  return { device: bucket((u) => u.device_fingerprint), ip: bucket((u) => u.signup_ip) };
}

/** Flag clusters of new accounts sharing a device fingerprint or /24 IP. */
export async function detectClusters() {
  const flags = new Map();
  const users = await db.all(
    `SELECT id, device_fingerprint, signup_ip, created_at FROM users
     WHERE device_fingerprint <> '' OR signup_ip <> ''`
  );
  const windowStart = new Date(Date.now() - CLUSTER_WINDOW_MS).toISOString();
  const { device, ip } = clusterGroups(users, windowStart);

  const mark = (groups, code, kind) => {
    for (const { key, fresh } of groups) {
      if (fresh.length < CLUSTER_MIN_ACCOUNTS) continue;
      const desc = {
        code,
        label: `${fresh.length} new accounts share the same ${kind} (${key}) — possible duplicate accounts`,
      };
      for (const u of fresh) flags.set(u.id, desc);
    }
  };
  mark(device, 'device_cluster', 'device fingerprint');
  mark(ip, 'ip_cluster', 'IP range');
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
  const users = await db.all(`SELECT id, created_at FROM users`);
  const all = new Map();
  for (const m of [detectCliques(deals), detectHubSpokes(deals, users), await detectVelocity(), await detectClusters()]) {
    for (const [uid, desc] of m) all.set(uid, desc);
  }
  for (const [uid, desc] of all) {
    await mergeFraudFlags(uid, [desc]);
  }
  return { flaggedUsers: all.size };
}

/**
 * Structured cluster data for the moderator review screen — the same
 * signals detectCliques / detectHubSpokes / detectClusters /
 * detectVelocity produce, but with the actual member accounts attached
 * so a reviewer can act on a whole group rather than reading flag
 * labels.
 */
export async function fraudClustersForReview() {
  // No name filter here (unlike flaggedAccounts): fresh, unnamed
  // placeholder accounts are exactly the ones worth clustering.
  const [deals, users, allUsers] = await Promise.all([
    db.all(`SELECT party_a_id, party_b_id FROM transactions WHERE status IN ('confirmed', 'failed')`),
    db.all(`SELECT id, name, device_fingerprint, signup_ip, created_at FROM users WHERE device_fingerprint <> '' OR signup_ip <> ''`),
    // All users, not just fingerprint-bearing ones: the hub-spoke
    // freshness gate needs every member's created_at.
    db.all(`SELECT id, created_at FROM users`),
  ]);
  const windowStart = new Date(Date.now() - CLUSTER_WINDOW_MS).toISOString();
  const nameOf = (id) => users.find((u) => u.id === id)?.name || 'Unnamed user';
  const member = (id) => ({ id, name: nameOf(id) });

  const cliques = cliqueGroups(deals).map((g) => ({ ...g, members: g.members.map(member) }));
  const hubSpokes = hubSpokeGroups(deals, allUsers).map((g) => ({ ...g, hub: member(g.hub), members: g.members.map(member) }));

  const withUsers = (groups) =>
    groups
      .filter((g) => g.fresh.length >= CLUSTER_MIN_ACCOUNTS)
      .map((g) => ({
        key: g.key,
        users: g.fresh.map((u) => ({ id: u.id, name: u.name || 'Unnamed user', created_at: u.created_at })),
      }));
  const { device, ip } = clusterGroups(users, windowStart);

  const velocity = [];
  for (const [uid, desc] of await detectVelocity()) velocity.push({ user: member(uid), label: desc.label });

  return { cliques, hubSpokes, device: withUsers(device), ip: withUsers(ip), velocity };
}
