// ─────────────────────────────────────────────────────────────────────
// Payment provider webhooks (Chapa).
//
// The webhook is the non-custodial confirmation path: when the payer
// completes the hosted checkout, the provider POSTs here with the
// payment outcome. We NEVER trust the webhook body alone —
//  1. verify the HMAC-SHA256 signature (chapa-signature /
//     x-chapa-signature) against the raw body
//  2. re-query the provider's verify endpoint server-side
//  3. only then flip escrow_state 'pending' → 'funded' (guarded +
//     idempotent, so replays change nothing)
//
// Mounted with express.raw in app.js so the signature is computed over
// the exact bytes the provider sent.
// ─────────────────────────────────────────────────────────────────────
import { Router } from 'express';
import { db } from '../db.js';
import { appendLedger } from '../ledger.js';
import { wrap, ok } from '../http.js';
import paymentsProvider from '../providers/payments.js';
import { getDealByRef } from '../services/deals.js';
import { logger } from '../logger.js';

const router = Router();

router.post('/webhook', wrap(async (req, res) => {
  const raw = req.body; // Buffer (express.raw)
  const bodyStr = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');

  let verified = false;
  try {
    verified = paymentsProvider.verifyWebhook(raw, req.headers);
  } catch (err) {
    // Misconfigured webhook secret — loud, visible failure.
    logger.error('payment_webhook_rejected', { reason: 'config', error: err.message });
    return ok(res, { accepted: false, error: 'webhook not configured' }, 500);
  }
  if (!verified) {
    logger.warn('payment_webhook_rejected', { reason: 'bad_signature', ip: req.ip });
    return ok(res, { accepted: false }, 401);
  }

  let event;
  try {
    event = JSON.parse(bodyStr);
  } catch {
    return ok(res, { accepted: false }, 400);
  }

  // tx_ref (v1 payloads) / merchant_reference (v2) — our deal ref.
  const ref = event.tx_ref || event.merchant_reference || null;
  if (!ref) {
    logger.warn('payment_webhook_rejected', { reason: 'no_reference' });
    return ok(res, { accepted: true }); // nothing addressable — ack
  }

  const deal = await getDealByRef(ref);
  if (!deal) {
    // Unknown to us (e.g. a payment for a deal we don't track) — ack so
    // the provider stops retrying, and log for reconciliation.
    logger.warn('payment_webhook_rejected', { reason: 'unknown_ref', ref });
    return ok(res, { accepted: true });
  }

  // Idempotent + guarded: only a 'pending' escrow can be flipped; a
  // replayed success event for an already-funded deal changes nothing.
  if (event.event === 'charge.success' && deal.escrow_state === 'pending') {
    const providerRef = event.reference || deal.escrow_ref || ref;
    const confirmed = await paymentsProvider.confirmPayment(providerRef);
    if (confirmed.confirmed) {
      const { rowCount } = await db.run(
        `UPDATE transactions SET escrow_state = 'funded' WHERE id = ? AND escrow_state = 'pending'`,
        [deal.id]
      );
      if (rowCount) {
        await appendLedger('escrow_funded', {
          txId: deal.id,
          userId: null,
          payload: { amount: deal.amount, currency: deal.currency, provider: confirmed.txRef || providerRef, providerName: paymentsProvider.name },
        });
        logger.info('payment_confirmed', { dealId: deal.id, ref, providerRef });
      }
    }
  }

  ok(res, { accepted: true });
}));

export default router;
