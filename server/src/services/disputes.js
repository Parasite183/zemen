// Structured dispute resolution:
//   raise → both parties submit statements + evidence → vetted moderators
//   vote → outcome applied (deal confirmed or failed, escrow released or
//   refunded) and permanently logged against both users' records.
import { db } from '../db.js';
import { appendLedger } from '../ledger.js';
import { nowIso } from '../crypto.js';
import { getDeal } from './deals.js';
import { markDisputed } from './deals.js';
import paymentsProvider from '../providers/payments.js';
import smsProvider from '../providers/sms.js';
import { computeReputation } from './reputation.js';
import { runFraudChecks } from './anti-fraud.js';
import { badRequest, notFound, forbidden, conflict } from '../http.js';

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
  const moderators = await db.all("SELECT id, name FROM users WHERE is_moderator = 1");
  return { ...d, transaction: tx, statements, evidence, votes, moderators };
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

/**
 * A moderator votes for party_a or party_b.
 * The dispute resolves automatically once a strict majority forms
 * (≥2 same verdicts, or all moderators have voted with a leader).
 */
export async function castVote(disputeId, moderator, verdict, note = '') {
  const d = await getDispute(disputeId);
  if (!d) throw notFound('Dispute not found');
  if (d.status === 'resolved') throw conflict('Dispute already resolved');
  if (!['party_a', 'party_b'].includes(verdict)) throw badRequest('Verdict must be party_a or party_b');

  await db.run(
    `INSERT INTO dispute_votes (dispute_id, moderator_id, verdict, note, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(dispute_id, moderator_id) DO UPDATE SET verdict = excluded.verdict, note = excluded.note`,
    [disputeId, moderator.id, verdict, note || '', nowIso()]
  );

  const votes = await db.all('SELECT verdict FROM dispute_votes WHERE dispute_id = ?', [disputeId]);
  const modCount = (await db.get('SELECT COUNT(*) AS n FROM users WHERE is_moderator = 1')).n;
  const a = votes.filter((v) => v.verdict === 'party_a').length;
  const b = votes.filter((v) => v.verdict === 'party_b').length;

  const resolved = (a >= 2 && a > b) || (b >= 2 && b > a) || (votes.length === modCount && a !== b);
  if (resolved) await applyResolution(disputeId, a > b ? 'party_a' : 'party_b', 'moderator_vote');
  return getDisputeDetail(disputeId);
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
      payload: { dispute: disputeId, verdict, resolution, by },
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
