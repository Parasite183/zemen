// ─────────────────────────────────────────────────────────────────────
// Mobile-money escrow provider — STUB.
//
// This is the integration point for a real mobile-money API
// (Telebirr / M-Pesa / Chapa style flows):
//   1. deposit()   → initiate a payment request to the payer's wallet
//   2. release()   → push the held funds to the payee's wallet
//   3. refund()    → return funds to the payer's wallet
//
// The real implementation would call the operator's REST API, store the
// provider's transaction id, and (for long-pending payments) poll or
// receive webhooks. The rest of Zemen only depends on this interface.
// ─────────────────────────────────────────────────────────────────────

function randRef() {
  return `TBR-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 900 + 100)}`;
}

function log(kind, ref, amount, currency) {
  console.log(`\n  [PAY-STUB] ${kind} ${amount} ${currency} — provider ref ${ref}\n`);
}

const paymentsProvider = {
  name: 'stub-mobile-money',

  /**
   * Request `amount` from the payer's wallet and hold it in escrow.
   * @param {{ amount: number, currency: string, ref: string }} deal
   */
  async deposit({ amount, currency, ref }) {
    log('ESCROW DEPOSIT (held)', ref, amount, currency);
    return { status: 'funded', reference: randRef(), held: amount, currency };
  },

  /** Release held funds to the payee's wallet. */
  async release({ amount, currency, ref }) {
    log('ESCROW RELEASE', ref, amount, currency);
    return { status: 'released', reference: randRef() };
  },

  /** Refund held funds back to the payer's wallet. */
  async refund({ amount, currency, ref }) {
    log('ESCROW REFUND', ref, amount, currency);
    return { status: 'refunded', reference: randRef() };
  },
};

export default paymentsProvider;
