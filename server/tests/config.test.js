import test from 'node:test';
import assert from 'node:assert/strict';

// Development default: zero-config startup must validate clean.
const devConfig = await import('../src/config.js');

test('development config validates clean by default', () => {
  assert.deepEqual(devConfig.validateConfig(), []);
});

/** Re-import config with the current process.env (fresh module instance). */
async function freshConfig() {
  return import('../src/config.js?t=' + Date.now() + Math.random());
}

function setProdWith(overrides = {}) {
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = 'zemen-dev-secret-change-me'; // the dev default
  delete process.env.SMS_PROVIDER;
  delete process.env.PAYMENT_PROVIDER;
  delete process.env.AFRICASTALKING_API_KEY;
  delete process.env.AFRICASTALKING_USERNAME;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_FROM;
  delete process.env.CHAPA_SECRET_KEY;
  delete process.env.CHAPA_WEBHOOK_SECRET;
  Object.assign(process.env, overrides);
}

test('production refuses the dev JWT secret and the stub providers', async () => {
  setProdWith();
  const { validateConfig } = await freshConfig();
  const problems = validateConfig();
  const names = problems.map((p) => p.name);
  assert.ok(names.includes('JWT_SECRET'), 'JWT_SECRET flagged when it is the dev default');
  assert.ok(names.includes('SMS_PROVIDER'), 'SMS_PROVIDER flagged when console/stub');
  assert.ok(names.includes('PAYMENT_PROVIDER'), 'PAYMENT_PROVIDER flagged when stub');
  assert.ok(problems.every((p) => p.message), 'every problem carries a clear message');
});

test('production refuses a short JWT secret', async () => {
  setProdWith({ JWT_SECRET: 'short-secret' });
  const { validateConfig } = await freshConfig();
  const jwt = validateConfig().find((p) => p.name === 'JWT_SECRET');
  assert.ok(jwt && /32/.test(jwt.message), 'short secrets are rejected with a length hint');
});

test('production boots only when everything required is configured', async () => {
  setProdWith({
    JWT_SECRET: 'x'.repeat(48),
    SMS_PROVIDER: 'africastalking',
    AFRICASTALKING_API_KEY: 'atk',
    AFRICASTALKING_USERNAME: 'zemen',
    PAYMENT_PROVIDER: 'chapa',
    CHAPA_SECRET_KEY: 'chapa-sk',
    CHAPA_WEBHOOK_SECRET: 'chapa-wh',
  });
  const { validateConfig } = await freshConfig();
  assert.deepEqual(validateConfig(), []);
});

test('production rejects a half-configured SMS provider (keys missing)', async () => {
  setProdWith({
    JWT_SECRET: 'x'.repeat(48),
    SMS_PROVIDER: 'africastalking', // no AFRICASTALKING_API_KEY / USERNAME
    PAYMENT_PROVIDER: 'chapa',
    CHAPA_SECRET_KEY: 'chapa-sk',
    CHAPA_WEBHOOK_SECRET: 'chapa-wh',
  });
  const { validateConfig } = await freshConfig();
  const names = validateConfig().map((p) => p.name);
  assert.ok(names.includes('AFRICASTALKING_API_KEY'));
  assert.ok(names.includes('AFRICASTALKING_USERNAME'));
});
