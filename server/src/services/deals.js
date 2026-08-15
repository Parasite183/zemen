// Deal lifecycle: create → agreed → in_progress → delivered → confirmed
// (or disputed → resolved). Every transition writes a tamper-evident
// ledger entry; escrow goes through the swappable payments provider.
import { db } from '../db.js';
import { appendLedger } from '../ledger.js';
import { canonicalize, sha256, genRef, nowIso } from '../crypto.js';
import paymentsProvider from '../providers/payments.js';
import { badRequest, notFound, forbidden, conflict } from '../http.js';
import { config } from '../config.js';
import { verifyActionOtp } from '../auth.js';
import { assertDealEligibility } from './identity.js';
import { computeReputation } from './reputation.js';
import { runFraudChecks } from './anti-fraud.js';

export const DEAL_STATUSES = ['pending', 'agreed', 'in_progress', 'delivered', 'confirmed', 'disputed', 'failed', 'declined', 'cancelled'];

// ── read helpers ────────────────────────────────────────────────────
export async function getDeal(id) {
  return db.get('SELECT * FROM transactions WHERE id = ?', [id]);
}

export async function getDealByRef(ref) {
  return db.get('SELECT * FROM transactions WHERE ref = ?', [ref]);
}

/** Deal joined with party display info and parsed terms. */
export async function dealDetail(id) {
  const d = await getDeal(id);
  if (!d) return null;
  const [a, b, rep, openDispute] = await Promise.all([
    db.get('SELECT id, name, phone, category, id_verification_status FROM users WHERE id = ?', [d.party_a_id]),
    db.get('SELECT id, name, phone, category, id_verification_status FROM users WHERE id = ?', [d.party_b_id]),
    db.get('SELECT * FROM reputation_scores WHERE user_id = ?', [d.party_b_id]),
    db.get("SELECT id FROM disputes WHERE transaction_id = ? AND status = 'open' LIMIT 1", [d.id]),
  ]);
  return {
    ...d,
    terms: d.terms_json ? JSON.parse(d.terms_json) : null,
    party_a: a,
    party_b: b,
    party_b_rep: rep,
    dispute_id: openDispute ? openDispute.id : null,
  };
}

async function loadDealForUser(id, user) {
  const d = await getDeal(id);
  if (!d) throw notFound('Deal not found');
  const isParty = d.party_a_id === user.id || d.party_b_id === user.id;
  if (!isParty && !user.is_moderator) throw forbidden('Not a party to this deal');
  return d;
}

// ── creation ────────────────────────────────────────────────────────
export async function createDeal(creator, input) {
  const otherPhone = (input.phone || '').trim();
  const otherId = Number(input.userId || 0);
  const description = (input.description || '').trim();
  const deliverable = (input.deliverable || '').trim();
  const amount = Number(input.amount);
  const currency = input.currency || 'ETB';

  if (!description) throw badRequest('Describe the deal', 'description_required');
  if (!Number.isFinite(amount) || amount <= 0) throw badRequest('Enter a valid amount', 'amount_invalid');
  if (!otherPhone && !otherId) throw badRequest('Enter the other party phone number', 'phone_required');

  // Identity gate: large deals require a verified account on the creating
  // side; the accepting side is checked in respondToDeal. Unverified
  // accounts are also capped on total lifetime volume.
  await assertDealEligibility(creator, amount);

  const other = otherPhone
    ? await db.get('SELECT * FROM users WHERE phone = ?', [otherPhone])
    : await db.get('SELECT * FROM users WHERE id = ?', [otherId]);
  if (!other) throw notFound('No Zemen user found with that phone number');
  if (other.id === creator.id) throw badRequest('You cannot deal with yourself', 'self_deal');

  const now = nowIso();
  const { lastId } = await db.run(
    `INSERT INTO transactions
       (ref, description, deliverable, amount, currency, deadline,
        party_a_id, party_b_id, status, escrow_enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [genRef(), description, deliverable, amount, currency, input.deadline || null,
     creator.id, other.id, input.escrow ? 1 : 0, now]
  );

  await appendLedger('deal_created', {
    txId: lastId, userId: creator.id,
    payload: { ref: lastId, description, deliverable, amount, currency, deadline: input.deadline || null, partyB: other.id, escrow: !!input.escrow },
  });

  return dealDetail(lastId);
}

// ── party B acceptance ──────────────────────────────────────────────
export async function respondToDeal(id, user, accept) {
  const d = await loadDealForUser(id, user);
  if (d.party_b_id !== user.id) throw forbidden('Only the invited party can respond');
  if (d.status !== 'pending') throw conflict('This deal has already been responded to');

  if (!accept) {
    await db.run(`UPDATE transactions SET status = 'declined' WHERE id = ?`, [id]);
    await appendLedger('deal_declined', { txId: id, userId: user.id });
    return dealDetail(id);
  }

  // Identity gate on the accepting side too — an unverified account
  // cannot accept a deal above the free threshold or beyond its cap.
  await assertDealEligibility(user, d.amount);

  const terms = {
    ref: d.ref,
    description: d.description,
    deliverable: d.deliverable,
    amount: d.amount,
    currency: d.currency,
    deadline: d.deadline || null,
    party_a: d.party_a_id,
    party_b: d.party_b_id,
    escrow: !!d.escrow_enabled,
  };
  const termsJson = JSON.stringify(terms);
  const termsHash = sha256(canonicalize(terms));
  const now = nowIso();

  const { rowCount } = await db.run(
    `UPDATE transactions SET status = 'agreed', agreed_at = ?, terms_json = ?, terms_hash = ? WHERE id = ? AND status = 'pending'`,
    [now, termsJson, termsHash, id]
  );
  if (!rowCount) throw conflict('This deal has already been responded to');
  await appendLedger('terms_agreed', {
    txId: id, userId: user.id,
    payload: { termsHash, description: d.description, amount: d.amount, currency: d.currency },
  });
  return dealDetail(id);
}

export async function cancelDeal(id, user) {
  const d = await loadDealForUser(id, user);
  if (d.party_a_id !== user.id) throw forbidden('Only the creator can cancel');
  if (!['pending', 'agreed'].includes(d.status)) throw conflict('This deal can no longer be cancelled');
  const { rowCount } = await db.run(
    `UPDATE transactions SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'agreed')`, [id]
  );
  if (!rowCount) throw conflict('This deal can no longer be cancelled');
  await appendLedger('deal_cancelled', { txId: id, userId: user.id });
  return dealDetail(id);
}

// ── escrow (non-custodial provider) ─────────────────────────────────
// Zemen never holds funds. With a hosted-checkout provider (chapa),
// deposit() returns 'pending' + a checkout_url: the payer completes the
// payment on the provider's page, and the provider's webhook (re-
// verified server-side) flips escrow_state to 'funded'. The stub
// provider returns 'funded' immediately for local dev/tests.
export async function fundEscrow(id, user, otp) {
  const d = await loadDealForUser(id, user);
  if (!d.escrow_enabled) throw badRequest('This deal has no escrow');
  if (d.party_a_id !== user.id) throw forbidden('Only the payer can fund escrow');
  if (d.escrow_state === 'funded') throw conflict('Escrow already funded');
  if (!['agreed', 'in_progress', 'delivered', 'disputed'].includes(d.status)) throw conflict('Deal is not in a fundable state');

  // High-stakes action: money is moving — re-auth with a fresh OTP.
  if (!(await verifyActionOtp(user, otp))) {
    throw badRequest('Enter the one-time code we sent you to fund escrow', 'otp_required');
  }

  // A pending checkout already exists → hand back the same payment page
  // instead of creating a new one.
  if (d.escrow_state === 'pending' && d.escrow_checkout_url) {
    return dealDetail(id);
  }

  const result = await paymentsProvider.deposit({ amount: d.amount, currency: d.currency, ref: d.ref });
  const { rowCount } = await db.run(
    `UPDATE transactions SET escrow_state = ?, escrow_ref = ?, escrow_checkout_url = ? WHERE id = ? AND escrow_state = 'none'`,
    [result.status, result.reference, result.checkoutUrl || '', id]
  );
  if (!rowCount) throw conflict('Escrow already funded');
  // The ledger reflects the real, non-custodial shape: 'pending' is
  // recorded as escrow_initiated; escrow_funded is appended only when
  // the provider CONFIRMS the payment (webhook or escrow/check).
  await appendLedger(result.status === 'pending' ? 'escrow_initiated' : 'escrow_funded', {
    txId: id, userId: user.id,
    payload: { amount: d.amount, currency: d.currency, provider: result.reference, providerName: paymentsProvider.name },
  });
  return dealDetail(id);
}

/**
 * Poll path for hosted-checkout escrow: ask the provider whether the
 * pending payment completed, and record the provider-confirmed state.
 * This is the fallback when a webhook was delayed/lost — webhook and
 * poll are idempotent and both re-verify server-side.
 */
export async function checkEscrowStatus(id, user) {
  const d = await loadDealForUser(id, user);
  if (!d.escrow_enabled) throw badRequest('This deal has no escrow');
  if (d.escrow_state !== 'pending') return dealDetail(id); // nothing to confirm

  const providerRef = d.escrow_ref || d.ref;
  const confirmed = await paymentsProvider.confirmPayment(providerRef);
  if (confirmed.confirmed) {
    const { rowCount } = await db.run(
      `UPDATE transactions SET escrow_state = 'funded' WHERE id = ? AND escrow_state = 'pending'`, [id]
    );
    if (rowCount) {
      await appendLedger('escrow_funded', {
        txId: id, userId: user.id,
        payload: { amount: d.amount, currency: d.currency, provider: confirmed.txRef || providerRef, providerName: paymentsProvider.name },
      });
    }
  }
  return dealDetail(id);
}

// ── progress ────────────────────────────────────────────────────────
export async function startDeal(id, user) {
  const d = await loadDealForUser(id, user);
  if (!['agreed', 'in_progress'].includes(d.status)) throw conflict('Deal cannot be started from its current state');
  if (d.escrow_enabled && d.escrow_state !== 'funded') {
    throw badRequest('Escrow must be funded before work starts', 'escrow_not_funded');
  }
  if (d.status === 'in_progress') return dealDetail(id); // idempotent
  const { rowCount } = await db.run(
    `UPDATE transactions SET status = 'in_progress', started_at = ? WHERE id = ? AND status = 'agreed'`, [nowIso(), id]
  );
  if (!rowCount) throw conflict('Deal cannot be started from its current state');
  await appendLedger('deal_started', { txId: id, userId: user.id });
  return dealDetail(id);
}

export async function deliverDeal(id, user) {
  const d = await loadDealForUser(id, user);
  if (d.status !== 'in_progress') throw conflict('Deal must be in progress to deliver');
  const { rowCount } = await db.run(
    `UPDATE transactions SET status = 'delivered', delivered_at = ?, delivered_by = ? WHERE id = ? AND status = 'in_progress'`,
    [nowIso(), user.id, id]
  );
  if (!rowCount) throw conflict('Deal is no longer in progress');
  await appendLedger('delivered', { txId: id, userId: user.id, payload: { deliveredBy: user.id } });
  return dealDetail(id);
}

export async function confirmDeal(id, user, otp) {
  const d = await loadDealForUser(id, user);
  if (d.status !== 'delivered') throw conflict('Deal must be delivered before confirming');
  if (d.delivered_by === user.id) throw forbidden('You cannot confirm your own delivery');

  // High-stakes action for large deals: re-auth before releasing escrow
  // or marking the deal complete.
  if (d.amount > config.freeDealThresholdEtb && !(await verifyActionOtp(user, otp))) {
    throw badRequest('Enter the one-time code we sent you to confirm this deal', 'otp_required');
  }

  await db.tx(async () => {
    // Guarded transition: only a delivered deal can be confirmed once.
    const { rowCount } = await db.run(
      `UPDATE transactions SET status = 'confirmed', confirmed_at = ? WHERE id = ? AND status = 'delivered'`, [nowIso(), id]
    );
    if (!rowCount) throw conflict('Deal must be delivered before confirming');

    if (d.escrow_enabled && d.escrow_state === 'funded') {
      // Non-custodial release: payout the escrowed funds to the
      // deliverer's mobile-money wallet (provider confirms the state).
      const deliverer = await db.get('SELECT phone, name FROM users WHERE id = ?', [d.delivered_by]);
      const result = await paymentsProvider.release({
        amount: d.amount, currency: d.currency, ref: d.ref, toPhone: deliverer?.phone, toName: deliverer?.name,
      });
      const { rowCount: released } = await db.run(
        `UPDATE transactions SET escrow_state = ?, escrow_ref = ? WHERE id = ? AND escrow_state = 'funded'`,
        [result.status, result.reference, id]
      );
      if (released) {
        await appendLedger('escrow_released', {
          txId: id, userId: user.id,
          payload: { to: d.delivered_by, amount: d.amount, currency: d.currency, provider: result.reference },
        });
      }
    }
    await appendLedger('deal_confirmed', { txId: id, userId: user.id });
  });

  await Promise.all([computeReputation(d.party_a_id), computeReputation(d.party_b_id)]);
  // Refresh graph-level fraud signals (clique / velocity / clusters).
  await runFraudChecks().catch(() => {});
  return dealDetail(id);
}

/** Flip a deal into the disputed state (dispute record is created elsewhere). */
export async function markDisputed(id) {
  await db.run(`UPDATE transactions SET status = 'disputed', disputed_at = ? WHERE id = ?`, [nowIso(), id]);
}

export async function listDealsForUser(user, filter = '') {
  const rows = await db.all(
    `SELECT t.*, a.name AS party_a_name, b.name AS party_b_name
     FROM transactions t
     JOIN users a ON a.id = t.party_a_id
     JOIN users b ON b.id = t.party_b_id
     WHERE t.party_a_id = ? OR t.party_b_id = ?
     ORDER BY t.id DESC
     LIMIT 100`,
    [user.id, user.id]
  );
  const filtered = filter ? rows.filter((r) => r.status === filter) : rows;
  return filtered.map((r) => ({ ...r, role: r.party_a_id === user.id ? 'party_a' : 'party_b' }));
}
