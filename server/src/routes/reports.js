import { Router } from 'express';
import { db } from '../db.js';
import { wrap, ok, notFound } from '../http.js';
import { authMiddleware } from '../auth.js';
import { verifyChain } from '../ledger.js';
import { canonicalize, sha256, nowIso } from '../crypto.js';
import { getReputation } from '../services/reputation.js';

const router = Router();

/**
 * Public trust report — the shareable artifact that substitutes for a
 * credit-bureau report elsewhere. Accessible by unguessable token, so a
 * user can hand it to a bank, client or lender without an account.
 */
router.get('/public/report/:token', wrap(async (req, res) => {
  const user = await db.get('SELECT * FROM users WHERE report_token = ?', [req.params.token]);
  if (!user) throw notFound('Report not found');

  const reputation = await getReputation(user.id) || {};
  const deals = await db.all(
    `SELECT t.ref, t.description, t.amount, t.currency, t.status, t.deadline,
            t.delivered_at, t.created_at, t.confirmed_at,
            ua.name AS party_a_name, ub.name AS party_b_name
     FROM transactions t
     JOIN users ua ON ua.id = t.party_a_id
     JOIN users ub ON ub.id = t.party_b_id
     WHERE (t.party_a_id = ? OR t.party_b_id = ?)
       AND t.status IN ('confirmed', 'failed')
     ORDER BY t.id DESC
     LIMIT 100`,
    [user.id, user.id]
  );
  const disputes = await db.all(
    `SELECT d.id, d.resolution, d.created_at, d.resolved_at
     FROM disputes d JOIN transactions t ON t.id = d.transaction_id
     WHERE (t.party_a_id = ? OR t.party_b_id = ?) AND d.status = 'resolved'`,
    [user.id, user.id]
  );

  const head = (await verifyChain()).head;
  const report = {
    generatedAt: nowIso(),
    subject: {
      name: user.name || 'Unnamed user',
      category: user.category,
      verification: user.id_verification_status,
      joined: user.created_at.slice(0, 10),
    },
    reputation: {
      completionRate: reputation.completion_rate ?? 0,
      onTimeRate: reputation.on_time_rate ?? 0,
      disputeRate: reputation.dispute_rate ?? 0,
      totalVolume: reputation.total_volume ?? 0,
      completed: reputation.total_completed ?? 0,
      failed: reputation.total_failed ?? 0,
      disputed: reputation.total_disputed ?? 0,
    },
    history: deals,
    disputes,
    ledgerHead: head,
  };
  const seal = sha256(canonicalize(report));

  ok(res, { report, seal });
}));

// Ledger integrity check — proves the whole transaction history is
// unaltered. Also reachable from the UI (deal detail → verification).
router.get('/ledger/verify', authMiddleware, wrap(async (req, res) => {
  const chain = await verifyChain();
  ok(res, { ...chain, verifiedAt: nowIso() });
}));

export default router;
