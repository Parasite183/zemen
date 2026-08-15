import { Router } from 'express';
import { wrap, ok, badRequest } from '../http.js';
import { authMiddleware } from '../auth.js';
import { entriesForTx, verifyChain } from '../ledger.js';
import { CREATE_LIMITS } from '../rate-limit.js';
import {
  createDeal, dealDetail, respondToDeal, cancelDeal, fundEscrow,
  startDeal, deliverDeal, confirmDeal, checkEscrowStatus, listDealsForUser,
} from '../services/deals.js';

const router = Router();
router.use(authMiddleware);

// Spam protection: deal creation is rate-limited per account and per IP.
router.post('/', ...CREATE_LIMITS.deals, wrap(async (req, res) => {
  const deal = await createDeal(req.user, req.body);
  ok(res, { deal }, 201);
}));

router.get('/', wrap(async (req, res) => {
  ok(res, { deals: await listDealsForUser(req.user, req.query.filter) });
}));

router.get('/:id', wrap(async (req, res) => {
  const deal = await dealDetail(Number(req.params.id));
  if (!deal) return ok(res, { deal: null });
  const isParty = deal.party_a_id === req.user.id || deal.party_b_id === req.user.id;
  if (!isParty && !req.user.is_moderator) return ok(res, { deal: null });
  ok(res, { deal });
}));

router.post('/:id/respond', wrap(async (req, res) => {
  ok(res, { deal: await respondToDeal(Number(req.params.id), req.user, !!req.body.accept) });
}));

router.post('/:id/cancel', wrap(async (req, res) => {
  ok(res, { deal: await cancelDeal(Number(req.params.id), req.user) });
}));

router.post('/:id/escrow/deposit', wrap(async (req, res) => {
  ok(res, { deal: await fundEscrow(Number(req.params.id), req.user, req.body?.otp) });
}));

// Poll the provider for a pending hosted-checkout payment (webhook
// fallback). Idempotent; flips escrow_state to 'funded' on confirmation.
router.post('/:id/escrow/check', wrap(async (req, res) => {
  ok(res, { deal: await checkEscrowStatus(Number(req.params.id), req.user) });
}));

router.post('/:id/start', wrap(async (req, res) => {
  ok(res, { deal: await startDeal(Number(req.params.id), req.user) });
}));

router.post('/:id/deliver', wrap(async (req, res) => {
  ok(res, { deal: await deliverDeal(Number(req.params.id), req.user) });
}));

router.post('/:id/confirm', wrap(async (req, res) => {
  ok(res, { deal: await confirmDeal(Number(req.params.id), req.user, req.body?.otp) });
}));

// Tamper-evidence view for a single deal: its chained ledger entries.
router.get('/:id/ledger', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const chain = await verifyChain();
  ok(res, { entries: await entriesForTx(id), chain });
}));

export default router;
