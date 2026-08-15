import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Production-ish provider config for this test process — must be set
// before ANY module import so the shared config singleton picks it up.
process.env.DATABASE_URL = '';
process.env.DB_FILE = ':memory:';
process.env.PAYMENT_PROVIDER = 'chapa';
process.env.CHAPA_SECRET_KEY = 'test-chapa-secret';
process.env.CHAPA_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.SMS_PROVIDER = 'africastalking';
process.env.AFRICASTALKING_API_KEY = 'test-at-key';
process.env.AFRICASTALKING_USERNAME = 'zemen-test';

const { stubProvider, chapaProvider } = await import('../src/providers/payments.js');
const { config } = await import('../src/config.js');
const { africastalkingProvider } = await import('../src/providers/sms.js');
const { initDb, db } = await import('../src/db.js');
const { initSchema } = await import('../src/schema.js');
const { buildApp } = await import('../src/app.js');
const { createDeal, respondToDeal, fundEscrow } = await import('../src/services/deals.js');
const { nowIso } = await import('../src/crypto.js');

const originalFetch = globalThis.fetch;
const mockFetch = (handler) => {
  globalThis.fetch = async (url, opts) => handler(String(url), opts);
};
const jsonRes = (obj, status = 200) => ({
  ok: status < 400, status,
  text: async () => JSON.stringify(obj),
  json: async () => obj,
});

test('stub payments provider keeps the local dev shape', async () => {
  const deposit = await stubProvider.deposit({ amount: 100, currency: 'ETB', ref: 'R1' });
  assert.equal(deposit.status, 'funded');
  assert.ok(deposit.reference);
  const release = await stubProvider.release({ amount: 100, currency: 'ETB', ref: 'R1' });
  assert.equal(release.status, 'released');
  const refund = await stubProvider.refund({ amount: 100, currency: 'ETB', ref: 'R1' });
  assert.equal(refund.status, 'refunded');
});

test('chapa deposit creates a hosted checkout and returns pending', async () => {
  const calls = [];
  mockFetch(async (url, opts) => {
    calls.push({ url, opts });
    return jsonRes({ status: 'success', data: { checkout_url: 'https://checkout.chapa.global/payment/X' } });
  });
  try {
    const d = await chapaProvider.deposit({ amount: 100, currency: 'ETB', ref: 'DEAL-1' });
    assert.equal(d.status, 'pending', 'hosted checkout is pending until the webhook confirms it');
    assert.equal(d.checkoutUrl, 'https://checkout.chapa.global/payment/X');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/v2/payments/hosted'));
    assert.ok(calls[0].opts.headers.authorization.includes('test-chapa-secret'), 'secret key is sent as Bearer');
    assert.ok(JSON.parse(calls[0].opts.body).merchant_reference === 'DEAL-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chapa API failures throw loudly (no silent fallback)', async () => {
  mockFetch(async () => jsonRes({ message: 'invalid secret key' }, 401));
  try {
    await assert.rejects(chapaProvider.deposit({ amount: 100, currency: 'ETB', ref: 'D2' }), /failed \(401\)/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chapa webhook signature verification', () => {
  const body = JSON.stringify({ event: 'charge.success', tx_ref: 'DEAL-1', status: 'success' });
  const good = crypto.createHmac('sha256', process.env.CHAPA_WEBHOOK_SECRET).update(body).digest('hex');
  assert.equal(chapaProvider.verifyWebhook(body, { 'x-chapa-signature': good }), true);
  assert.equal(chapaProvider.verifyWebhook(body, { 'chapa-signature': good }), true, 'legacy header accepted');
  assert.equal(chapaProvider.verifyWebhook(body, { 'x-chapa-signature': 'deadbeef' }), false, 'tampered body/signature rejected');
  assert.equal(chapaProvider.verifyWebhook(body, {}), false, 'missing signature header rejected');
});

// ── Chapa v1 (classic platform, CHASECK_... keys, api.chapa.co) ─────
// The version is read from config at call time, so flipping it here
// exercises the v1 API surface without re-importing the module.

function withChapaV1(fn) {
  return async () => {
    const saved = { version: config.chapa.version, apiUrl: config.chapa.apiUrl };
    config.chapa.version = 'v1';
    config.chapa.apiUrl = 'https://api.chapa.co';
    try {
      await fn();
    } finally {
      config.chapa.version = saved.version;
      config.chapa.apiUrl = saved.apiUrl;
    }
  };
}

test('chapa v1 deposit uses /v1/transaction/initialize with tx_ref', withChapaV1(async () => {
  const calls = [];
  mockFetch(async (url, opts) => {
    calls.push({ url, opts });
    return jsonRes({ message: 'Hosted Link', status: 'success', data: { checkout_url: 'https://checkout.chapa.co/checkout/payment/X' } });
  });
  try {
    const d = await chapaProvider.deposit({ amount: 100, currency: 'ETB', ref: 'DEAL-V1' });
    assert.equal(d.status, 'pending');
    assert.equal(d.checkoutUrl, 'https://checkout.chapa.co/checkout/payment/X');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/v1/transaction/initialize'), 'v1 initialize endpoint');
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.tx_ref, 'DEAL-V1', 'v1 identifies the payment by tx_ref');
    assert.equal(d.reference, 'DEAL-V1', 'v1 reference IS the deal ref (verify is by tx_ref)');
  } finally {
    globalThis.fetch = originalFetch;
  }
}));

test('chapa v1 confirmPayment verifies by tx_ref (our deal ref)', withChapaV1(async () => {
  mockFetch(async (url) => {
    assert.ok(url.endsWith('/v1/transaction/verify/DEAL-V1'), 'v1 verify by tx_ref');
    return jsonRes({ message: 'Payment details fetched successfully', status: 'success', data: { status: 'success', tx_ref: 'DEAL-V1', amount: 100 } });
  });
  try {
    const c = await chapaProvider.confirmPayment('DEAL-V1');
    assert.equal(c.confirmed, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
}));

test('chapa v1 payout resolves the mobile-money bank id and transfers', withChapaV1(async () => {
  const calls = [];
  mockFetch(async (url, opts) => {
    calls.push({ url, opts });
    if (url.endsWith('/v1/banks')) {
      return jsonRes({ status: 'success', data: [{ id: 855, slug: 'telebirr', is_mobilemoney: 1 }] });
    }
    if (url.endsWith('/v1/transfers')) {
      return jsonRes({ status: 'success', data: 'RLSE-DEAL-V1' });
    }
    throw new Error('unexpected v1 url ' + url);
  });
  try {
    const r = await chapaProvider.release({ amount: 100, currency: 'ETB', ref: 'DEAL-V1', toPhone: '+251911000001', toName: 'Abebe Kebede' });
    assert.equal(r.status, 'released');
    const transfer = calls.find((c) => c.url.endsWith('/v1/transfers'));
    assert.ok(transfer, 'payout hits v1 transfers');
    const body = JSON.parse(transfer.opts.body);
    assert.equal(body.bank_code, 855, 'mobile-money bank id resolved from /v1/banks');
    assert.equal(body.account_number, '251911000001', 'phone is E.164 without the + for v1');
    assert.equal(body.account_name, 'Abebe Kebede');
  } finally {
    globalThis.fetch = originalFetch;
  }
}));

test('chapa confirmPayment re-verifies server-side', async () => {
  mockFetch(async (url) => {
    assert.ok(url.endsWith('/v2/payments/CHA-123/verify'));
    return jsonRes({ status: 'success', data: { status: 'success', amount: 100, currency: 'ETB', tx_ref: 'DEAL-1' } });
  });
  try {
    const c = await chapaProvider.confirmPayment('CHA-123');
    assert.equal(c.confirmed, true);
    assert.equal(c.txRef, 'DEAL-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('africastalking send parses delivery status and surfaces failures', async () => {
  mockFetch(async () => jsonRes({ SMSMessageData: { Recipients: [{ statusCode: 101, messageId: 'mid-1', status: 'Success' }] } }));
  try {
    const out = await africastalkingProvider.sendOtp('+251911000001', '123456');
    assert.equal(out.messageId, 'mid-1');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // A non-101 statusCode is a delivery failure → loud error.
  mockFetch(async () => jsonRes({ SMSMessageData: { Recipients: [{ statusCode: 406, number: '+251911000001', status: 'Banned' }] } }));
  try {
    await assert.rejects(africastalkingProvider.sendOtp('+251911000001', '123456'), /delivery failure/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('africastalking retries transient failures with backoff', async () => {
  let calls = 0;
  mockFetch(async () => {
    calls += 1;
    if (calls < 3) return { ok: false, status: 500, text: async () => 'upstream boom' };
    return jsonRes({ SMSMessageData: { Recipients: [{ statusCode: 101, messageId: 'mid-retry' }] } });
  });
  try {
    const out = await africastalkingProvider.sendOtp('+251911000001', '111111');
    assert.equal(out.messageId, 'mid-retry');
    assert.equal(calls, 3, 'two failed attempts then a success');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('africastalking refuses to send without credentials', async () => {
  const { AFRICASTALKING_API_KEY, AFRICASTALKING_USERNAME } = process.env;
  delete process.env.AFRICASTALKING_API_KEY;
  delete process.env.AFRICASTALKING_USERNAME;
  try {
    await assert.rejects(africastalkingProvider.sendOtp('+251911000001', '111111'), /refusing to send/);
  } finally {
    process.env.AFRICASTALKING_API_KEY = AFRICASTALKING_API_KEY;
    process.env.AFRICASTALKING_USERNAME = AFRICASTALKING_USERNAME;
  }
});

test('africastalking routes sandbox credentials to the sandbox host', async () => {
  // AT's convention: username exactly 'sandbox' authenticates only
  // against api.sandbox.africastalking.com — a sandbox key sent to the
  // live host is a 401. Route by username like AT's own SDKs do.
  const { AFRICASTALKING_USERNAME } = process.env;
  process.env.AFRICASTALKING_USERNAME = 'sandbox';
  let hitUrl = '';
  mockFetch(async (url) => {
    hitUrl = url;
    return jsonRes({ SMSMessageData: { Recipients: [{ statusCode: 101, messageId: 'mid-sandbox' }] } });
  });
  try {
    const out = await africastalkingProvider.sendOtp('+251911000001', '222222');
    assert.ok(hitUrl.startsWith('https://api.sandbox.africastalking.com/version1/messaging'), hitUrl);
    assert.equal(out.messageId, 'mid-sandbox');
  } finally {
    process.env.AFRICASTALKING_USERNAME = AFRICASTALKING_USERNAME;
  }

  // A live (non-sandbox) username goes to the live host.
  process.env.AFRICASTALKING_USERNAME = 'zemen-live';
  try {
    await africastalkingProvider.sendOtp('+251911000001', '333333');
    assert.ok(hitUrl.startsWith('https://api.africastalking.com/version1/messaging'), hitUrl);
  } finally {
    process.env.AFRICASTALKING_USERNAME = AFRICASTALKING_USERNAME;
    globalThis.fetch = originalFetch;
  }
});

// ── webhook → escrow end-to-end ─────────────────────────────────────
test('a verified charge.success webhook flips escrow pending → funded (idempotent)', async () => {
  await initDb();
  await initSchema();

  const { lastId: payer } = await db.run(
    `INSERT INTO users (phone, name, report_token, created_at) VALUES (?, 'Payer', 'PW-1', ?)`,
    ['+251911000021', nowIso()]
  );
  const { lastId: payee } = await db.run(
    `INSERT INTO users (phone, name, report_token, created_at) VALUES (?, 'Payee', 'PW-2', ?)`,
    ['+251911000022', nowIso()]
  );
  await db.run(
    `INSERT INTO otp_codes (phone, code, purpose, expires_at, used, attempts, created_at) VALUES (?, '555555', 'action', ?, 0, 0, ?)`,
    ['+251911000021', new Date(Date.now() + 60_000).toISOString(), nowIso()]
  );

  // Mock both provider calls: hosted checkout (deposit) and verify.
  const deal = await createDeal({ id: payer }, {
    phone: '+251911000022', description: 'webhook test', deliverable: 'x', amount: 100, escrow: true,
  });
  await respondToDeal(deal.id, { id: payee }, true); // → agreed (fundable)
  mockFetch(async (url, opts) => {
    if (url.includes('api.chapa.global')) {
      if (url.includes('/v2/payments/hosted')) {
        return jsonRes({ status: 'success', data: { checkout_url: 'https://checkout.chapa.global/payment/W1' } });
      }
      if (url.includes('/verify')) {
        return jsonRes({ status: 'success', data: { status: 'success', amount: 100, currency: 'ETB', tx_ref: deal.ref } });
      }
      throw new Error('unexpected chapa url ' + url);
    }
    // Everything else (the webhook POST to the local test server)
    // passes through to the real network.
    return originalFetch(url, opts);
  });

  // The fetch mock stays active through the webhook POST too — the
  // webhook handler re-verifies server-side with confirmPayment.
  const payerRow = await db.get('SELECT * FROM users WHERE id = ?', [payer]);
  const funded = await fundEscrow(deal.id, payerRow, '555555');
  assert.equal(funded.escrow_state, 'pending', 'hosted checkout leaves escrow pending');
  assert.equal(funded.escrow_checkout_url, 'https://checkout.chapa.global/payment/W1');

  const app = buildApp();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const webhookBody = JSON.stringify({
    event: 'charge.success', tx_ref: deal.ref, reference: 'CHA-W1',
    amount: '100', currency: 'ETB', status: 'success',
  });
  const goodSig = crypto.createHmac('sha256', process.env.CHAPA_WEBHOOK_SECRET).update(webhookBody).digest('hex');
  const send = (sig) => fetch(`${base}/api/payments/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(sig ? { 'x-chapa-signature': sig } : {}) },
    body: webhookBody,
  });

  try {
    // Bad signature → rejected.
    const bad = await send('cafebabe');
    assert.equal(bad.status, 401, 'unsigned/tampered webhook is rejected');

    // Good signature → escrow flips to funded and a ledger row appears.
    const good = await send(goodSig);
    assert.equal(good.status, 200);
    const after = await db.get('SELECT * FROM transactions WHERE id = ?', [deal.id]);
    assert.equal(after.escrow_state, 'funded', 'provider-confirmed payment records escrow as funded');

    // Replay (idempotent): same outcome, no second ledger row.
    await send(goodSig);
    const again = await db.get('SELECT * FROM transactions WHERE id = ?', [deal.id]);
    assert.equal(again.escrow_state, 'funded');
    const fundedRows = await db.all('SELECT id FROM ledger WHERE tx_id = ? AND event = ?', [deal.id, 'escrow_funded']);
    assert.equal(fundedRows.length, 1, 'webhook replay does not double-record');
  } finally {
    server.close();
    globalThis.fetch = originalFetch;
  }
});
