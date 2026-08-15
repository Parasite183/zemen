// ─────────────────────────────────────────────────────────────────────
// Structured logger — one JSON object per line on stdout/stderr.
//
//   logger.info('deal_created', { dealId: 1 })
//   → {"ts":"2026-08-15T…","level":"info","event":"deal_created","dealId":1}
//
// On Cloudflare Workers these lines land in the Worker's structured
// logs, where they can be streamed to an external sink (Workers Logs →
// Logpush/R2) and alerted on. In plain Node they land in the process
// stdout/stderr, ready for any log collector. Every line is a single
// JSON document — never mix with ad-hoc console.log in hot paths that
// need to be machine-readable.
//
// Conventions for the security-critical events the launch checklist
// asks to surface as alerts (all use level ≥ warn):
//   auth_failed                 — wrong/expired/too-many OTP attempts
//   auth_rate_limited           — client hit a rate-limit window
//   moderator_blocked           — moderator/staff denied on conflict
//                                (mirrors dispute_moderator_log rows)
//   payment_provider_error      — Chapa API call failed
//   payment_webhook_rejected    — webhook with a bad signature/unknown ref
//   sms_delivery_failed         — provider reported a non-delivery
// ─────────────────────────────────────────────────────────────────────

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function emit(level, event, data = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  });
  // Errors and warnings go to stderr so stdout stays clean for
  // programmatic consumers; info/debug go to stdout.
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
  return line;
}

export const logger = {
  debug: (event, data) => emit('debug', event, data),
  info: (event, data) => emit('info', event, data),
  warn: (event, data) => emit('warn', event, data),
  error: (event, data) => emit('error', event, data),
};
