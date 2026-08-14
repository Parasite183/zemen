// ─────────────────────────────────────────────────────────────────────
// Reputation / credit-history engine.
//
// Every resolved transaction feeds a visible track record:
//   completion rate, on-time rate, dispute rate, total volume.
// Recent activity is weighted more heavily (6-month half-life decay)
// so a user's score reflects who they are NOW, not years ago.
//
// Anti-gaming: patterns typical of fake/colluding transactions are
// flagged for moderator review rather than silently counted:
//   • one-sided concentration (nearly all volume with one counterparty)
//   • frequent disputes
// ─────────────────────────────────────────────────────────────────────
import { db } from '../db.js';

const HALF_LIFE_DAYS = 180;

/** Recency weight: 1.0 now, 0.5 after 6 months, 0.25 after a year. */
function recencyWeight(iso) {
  const ageDays = (Date.now() - Date.parse(iso)) / 86400000;
  if (!Number.isFinite(ageDays) || ageDays < 0) return 1;
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

function deadlineEnd(deadline) {
  if (!deadline) return null;
  // date-only deadline ("2026-08-20") counts as end of that day (UTC)
  return /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? Date.parse(`${deadline}T23:59:59Z`) : Date.parse(deadline);
}

/**
 * Recompute and persist a user's reputation. Returns the computed object.
 */
export async function computeReputation(userId) {
  const deals = await db.all(
    `SELECT * FROM transactions
     WHERE (party_a_id = ? OR party_b_id = ?) AND status IN ('confirmed', 'failed')`,
    [userId, userId]
  );

  const disputes = await db.all(
    `SELECT d.* FROM disputes d
     JOIN transactions t ON t.id = d.transaction_id
     WHERE (t.party_a_id = ? OR t.party_b_id = ?) AND d.status = 'resolved'`,
    [userId, userId]
  );

  let wCompleted = 0, wFailed = 0, wOnTime = 0, wVolume = 0, wDisputed = 0;
  let completed = 0, failed = 0, totalVolume = 0;
  const volumeByCounterparty = {};

  for (const d of deals) {
    const w = recencyWeight(d.confirmed_at || d.failed_at || d.created_at);
    if (d.status === 'confirmed') {
      wCompleted += w;
      wVolume += d.amount * w;
      totalVolume += d.amount;
      completed += 1;
      const onTime = !d.deadline || (d.delivered_at && Date.parse(d.delivered_at) <= deadlineEnd(d.deadline));
      if (onTime) wOnTime += w;
      const other = d.party_a_id === userId ? d.party_b_id : d.party_a_id;
      volumeByCounterparty[other] = (volumeByCounterparty[other] || 0) + d.amount;
    } else {
      wFailed += w;
      failed += 1;
    }
  }

  for (const dis of disputes) wDisputed += recencyWeight(dis.resolved_at || dis.created_at);

  const completionRate = wCompleted + wFailed > 0 ? wCompleted / (wCompleted + wFailed) : 0;
  const onTimeRate = wCompleted > 0 ? wOnTime / wCompleted : 0;
  const disputeRate = wCompleted + wDisputed > 0 ? wDisputed / (wCompleted + wDisputed) : 0;

  // ── anti-gaming flags ─────────────────────────────────────────────
  const flags = [];
  const volTotal = Object.values(volumeByCounterparty).reduce((a, b) => a + b, 0);
  if (volTotal > 0 && completed >= 3) {
    const topShare = Math.max(...Object.values(volumeByCounterparty)) / volTotal;
    if (topShare > 0.7) {
      flags.push({ code: 'one_sided_concentration', label: 'Unusually one-sided pattern — possible collusion' });
    }
  }
  if (disputes.length >= 2 && disputeRate > 0.5) {
    flags.push({ code: 'frequent_disputes', label: 'Frequent dispute involvement' });
  }

  const scores = {
    user_id: userId,
    completion_rate: round(completionRate),
    on_time_rate: round(onTimeRate),
    dispute_rate: round(disputeRate),
    total_volume: round(totalVolume),
    total_completed: completed,
    total_failed: failed,
    total_disputed: disputes.length,
    weighted_volume: round(wVolume),
    flags_json: JSON.stringify(flags),
    last_updated: new Date().toISOString(),
  };

  await db.run(
    `INSERT INTO reputation_scores
       (user_id, completion_rate, on_time_rate, dispute_rate, total_volume,
        total_completed, total_failed, total_disputed, weighted_volume, flags_json, last_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       completion_rate = excluded.completion_rate,
       on_time_rate = excluded.on_time_rate,
       dispute_rate = excluded.dispute_rate,
       total_volume = excluded.total_volume,
       total_completed = excluded.total_completed,
       total_failed = excluded.total_failed,
       total_disputed = excluded.total_disputed,
       weighted_volume = excluded.weighted_volume,
       flags_json = excluded.flags_json,
       last_updated = excluded.last_updated`,
    Object.values(scores)
  );

  return { ...scores, flags };
}

export async function getReputation(userId) {
  return db.get('SELECT * FROM reputation_scores WHERE user_id = ?', [userId]);
}

// Fraud flags are owned by services/anti-fraud.js (clique / velocity /
// device & IP clusters). They layer on top of the flags computed here,
// which stay untouched. Flag codes in this set are replaced on every
// fraud re-run so stale signals don't linger.
const FRAUD_CODES = new Set(['closed_loop_clique', 'velocity_suspicious', 'device_cluster', 'ip_cluster']);

/**
 * Merge graph/velocity/cluster fraud flags into a user's reputation row,
 * preserving the reputation-derived flags. Upserts a minimal row when the
 * user has no reputation yet (e.g. brand-new clustered accounts).
 */
export async function mergeFraudFlags(userId, fraudFlags) {
  const existing = await getReputation(userId);
  const base = existing ? JSON.parse(existing.flags_json || '[]').filter((f) => !FRAUD_CODES.has(f.code)) : [];
  const merged = [...base, ...fraudFlags];
  const now = new Date().toISOString();
  if (existing) {
    await db.run(`UPDATE reputation_scores SET flags_json = ?, last_updated = ? WHERE user_id = ?`, [JSON.stringify(merged), now, userId]);
  } else {
    await db.run(
      `INSERT INTO reputation_scores (user_id, flags_json, last_updated) VALUES (?, ?, ?)`,
      [userId, JSON.stringify(merged), now]
    );
  }
}

const round = (n) => Math.round(n * 10000) / 10000;
