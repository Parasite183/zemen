// ─────────────────────────────────────────────────────────────────────
// Mobile-money escrow provider.
//
// NON-CUSTODIAL BY DESIGN: Zemen never holds funds. The provider is a
// hosted-checkout / webhook-confirmation integration — Zemen records
// provider-confirmed state, it does not custody money itself.
//
// Two providers, selected by PAYMENT_PROVIDER env:
//   'stub'  (dev default) — logs to console, returns immediately. Used
//            by the local demo and the test suite. REJECTED in
//            production by config.js validateConfig().
//   'chapa' (production)  — Chapa hosted checkout (Ethiopia; the hosted
//            payment page lets payers use Telebirr, CBE Birr, etc.).
//            deposit() creates a checkout and returns 'pending' with a
//            checkout_url; the payer completes payment on Chapa's page;
//            Chapa POSTs a webhook which we verify (HMAC-SHA256, see
//            verifyWebhook) and then RE-VERIFY server-side (never trust
//            the webhook alone — see confirmPayment) before recording
//            escrow_state = 'funded'. release()/refund() initiate a
//            Chapa payout to the recipient's mobile-money account.
//
// Every failure is loud: provider errors throw with the provider's
// message, are logged as payment_provider_error, and surface as a
// visible API error. There is no silent fallback to a stub.
// ─────────────────────────────────────────────────────────────────────
import crypto from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';

const randRef = (p) => `${p}-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 900 + 100)}`;

function log(kind, ref, amount, currency) {
  console.log(`\n  [PAY-STUB] ${kind} ${amount} ${currency} — provider ref ${ref}\n`);
}

// ── stub (local dev / tests) ─────────────────────────────────────────
const stubProvider = {
  name: 'stub-mobile-money',
  isStub: true,

  async deposit({ amount, currency, ref }) {
    log('ESCROW DEPOSIT (held)', ref, amount, currency);
    return { status: 'funded', reference: randRef('TBR'), held: amount, currency };
  },

  async release({ amount, currency, ref }) {
    log('ESCROW RELEASE', ref, amount, currency);
    return { status: 'released', reference: randRef('TBR') };
  },

  async refund({ amount, currency, ref }) {
    log('ESCROW REFUND', ref, amount, currency);
    return { status: 'refunded', reference: randRef('TBR') };
  },

  // No webhooks in stub mode.
  verifyWebhook() {
    return false;
  },

  async confirmPayment() {
    return { confirmed: true, status: 'success' };
  },
};

// ── chapa (production, hosted checkout + HMAC webhooks) ──────────────
// Two platforms, one provider. Chapa v1 (api.chapa.co, CHASECK_... keys)
// and v2 (api.chapa.global, CHAPA_... keys) have different key formats
// and endpoint shapes — the version must match the account that issued
// the secret key or Chapa answers 401 "Invalid API key or User does not
// exist". config.chapa.version selects the right API surface.
function chapaSecret() {
  if (!config.chapa.secretKey) {
    throw new Error('CHAPA_SECRET_KEY is not configured — refusing to call Chapa');
  }
  return config.chapa.secretKey;
}

/** v1 test keys carry _TEST_ and Chapa only simulates transfers on them. */
function chapaIsTestMode() {
  return /_TEST_/.test(config.chapa.secretKey);
}

// The v1 transfers API pays into an account by bank_code (mobile money
// providers like Telebirr are in the bank list as is_mobilemoney). The
// id is account/plan specific — resolve it once from /v1/banks instead
// of hardcoding.
let v1BankIdPromise = null;
async function v1BankId(slug) {
  if (!v1BankIdPromise) {
    v1BankIdPromise = chapaFetch('/v1/banks').then((json) => {
      const list = json?.data || [];
      const bank = list.find((b) => String(b.slug).toLowerCase() === slug.toLowerCase());
      if (!bank?.id) throw new Error(`Chapa v1 has no payout bank "${slug}" — check CHAPA_PAYOUT_BANK_SLUG`);
      return bank.id;
    });
  }
  return v1BankIdPromise;
}

async function chapaFetch(path, { method = 'GET', body } = {}) {
  const url = `${config.chapa.apiUrl}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${chapaSecret()}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    logger.error('payment_provider_error', { provider: 'chapa', path, phase: 'network', error: err.message });
    throw new Error(`Chapa network error on ${path}: ${err.message}`);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) {
    logger.error('payment_provider_error', {
      provider: 'chapa', path, status: res.status,
      body: text.slice(0, 500), phase: 'api',
    });
    throw new Error(`Chapa ${path} failed (${res.status}): ${String(json?.message || json?.status || text).slice(0, 300)}`);
  }
  return json;
}

/** Constant-time hex comparison (length-guarded). */
function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a).toLowerCase(), 'utf8');
  const bb = Buffer.from(String(b).toLowerCase(), 'utf8');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

const chapaProvider = {
  name: 'chapa',
  isStub: false,

  /**
   * Create a hosted checkout. Zemen holds nothing — the payer completes
   * payment on Chapa's page and Chapa confirms it to us by webhook.
   * Returns { status: 'pending', reference, checkoutUrl } — the deal's
   * escrow_state moves to 'pending' until the webhook (re-verified
   * server-side) flips it to 'funded'. v1 verifies by tx_ref (our ref), so
   * reference is always our deal ref.
   */
  async deposit({ amount, currency, ref }) {
    const v1 = config.chapa.version === 'v1';
    const json = await chapaFetch(v1 ? '/v1/transaction/initialize' : '/v2/payments/hosted', {
      method: 'POST',
      body: v1
        ? { amount, currency, tx_ref: ref } // v1 echoes tx_ref back in webhooks
        : { amount, currency, merchant_reference: ref, meta: { deal_ref: ref } },
    });
    const checkoutUrl = json?.data?.checkout_url;
    if (!checkoutUrl) {
      logger.error('payment_provider_error', { provider: 'chapa', path: v1 ? '/v1/transaction/initialize' : '/v2/payments/hosted', phase: 'response' });
      throw new Error('Chapa hosted checkout returned no checkout_url — payment page unavailable');
    }
    // v1 has no separate payment reference — the tx_ref IS our deal ref,
    // and that is exactly what v1's verify endpoint expects.
    const reference = v1 ? ref : (json?.data?.reference || json?.data?.merchant_reference || ref);
    logger.info('payment_checkout_created', { provider: 'chapa', version: config.chapa.version, reference, checkoutUrl });
    return { status: 'pending', reference, checkoutUrl, providerName: 'chapa' };
  },

  /**
   * Verify a webhook's authenticity. Chapa signs with HMAC-SHA256 over
   * the event payload using the webhook secret, sent in either
   * `x-chapa-signature` or `chapa-signature` (one valid header is
   * sufficient). We check against both the raw body and the canonical
   * JSON.stringify(parsed) form, because Chapa's own docs show the
   * latter while best practice is the former — either signature format
   * must validate before the payload is trusted.
   */
  verifyWebhook(rawBody, headers = {}) {
    const secret = config.chapa.webhookSecret;
    if (!secret) {
      logger.error('payment_webhook_rejected', { reason: 'missing webhook secret' });
      throw new Error('CHAPA_WEBHOOK_SECRET is not configured — cannot verify webhooks');
    }
    const candidates = [headers['x-chapa-signature'], headers['chapa-signature']].filter(Boolean);
    if (!candidates.length) return false;
    const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
    const forms = [bodyStr];
    try { forms.push(JSON.stringify(JSON.parse(bodyStr))); } catch { /* not JSON — skip */ }
    for (const form of forms) {
      const expected = crypto.createHmac('sha256', secret).update(form).digest('hex');
      if (candidates.some((c) => safeEqualHex(c, expected))) return true;
    }
    return false;
  },

  /**
   * Server-side re-verification of a payment — ALWAYS called after a
   * webhook before recording escrow as funded (never trust the webhook
   * body alone). v2: GET /v2/payments/{reference}/verify. v1: GET
   * /v1/transaction/verify/{tx_ref} — where the reference is OUR deal
   * ref, not a Chapa-internal id.
   */
  async confirmPayment(reference) {
    const v1 = config.chapa.version === 'v1';
    const json = await chapaFetch(
      v1 ? `/v1/transaction/verify/${encodeURIComponent(reference)}` : `/v2/payments/${encodeURIComponent(reference)}/verify`
    );
    const data = json?.data || json;
    const confirmed = data?.status === 'success';
    if (!confirmed) {
      logger.warn('payment_not_confirmed', { provider: 'chapa', version: config.chapa.version, reference, status: data?.status });
    }
    return {
      confirmed,
      status: data?.status,
      amount: data?.amount,
      currency: data?.currency,
      txRef: data?.tx_ref || data?.merchant_reference || null,
    };
  },

  /**
   * Initiate a payout of the escrowed funds. Non-custodial: the money
   * already sits in the merchant's Chapa account, so "release"/"refund"
   * is a Chapa payout to the recipient's mobile-money wallet.
   *
   * NOTE: the exact payout recipient schema depends on the operator's
   * Chapa plan — see LAUNCH_CHECKLIST.md §Payments. Failures throw
   * loudly rather than pretending the money moved.
   */
  async _payout({ amount, currency, ref, toPhone, toName, kind }) {
    if (!toPhone) {
      throw new Error(`Chapa ${kind} requires the recipient phone number — refusing to move money without a destination`);
    }
    const v1 = config.chapa.version === 'v1';
    let json;
    if (v1) {
      // v1 transfers pay into an account by bank_code; mobile money
      // providers (Telebirr etc.) are listed as banks. Test-mode keys
      // simulate the outcome via `status` — live keys must omit it.
      const bankCode = await v1BankId(config.chapa.payoutBankSlug || 'telebirr');
      json = await chapaFetch('/v1/transfers', {
        method: 'POST',
        body: {
          amount,
          currency,
          reference: `${kind === 'refund' ? 'RFND' : 'RLSE'}-${ref}`,
          account_name: toName || 'Zemen payout',
          account_number: String(toPhone).replace(/^\+/, ''),
          bank_code: bankCode,
          ...(chapaIsTestMode() ? { status: 'success' } : {}),
        },
      });
    } else {
      json = await chapaFetch('/v2/payouts/transfers', {
        method: 'POST',
        body: {
          amount,
          currency,
          merchant_reference: `${kind === 'refund' ? 'RFND' : 'RLSE'}-${ref}`,
          recipient: { type: 'mobile_money', account_number: toPhone },
        },
      });
    }
    const reference = json?.data?.reference || json?.data?.merchant_reference || (v1 ? `${kind === 'refund' ? 'RFND' : 'RLSE'}-${ref}` : randRef('CHA'));
    logger.info('payment_payout_initiated', { provider: 'chapa', version: config.chapa.version, kind, reference, to: toPhone });
    return { status: kind === 'refund' ? 'refunded' : 'released', reference };
  },

  async release(args) {
    return this._payout({ ...args, kind: 'release' });
  },

  async refund(args) {
    return this._payout({ ...args, kind: 'refund' });
  },
};

const PROVIDERS = { stub: stubProvider, chapa: chapaProvider };
const paymentsProvider = PROVIDERS[config.paymentProvider];

// Fail loudly on a typo'd provider — never silently swap in a stub.
if (!paymentsProvider) {
  logger.error('config_invalid', { name: 'PAYMENT_PROVIDER', message: `unknown provider "${config.paymentProvider}"` });
  throw new Error(`Unknown PAYMENT_PROVIDER "${config.paymentProvider}" (expected stub or chapa) — refusing to boot.`);
}

export default paymentsProvider;
export { stubProvider, chapaProvider };
