// ─────────────────────────────────────────────────────────────────────
// SMS provider — swappable, selected by SMS_PROVIDER env:
//   'console'        (default)  logs to the server console; no creds.
//                    Dev-only — REJECTED in production by validateConfig().
//   'twilio'         real delivery + number validation via the Lookup
//                    API (line-type intelligence can flag VoIP/virtual
//                    numbers, which we use as an anti-sybil signal)
//   'africastalking' real delivery with strong East-Africa (Ethiopia)
//                    reach; number validation is best-effort only
//
// Every provider implements the same interface:
//   sendOtp(phone, code), sendMessage(phone, text),
//   validateNumber(phone) -> { valid, isVoip, carrier }
//
// Hardening (launch checklist §SMS):
//   • delivery failures are detected and surfaced — africastalking's
//     send response is parsed per-recipient and a non-101 statusCode
//     throws a visible sms_delivery_failed error
//   • transient failures retry with exponential backoff
//   • missing credentials fail loudly at send time (and at boot in
//     production via config.js) — never a silent stub fallback
//
// ⚠️ Honest limitation (kept in mind everywhere this is used): VoIP /
//    virtual-number detection is NOT perfect. Real SMS raises the cost
//    of sybil accounts — a phone number is cheap, a verifiable line is
//    less so — but it does not eliminate fabrication. Pair it with the
//    document-dedup and graph flags; never treat SMS as proof of a
//    unique human.
// ─────────────────────────────────────────────────────────────────────
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Retry a provider call with exponential backoff. Retries transient
 * failures (network errors, 5xx, provider-reported delivery failure);
 * permanent errors (4xx, bad creds) are rethrown after the first
 * attempt by only retrying when the error is marked retryable.
 */
async function withRetries(fn, { attempts = 3, baseDelayMs = 400 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err.retryable === false || i >= attempts - 1) throw lastErr;
      const delay = baseDelayMs * 2 ** i;
      logger.warn('sms_retry', { attempt: i + 1, delayMs: delay, error: err.message });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ── console (default, zero config — dev only) ───────────────────────
const consoleProvider = {
  name: 'console',
  async sendOtp(phone, code) {
    console.log('\n──────────────────────────────────────────────────');
    console.log(`  [SMS-STUB] 📱 OTP for ${phone}: ${code}`);
    console.log('  (Set SMS_PROVIDER=twilio or africastalking + credentials to send real SMS.)');
    console.log('──────────────────────────────────────────────────\n');
    return { provider: 'console', messageId: `stub-${Date.now()}` };
  },
  async sendMessage(phone, text) {
    console.log(`\n  [SMS-STUB] 📱 ${phone}: ${text}\n`);
    return { provider: 'console', messageId: `stub-${Date.now()}` };
  },
  // No real validation available — everything is allowed through.
  async validateNumber() {
    return { valid: true, isVoip: false, carrier: null };
  },
};

// ── twilio ───────────────────────────────────────────────────────────
const twilioProvider = {
  name: 'twilio',
  creds() {
    return {
      sid: process.env.TWILIO_ACCOUNT_SID || '',
      token: process.env.TWILIO_AUTH_TOKEN || '',
      from: process.env.TWILIO_FROM || '',
    };
  },
  assertCreds() {
    const { sid, token, from } = this.creds();
    if (!sid || !token || !from) {
      throw new Error('Twilio credentials missing (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM) — refusing to send');
    }
    return { sid, token, from };
  },
  async _send(phone, body) {
    const { sid, token, from } = this.assertCreds();
    return withRetries(async () => {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: {
          authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: phone, From: from, Body: body }),
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 300);
        // 4xx (bad creds, unverified sender) is permanent — no retry.
        const err = new Error(`Twilio send failed (${res.status}): ${text}`);
        if (res.status < 500) err.retryable = false;
        throw err;
      }
      const d = await res.json();
      logger.info('sms_sent', { provider: 'twilio', to: phone, messageId: d.sid });
      return { provider: 'twilio', messageId: d.sid };
    });
  },
  async sendOtp(phone, code) {
    return this._send(phone, `Zemen verification code: ${code}`);
  },
  async sendMessage(phone, text) {
    return this._send(phone, text);
  },
  // Lookup v2 line-type intelligence: is_voip is our VOIP/virtual signal.
  // Fails open on API errors (never block a real user because a lookup
  // timed out) — we only act on a confident is_voip=true.
  async validateNumber(phone) {
    const { sid, token } = this.creds();
    if (!sid || !token) return { valid: true, isVoip: false, carrier: null };
    try {
      const res = await fetch(
        `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(phone)}?Fields=line_type_intelligence`,
        { headers: { authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64') } }
      );
      if (!res.ok) return { valid: true, isVoip: false, carrier: null };
      const d = await res.json();
      return {
        valid: d.valid !== false,
        isVoip: d.line_type_intelligence?.is_voip === true,
        carrier: d.line_type_intelligence?.carrier_name || null,
      };
    } catch {
      return { valid: true, isVoip: false, carrier: null };
    }
  },
};

// ── africastalking (East Africa / Ethiopia reach) ────────────────────
const africastalkingProvider = {
  name: 'africastalking',
  creds() {
    return { apiKey: process.env.AFRICASTALKING_API_KEY || '', username: process.env.AFRICASTALKING_USERNAME || '', from: process.env.AFRICASTALKING_FROM || 'ZEMEN' };
  },
  assertCreds() {
    const { apiKey, username } = this.creds();
    if (!apiKey || !username) {
      throw new Error("Africa's Talking credentials missing (AFRICASTALKING_API_KEY / AFRICASTALKING_USERNAME) — refusing to send");
    }
    return this.creds();
  },
  // AT's two environments: sandbox credentials (username exactly
  // 'sandbox', keys from the Sandbox app) only authenticate against
  // api.sandbox.africastalking.com — sending them to the live host is
  // a 401. Any other username is a live account and uses the live host.
  // Same convention AT's own SDKs use (sandbox: true).
  baseUrl() {
    const { username } = this.creds();
    return String(username).trim().toLowerCase() === 'sandbox'
      ? 'https://api.sandbox.africastalking.com'
      : 'https://api.africastalking.com';
  },
  async sendOtp(phone, code) {
    return this._send(phone, `Zemen verification code: ${code}`);
  },
  async sendMessage(phone, text) {
    return this._send(phone, text);
  },
  async _send(phone, message) {
    const { apiKey, username, from } = this.assertCreds();
    return withRetries(async () => {
      const res = await fetch(`${this.baseUrl()}/version1/messaging`, {
        method: 'POST',
        headers: { apiKey, 'content-type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        // enqueue=1 moves the message into AT's queue and returns an
        // accepted state; the per-recipient status still tells us about
        // immediate rejections (bad number, insufficient balance).
        body: new URLSearchParams({ username, from, to: phone, message, enqueue: '1' }),
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 300);
        const err = new Error(`Africa's Talking send failed (${res.status}): ${text}`);
        if (res.status < 500) err.retryable = false;
        throw err;
      }
      const d = await res.json();
      // Delivery-failure handling: AT returns one entry per recipient
      // with a statusCode — 101 is "Success". Anything else means the
      // message was NOT queued for delivery (bad number, blocked, etc.)
      // and must surface loudly, not vanish.
      const recipients = d?.SMSMessageData?.Recipients || [];
      const failed = recipients.filter((r) => r.statusCode !== 101);
      if (failed.length) {
        const detail = failed.map((f) => `${f.number} → ${f.status || 'failed'} (${f.statusCode})`).join('; ');
        logger.error('sms_delivery_failed', { provider: 'africastalking', to: phone, detail });
        const err = new Error(`Africa's Talking reported a delivery failure: ${detail}`);
        err.retryable = false; // a rejected recipient won't fix itself
        throw err;
      }
      const messageId = recipients[0]?.messageId || String(Date.now());
      logger.info('sms_sent', { provider: 'africastalking', to: phone, messageId });
      return { provider: 'africastalking', messageId };
    });
  },
  /**
   * Best-effort delivery report for one number. AT does not expose a
   * line-type/VOIP flag in its SMS API, so validateNumber stays a
   * pass-through — but the send response above already surfaces
   * immediate delivery failures, and the operator can enable AT's
   * delivery-report webhook (see LAUNCH_CHECKLIST.md §SMS).
   */
  async deliveryReport(phone) {
    const { apiKey, username } = this.creds();
    if (!apiKey || !username) return { ok: false, recipients: [] };
    try {
      const res = await fetch(`${this.baseUrl()}/version1/messaging?username=${encodeURIComponent(username)}&to=${encodeURIComponent(phone)}`, {
        headers: { apiKey, Accept: 'application/json' },
      });
      if (!res.ok) return { ok: false, recipients: [] };
      const d = await res.json();
      return { ok: true, recipients: d?.SMSMessageData?.Recipients || [] };
    } catch {
      return { ok: false, recipients: [] };
    }
  },
  async validateNumber() {
    return { valid: true, isVoip: false, carrier: null };
  },
};

const PROVIDERS = { console: consoleProvider, twilio: twilioProvider, africastalking: africastalkingProvider };
const provider = PROVIDERS[config.smsProvider];

// Fail loudly on a typo'd provider — never silently fall back to console.
if (!provider) {
  logger.error('config_invalid', { name: 'SMS_PROVIDER', message: `unknown provider "${config.smsProvider}"` });
  throw new Error(`Unknown SMS_PROVIDER "${config.smsProvider}" (expected console, twilio or africastalking) — refusing to boot.`);
}

export default provider;
export { consoleProvider, twilioProvider, africastalkingProvider };
