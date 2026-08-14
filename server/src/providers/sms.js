// ─────────────────────────────────────────────────────────────────────
// SMS provider — swappable, selected by SMS_PROVIDER env:
//   'console'        (default)  logs to the server console; no creds
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
// ⚠️ Honest limitation (kept in mind everywhere this is used): VoIP /
//    virtual-number detection is NOT perfect. Real SMS raises the cost
//    of sybil accounts — a phone number is cheap, a verifiable line is
//    less so — but it does not eliminate fabrication. Pair it with the
//    document-dedup and graph flags; never treat SMS as proof of a
//    unique human.
// ─────────────────────────────────────────────────────────────────────
import { config } from '../config.js';

const ttl = () => new Date().toISOString();

// ── console (default, zero config) ───────────────────────────────────
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
  async sendOtp(phone, code) {
    const { sid, token, from } = this.creds();
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: phone, From: from, Body: `Zemen verification code: ${code}` }),
    });
    if (!res.ok) throw new Error('Twilio send failed: ' + (await res.text()).slice(0, 300));
    const d = await res.json();
    return { provider: 'twilio', messageId: d.sid };
  },
  async sendMessage(phone, text) {
    const { sid, token, from } = this.creds();
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: phone, From: from, Body: text }),
    });
    if (!res.ok) throw new Error('Twilio send failed: ' + (await res.text()).slice(0, 300));
    const d = await res.json();
    return { provider: 'twilio', messageId: d.sid };
  },
  // Lookup v2 line-type intelligence: is_voip is our VOIP/virtual signal.
  // Fails open on API errors (never block a real user because a lookup
  // timed out) — we only act on a confident is_voip=true.
  async validateNumber(phone) {
    const { sid, token } = this.creds();
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
  async sendOtp(phone, code) {
    return this._send(phone, `Zemen verification code: ${code}`);
  },
  async sendMessage(phone, text) {
    return this._send(phone, text);
  },
  async _send(phone, message) {
    const { apiKey, username, from } = this.creds();
    const res = await fetch('https://api.africastalking.com/version1/messaging', {
      method: 'POST',
      headers: { apiKey, 'content-type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ username, from, to: phone, message }),
    });
    if (!res.ok) throw new Error('Africa\'s Talking send failed: ' + (await res.text()).slice(0, 300));
    return { provider: 'africastalking', messageId: ttl() };
  },
  // Africa's Talking does not expose a line-type/VOIP flag in its SMS
  // API; validation is best-effort (nothing to check beyond format, which
  // normalizePhone already did). Real SMS reach still raises sybil cost.
  async validateNumber() {
    return { valid: true, isVoip: false, carrier: null };
  },
};

const PROVIDERS = { console: consoleProvider, twilio: twilioProvider, africastalking: africastalkingProvider };
const provider = PROVIDERS[config.smsProvider] || consoleProvider;
if (config.smsProvider !== 'console' && !PROVIDERS[config.smsProvider]) {
  console.warn(`[sms] Unknown SMS_PROVIDER "${config.smsProvider}" — falling back to console.`);
}
if (config.smsProvider !== 'console' && config.smsProvider === 'twilio' && !(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM)) {
  console.warn('[sms] SMS_PROVIDER=twilio but TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM are missing — sends will fail until configured.');
}

export default provider;
