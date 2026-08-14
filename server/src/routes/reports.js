import { Router } from 'express';
import { db } from '../db.js';
import { wrap, ok, notFound } from '../http.js';
import { authMiddleware } from '../auth.js';
import { verifyChain } from '../ledger.js';
import { nowIso } from '../crypto.js';
import { buildReport } from '../services/reports.js';

const router = Router();

/**
 * Public trust report — accessible by unguessable token, so a user can
 * hand it to a bank, client or lender without an account. Assembly lives
 * in services/reports.js (unit-tested to always return complete fields).
 */
router.get('/public/report/:token', wrap(async (req, res) => {
  const user = await db.get('SELECT * FROM users WHERE report_token = ?', [req.params.token]);
  if (!user) throw notFound('Report not found');
  ok(res, await buildReport(user));
}));

// Ledger integrity check — proves the whole transaction history is
// unaltered. Also reachable from the UI (deal detail → verification).
router.get('/ledger/verify', authMiddleware, wrap(async (req, res) => {
  const chain = await verifyChain();
  ok(res, { ...chain, verifiedAt: nowIso() });
}));

export default router;
