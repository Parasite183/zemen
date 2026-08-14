// ─────────────────────────────────────────────────────────────────────
// SMS provider — STUB.
//
// In production this is the single place to swap in a real gateway
// (e.g. Africa's Talking, Twilio, Vonage, or a local aggregator).
// Implement the same two functions and the rest of the app is unchanged.
// ─────────────────────────────────────────────────────────────────────

const smsProvider = {
  name: 'stub',

  /**
   * Deliver an OTP to a phone number.
   * The stub "sends" by printing to the server console, which is where
   * demo users read their codes.
   * @returns {{ provider: string, messageId: string }}
   */
  async sendOtp(phone, code) {
    console.log('\n──────────────────────────────────────────────────');
    console.log(`  [SMS-STUB] 📱 OTP for ${phone}: ${code}`);
    console.log('  (In production this goes out via a real SMS gateway.)');
    console.log('──────────────────────────────────────────────────\n');
    return { provider: 'stub', messageId: `stub-${Date.now()}` };
  },

  /** Send an arbitrary template message (notifications, receipts...). */
  async sendMessage(phone, text) {
    console.log(`\n  [SMS-STUB] 📱 ${phone}: ${text}\n`);
    return { provider: 'stub', messageId: `stub-${Date.now()}` };
  },
};

export default smsProvider;
