// Structured dispute resolution:
//   raise → both parties submit statements + evidence → vetted moderators
//   vote → outcome applied (deal confirmed or failed, escrow released or
//   refunded) and permanently logged against both users' records.
//
// Dispute hardening (this file, disputes only):
//   • independence guards — a moderator must never have transacted with
//     either party and must not share a device/IP cluster with them;
//     blocked attempts are logged to dispute_moderator_log
//   • quorum — high-value disputes need 3 independent votes before any
//     majority can resolve them (small disputes resolve on 1 vote)
//   • appeal path — the losing party gets exactly one appeal, judged by
//     a fresh panel that excludes everyone who voted on the original
import { db } from '../db.js';
import { appendLedger } from '../ledger.js';
import { nowIso } from '../crypto.js';
import { getDeal } from './deals.js';
import { markDisputed } from './deals.js';
import paymentsProvider from '../providers/payments.js';
import smsProvider from '../providers/sms.js';
import { computeReputation } from './reputation.js';
import { runFraudChecks, clusterGroups } from './anti-fraud.js';
import { badRequest, notFound, forbidden, conflict } from '../http.js';

// High-value disputes must be decided by a panel of at least this many
// independent moderators; smaller ones resolve on a single vote to stay
// cheap. Threshold is in ETB, mirroring the deal-eligibility thresholds
// in config.js (all demo/live deals are ETB-denominated).
export const HIGH_VALUE_THRESHOLD_ETB = 2000;
export const QUORUM_HIGH_VALUE = 3;
export const QUORUM_LOW_VALUE = 1;
export const MAX_APPEALS = 1;

export async function createDispute({ transactionId, raisedBy, reason }) {
  const deal = await getDeal(transactionId);
  if (!deal) throw notFound('Deal not found');
  const isParty = deal.party_a_id === raisedBy || deal.party_b_id === raisedBy;
  if (!isParty) throw forbidden('Only parties can raise a dispute');
  if (!['agreed', 'in_progress', 'delivered'].includes(deal.status)) {
    throw conflict('This deal is not disputable right now');
  }
  const existing = await db.get('SELECT * FROM disputes WHERE transaction_id = ? AND status = ?', [transactionId, 'open']);
  if (existing) throw conflict('A dispute for this deal is already open');

  const now = nowIso();
  const { lastId } = await db.run(
    `INSERT INTO disputes (transaction_id, raised_by, reason, status, created_at) VALUES (?, ?, ?, 'open', ?)`,
    [transactionId, raisedBy, reason || '', now]
  );
  await markDisputed(transactionId);
  await appendLedger('dispute_raised', { txId: transactionId, userId: raisedBy, payload: { dispute: lastId, reason: reason || '' } });
  return getDisputeDetail(lastId);
}

export async function getDispute(id) {
  return db.get('SELECT * FROM disputes WHERE id = ?', [id]);
}

export async function getDisputeDetail(id) {
  const d = await getDispute(id);
  if (!d) return null;
  const [tx, statements, evidence, votes] = await Promise.all([
    getDeal(d.transaction_id),
    db.all('SELECT * FROM dispute_statements WHERE dispute_id = ? ORDER BY id ASC', [id]),
    db.all('SELECT * FROM dispute_evidence WHERE dispute_id = ? ORDER BY id ASC', [id]),
    db.all(`SELECT v.*, u.name AS moderator_name FROM dispute_votes v JOIN users u ON u.id = v.moderator_id WHERE v.dispute_id = ? ORDER BY v.id ASC`, [id]),
  ]);
  // Appeals carry the original case's outcome so the fresh panel can
  // judge the reversal on the record. appeal_of can only point at an
  // original (appeals are capped at one per case), so no recursion.
  const original = d.appeal_of
    ? await db.get('SELECT id, verdict, resolution, resolved_at, appeal_of FROM disputes WHERE id = ?', [d.appeal_of])
    : null;
  const moderators = await db.all("SELECT id, name FROM users WHERE is_moderator = 1");
  return { ...d, transaction: tx, statements, evidence, votes, moderators, original };
}

export async function addStatement(disputeId, user, body) {
  const d = await getDispute(disputeId);
  if (!d) throw notFound('Dispute not found');
  if (d.status === 'resolved') throw conflict('Dispute is already resolved');
  const deal = await getDeal(d.transaction_id);
  const isParty = deal && (deal.party_a_id === user.id || deal.party_b_id === user.id);
  if (!isParty && !user.is_moderator) throw forbidden('Only parties and moderators can post');
  if (!body || !body.trim()) throw badRequest('Statement cannot be empty');
  await db.run(`INSERT INTO dispute_statements (dispute_id, user_id, body, created_at) VALUES (?, ?, ?, ?)`,
    [disputeId, user.id, body.trim(), nowIso()]);
  return getDisputeDetail(disputeId);
}

export async function addEvidence(disputeId, user, file) {
  const d = await getDispute(disputeId);
  if (!d) throw notFound('Dispute not found');
  if (d.status === 'resolved') throw conflict('Dispute is already resolved');
  const deal = await getDeal(d.transaction_id);
  const isParty = deal && (deal.party_a_id === user.id || deal.party_b_id === user.id);
  if (!isParty) throw forbidden('Only parties can attach evidence');
  await db.run(`INSERT INTO dispute_evidence (dispute_id, user_id, file_path, file_name, created_at) VALUES (?, ?, ?, ?, ?)`,
    [disputeId, user.id, file.path.replaceAll('\\', '/'), file.originalname || 'file', nowIso()]);
  return getDisputeDetail(disputeId);
}

// ── moderation ──────────────────────────────────────────────────────
export async function moderatorQueue() {
  return db.all(
    `SELECT d.*, t.ref AS deal_ref, t.description AS deal_description, t.amount, t.currency,
            ua.name AS party_a_name, ub.name AS party_b_name
     FROM disputes d
     JOIN transactions t ON t.id = d.transaction_id
     JOIN users ua ON ua.id = t.party_a_id
     JOIN users ub ON ub.id = t.party_b_id
     WHERE d.status = 'open'
     ORDER BY d.id ASC`
  );
}

/** Permanent audit trail of moderator actions blocked by the guards. */
async function logBlockedAttempt(disputeId, moderatorId, reason) {
  await db.run(
    `INSERT INTO dispute_moderator_log (dispute_id, moderator_id, reason, created_at)
     VALUES (?, ?, ?, ?)`,
    [disputeId, moderatorId, reason, nowIso()]
  );
}

/**
 * Independence guard, run before a moderator can act on a dispute:
 * they must never have transacted with either party, must not be a
 * party themselves, and must not share a device/IP cluster with a
 * party (reuses the exact bucketing from anti-fraud.js). There is no
 * separate assignment step in the app — moderators self-select from
 * the queue — so this check at vote time is the enforcement point.
 * A failed check logs the attempt and blocks the vote.
 */
export async function assertModeratorEligible(dispute, moderator) {
  const deal = await getDeal(dispute.transaction_id);
  const parties = [deal.party_a_id, deal.party_b_id];

  // A moderator who is a party to the dispute is maximally conflicted.
  if (parties.includes(moderator.id)) {
    await logBlockedAttempt(dispute.id, moderator.id, 'is_party');
    throw forbidden('You are a party to this dispute');
  }

  // Prior dealings with either party — any deal row, any status.
  const prior = await db.get(
    `SELECT id FROM transactions
     WHERE (party_a_id = ? AND party_b_id IN (?, ?))
        OR (party_b_id = ? AND party_a_id IN (?, ?))
     LIMIT 1`,
    [moderator.id, parties[0], parties[1], moderator.id, parties[0], parties[1]]
  );
  if (prior) {
    await logBlockedAttempt(dispute.id, moderator.id, 'prior_transaction');
    throw forbidden('You have previously transacted with a party to this dispute');
  }

  // Device/IP cluster overlap — same bucketing as anti-fraud.js. The
  // window is irrelevant here (any historical overlap is a conflict),
  // so a far-past windowStart keeps every user in the "fresh" set.
  const users = await db.all(
    `SELECT id, device_fingerprint, signup_ip, created_at FROM users WHERE id IN (?, ?, ?)`,
    [moderator.id, parties[0], parties[1]]
  );
  const { device, ip } = clusterGroups(users, new Date(0).toISOString());
  const sharesCluster = (groups) =>
    groups.some((g) => g.fresh.length > 1 && g.fresh.some((u) => u.id === moderator.id));
  if (sharesCluster(device) || sharesCluster(ip)) {
    await logBlockedAttempt(dispute.id, moderator.id, 'device_ip_cluster');
    throw forbidden('You appear to be in the same device/IP cluster as a party to this dispute');
  }
}

/**
 * A moderator votes for party_a or party_b.
 * Votes are gated by the independence guard, and an appeal's panel
 * excludes everyone who voted on the original case. The dispute
 * resolves only once the quorum is met (3 independent votes for
 * high-value disputes, 1 otherwise) AND a strict majority exists.
 */
export async function castVote(disputeId, moderator, verdict, note = '') {
  const d = await getDispute(disputeId);
  if (!d) throw notFound('Dispute not found');
  if (d.status === 'resolved') throw conflict('Dispute already resolved');
  if (!['party_a', 'party_b'].includes(verdict)) throw badRequest('Verdict must be party_a or party_b');

  await assertModeratorEligible(d, moderator);

  // Appeals escalate to a fresh panel: original voters are excluded.
  if (d.appeal_of) {
    const originalVoters = await db.all(
      'SELECT moderator_id FROM dispute_votes WHERE dispute_id = ?', [d.appeal_of]
    );
    if (originalVoters.some((v) => v.moderator_id === moderator.id)) {
      await logBlockedAttempt(disputeId, moderator.id, 'appeal_original_voter');
      throw forbidden('You voted on the original case and cannot judge its appeal');
    }
  }

  await db.run(
    `INSERT INTO dispute_votes (dispute_id, moderator_id, verdict, note, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(dispute_id, moderator_id) DO UPDATE SET verdict = excluded.verdict, note = excluded.note`,
    [disputeId, moderator.id, verdict, note || '', nowIso()]
  );

  const deal = await getDeal(d.transaction_id);
  const quorum = deal.amount > HIGH_VALUE_THRESHOLD_ETB ? QUORUM_HIGH_VALUE : QUORUM_LOW_VALUE;
  const votes = await db.all('SELECT verdict FROM dispute_votes WHERE dispute_id = ?', [disputeId]);
  const a = votes.filter((v) => v.verdict === 'party_a').length;
  const b = votes.filter((v) => v.verdict === 'party_b').length;

  // Strict majority among a quorum-sized panel; a tie stays open.
  if (votes.length >= quorum && a !== b) {
    await applyResolution(disputeId, a > b ? 'party_a' : 'party_b', 'moderator_vote');
  }
  return getDisputeDetail(disputeId);
}

/**
 * The losing party files exactly one appeal per dispute. The appeal is
 * a fresh open dispute row referencing the original; it is judged by a
 * different panel (original voters are excluded at vote time) and both
 * outcomes stay on the permanent ledger.
 */
export async function requestAppeal(disputeId, user) {
  const d = await getDispute(disputeId);
  if (!d) throw notFound('Dispute not found');
  if (d.appeal_of) throw conflict('Appeals cannot be appealed again');
  if (d.status !== 'resolved') throw conflict('Only a resolved dispute can be appealed');

  const deal = await getDeal(d.transaction_id);
  const isParty = deal.party_a_id === user.id || deal.party_b_id === user.id;
  if (!isParty) throw forbidden('Only parties to this dispute can appeal');
  const loserId = d.verdict === 'party_a' ? deal.party_b_id : deal.party_a_id;
  if (user.id !== loserId) throw forbidden('Only the losing party can appeal');

  const existing = await db.get('SELECT id FROM disputes WHERE appeal_of = ?', [disputeId]);
  if (existing) throw conflict('This dispute has already been appealed'); // cap: one appeal per dispute

  const now = nowIso();
  const { lastId } = await db.run(
    `INSERT INTO disputes (transaction_id, raised_by, reason, status, appeal_of, created_at)
     VALUES (?, ?, ?, 'open', ?, ?)`,
    [deal.id, user.id, `Appeal of dispute #${disputeId} (originally decided for ${d.verdict})`, disputeId, now]
  );
  await db.run('UPDATE disputes SET appealed_at = ? WHERE id = ?', [now, disputeId]);
  await appendLedger('dispute_appealed', {
    txId: deal.id, userId: user.id,
    payload: { dispute: disputeId, appeal: lastId, originalVerdict: d.verdict, originalResolution: d.resolution },
  });
  return getDisputeDetail(lastId);
}

/**
 * Per-moderator track record for internal review: how many disputes
 * they handled, how often their vote matched the majority outcome, and
 * how often a case they helped decide was overturned on appeal. All
 * computed from the auditable vote + resolution history.
 */
export async function moderatorStats() {
  const [mods, votes, appealFlips] = await Promise.all([
    db.all('SELECT id, name FROM users WHERE is_moderator = 1'),
    db.all(
      `SELECT v.moderator_id, v.verdict AS vote_verdict, d.id AS dispute_id,
              d.verdict AS outcome, d.appeal_of, d.status
       FROM dispute_votes v JOIN disputes d ON d.id = v.dispute_id
       WHERE d.status = 'resolved'`
    ),
    db.all(`SELECT appeal_of, verdict FROM disputes WHERE appeal_of IS NOT NULL AND status = 'resolved'`),
  ]);

  // Original dispute id -> appeal verdict (only resolved appeals count).
  const flipped = new Map();
  for (const ap of appealFlips) flipped.set(ap.appeal_of, ap.verdict);

  return mods.map((m) => {
    const mine = votes.filter((v) => v.moderator_id === m.id);
    const total = mine.length;
    const matched = mine.filter((v) => v.vote_verdict === v.outcome).length;
    const handled = new Set(mine.map((v) => v.dispute_id)).size;

    // Overturned: voted with the original outcome on a case whose
    // appeal later flipped it. (Votes on appeal rounds themselves are
    // judged against the appeal's own verdict in `matched`.)
    const onOriginals = mine.filter((v) => !v.appeal_of);
    const appealedCases = onOriginals.filter((v) => flipped.has(v.dispute_id));
    const overturned = appealedCases.filter((v) =>
      v.vote_verdict === v.outcome && flipped.get(v.dispute_id) !== v.outcome
    ).length;

    return {
      moderator_id: m.id,
      name: m.name,
      disputes_handled: handled,
      votes_cast: total,
      majority_match_rate: total ? Math.round((matched / total) * 100) / 100 : null,
      appealed_cases: appealedCases.length,
      overturned_on_appeal: overturned,
      overturned_rate: appealedCases.length ? Math.round((overturned / appealedCases.length) * 100) / 100 : null,
    };
  });
}

/** Staff shortcut: resolve immediately without waiting for votes. */
export async function staffResolve(disputeId, verdict) {
  const d = await getDispute(disputeId);
  if (!d) throw notFound('Dispute not found');
  if (d.status === 'resolved') throw conflict('Dispute already resolved');
  if (!['party_a', 'party_b'].includes(verdict)) throw badRequest('Verdict must be party_a or party_b');
  await applyResolution(disputeId, verdict, 'staff');
  return getDisputeDetail(disputeId);
}

// ── resolution ──────────────────────────────────────────────────────
async function applyResolution(disputeId, verdict, by) {
  const d = await getDispute(disputeId);
  if (!d) return null;
  if (d.status === 'resolved') return null;
  const deal = await getDeal(d.transaction_id);

  // Deliverer wins → deal confirmed, escrow released to them.
  // Otherwise → deal failed, escrow refunded to the payer.
  const winnerId = verdict === 'party_a' ? deal.party_a_id : deal.party_b_id;
  const delivererWon = winnerId === deal.delivered_by;
  const resolution = delivererWon ? 'confirmed' : 'failed';
  const now = nowIso();

  await db.tx(async () => {
    // Guarded: only an open dispute may be resolved (prevents double resolution).
    const { rowCount } = await db.run(
      `UPDATE disputes SET status = 'resolved', resolution = ?, verdict = ?, resolved_at = ? WHERE id = ? AND status = 'open'`,
      [resolution, verdict, now, disputeId]
    );
    if (!rowCount) throw conflict('Dispute is already resolved');

    if (resolution === 'confirmed') {
      await db.run(`UPDATE transactions SET status = 'confirmed', confirmed_at = ?, disputed_at = COALESCE(disputed_at, ?) WHERE id = ?`,
        [now, now, deal.id]);
    } else {
      await db.run(`UPDATE transactions SET status = 'failed', failed_at = ?, disputed_at = COALESCE(disputed_at, ?) WHERE id = ?`,
        [now, now, deal.id]);
    }

    if (deal.escrow_enabled && deal.escrow_state === 'funded') {
      const call = resolution === 'confirmed'
        ? () => paymentsProvider.release({ amount: deal.amount, currency: deal.currency, ref: deal.ref })
        : () => paymentsProvider.refund({ amount: deal.amount, currency: deal.currency, ref: deal.ref });
      const result = await call();
      await db.run(`UPDATE transactions SET escrow_state = ?, escrow_ref = ? WHERE id = ?`,
        [result.status, result.reference, deal.id]);
    }

    await appendLedger('dispute_resolved', {
      txId: deal.id,
      userId: null,
      payload: {
        dispute: disputeId,
        verdict,
        resolution,
        by,
        // Both the original decision and the appeal outcome land on the
        // permanent ledger, linked so the reversal is auditable.
        appealOf: d.appeal_of || null,
        round: d.appeal_of ? 'appeal' : 'original',
      },
    });
  });

  await Promise.all([computeReputation(deal.party_a_id), computeReputation(deal.party_b_id)]);
  await runFraudChecks().catch(() => {});

  // Notify both parties of the outcome (stub SMS in dev).
  const outcomeLine = resolution === 'confirmed'
    ? 'Dispute resolved in the deliverer\'s favour — deal confirmed.'
    : 'Dispute resolved in the payer\'s favour — deal marked failed and escrow refunded.';
  await Promise.all([
    smsProvider.sendMessage(deal.party_a_id, `Zemen: ${outcomeLine}`),
    smsProvider.sendMessage(deal.party_b_id, `Zemen: ${outcomeLine}`),
  ]);
}
