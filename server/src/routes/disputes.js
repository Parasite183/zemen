import { Router } from 'express';
import { db } from '../db.js';
import { wrap, ok, notFound, forbidden } from '../http.js';
import { authMiddleware, requireModerator, requireStaff } from '../auth.js';
import { uploadEvidence } from '../uploads.js';
import {
  createDispute, getDisputeDetail, addStatement, addEvidence,
  moderatorQueue, castVote, staffPropose, staffConfirm, requestAppeal,
  moderatorStats, staffStats,
} from '../services/disputes.js';

const router = Router();
router.use(authMiddleware);

router.post('/', wrap(async (req, res) => {
  const { transaction_id: txId, reason } = req.body;
  if (!txId) return ok(res, { error: 'transaction_id required' }, 400);
  const dispute = await createDispute({ transactionId: Number(txId), raisedBy: req.user.id, reason });
  ok(res, { dispute }, 201);
}));

router.get('/', wrap(async (req, res) => {
  const rows = await db.all(
    `SELECT d.*, t.ref AS deal_ref, t.description AS deal_description
     FROM disputes d JOIN transactions t ON t.id = d.transaction_id
     WHERE t.party_a_id = ? OR t.party_b_id = ?
     ORDER BY d.id DESC`, [req.user.id, req.user.id]);
  ok(res, { disputes: rows });
}));

router.get('/modqueue', requireModerator, wrap(async (req, res) => {
  ok(res, { disputes: await moderatorQueue() });
}));

// Internal moderator track record (staff-only review surface).
router.get('/moderators/stats', requireStaff, wrap(async (req, res) => {
  ok(res, { moderators: await moderatorStats() });
}));

// Internal staff-override track record — overrides are as visible and
// accountable as moderator votes.
router.get('/staff/stats', requireStaff, wrap(async (req, res) => {
  ok(res, { staff: await staffStats() });
}));

router.get('/:id', wrap(async (req, res) => {
  const d = await getDisputeDetail(Number(req.params.id));
  if (!d) throw notFound('Dispute not found');
  const deal = d.transaction;
  const allowed = req.user.is_moderator || (deal && (deal.party_a_id === req.user.id || deal.party_b_id === req.user.id));
  if (!allowed) throw forbidden('Not allowed to view this dispute');
  ok(res, { dispute: d });
}));

router.post('/:id/statements', wrap(async (req, res) => {
  ok(res, { dispute: await addStatement(Number(req.params.id), req.user, req.body?.body) });
}));

router.post('/:id/evidence', uploadEvidence, wrap(async (req, res) => {
  if (!req.file) return ok(res, { error: 'file required' }, 400);
  ok(res, { dispute: await addEvidence(Number(req.params.id), req.user, req.file) });
}));

router.post('/:id/vote', requireModerator, wrap(async (req, res) => {
  ok(res, { dispute: await castVote(Number(req.params.id), req.user, req.body?.verdict, req.body?.note) });
}));

// The losing party files exactly one appeal per dispute; it is judged
// by a fresh panel excluding the original voters.
router.post('/:id/appeal', wrap(async (req, res) => {
  ok(res, { dispute: await requestAppeal(Number(req.params.id), req.user) });
}));

// Staff override is a two-person flow: `propose` stores a verdict +
// required reason without resolving; `confirm` by a different staff
// account applies it (a third sign-off is needed for heavy users). A
// confirm with a different verdict closes the override and sends the
// dispute back to the normal moderator panel.
router.post('/:id/resolve', requireStaff, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const action = req.body?.action;
  const verdict = req.body?.verdict;
  const reason = req.body?.reason;
  if (action === 'propose') return ok(res, { dispute: await staffPropose(id, req.user, verdict, reason) });
  if (action === 'confirm') return ok(res, { dispute: await staffConfirm(id, req.user, verdict, reason) });
  return ok(res, { error: 'action must be "propose" or "confirm"' }, 400);
}));

export default router;
