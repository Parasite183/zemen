// ─────────────────────────────────────────────────────────────────────
// API smoke test — exercises the whole backend as a real client would:
//   OTP auth → create deal → accept → escrow → start → deliver → confirm
//   → ledger integrity → reputation → trust report → dispute → resolve
//
//   Usage:  node scripts/smoke-api.js   (server must be running on :3001)
// ─────────────────────────────────────────────────────────────────────
const BASE = process.env.BASE || 'http://localhost:3001';
const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond, extra });
  console.log(`  ${cond ? '✔' : '✖'} ${name}${extra ? ` — ${extra}` : ''}`);
};

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function login(phone) {
  const req = await api('/api/auth/request-otp', { method: 'POST', body: { phone } });
  if (req.status !== 200) throw new Error(`OTP request failed for ${phone}`);
  const peek = await api(`/api/auth/dev/otp?phone=${encodeURIComponent(phone)}`);
  const code = peek.json.code;
  if (!code) throw new Error(`No dev OTP for ${phone}`);
  const v = await api('/api/auth/verify-otp', { method: 'POST', body: { phone, code } });
  if (v.status !== 200) throw new Error(`Verify failed for ${phone}`);
  return { token: v.json.token, user: v.json.user };
}

// High-stakes actions (funding escrow, confirming a large deal) re-auth
// with a fresh OTP sent to the account phone. Request it, then peek it
// via the dev endpoint the same way login() does.
async function actionOtp(token, phone) {
  const req = await api('/api/auth/action-otp', { method: 'POST', token });
  if (req.status !== 200) throw new Error(`Action OTP request failed for ${phone}`);
  const peek = await api(`/api/auth/dev/otp?phone=${encodeURIComponent(phone)}`);
  const code = peek.json.code;
  if (!code) throw new Error(`No action OTP for ${phone}`);
  return code;
}

const main = async () => {
  console.log('\n── Zemen API smoke test ─────────────────────────────');

  // 0. health
  const health = await api('/api/health');
  check('health endpoint', health.status === 200);

  // 1. OTP auth
  const sara = await login('+251 911 000 002');
  const abebe = await login('+251 911 000 001');
  check('OTP login works', !!(sara.token && abebe.token));
  check('existing user loaded (not new)', sara.user.id !== undefined && sara.user.name === 'Sara Tesfaye');

  // 2. create deal (Abebe → Sara) with escrow
  const created = await api('/api/deals', {
    method: 'POST', token: abebe.token,
    body: { phone: '+251911000002', description: 'Smoke test: shop sign design', deliverable: '2 concepts + print files', amount: 5000, currency: 'ETB', deadline: '2026-09-01', escrow: true },
  });
  check('deal created', created.status === 201, created.json?.deal?.ref);
  const dealId = created.json.deal.id;

  // 3. Sara accepts → terms hashed
  const agreed = await api(`/api/deals/${dealId}/respond`, { method: 'POST', token: sara.token, body: { accept: true } });
  check('deal agreed with terms hash', agreed.json.deal.status === 'agreed' && agreed.json.deal.terms_hash?.length === 64);

  // 4. escrow funded (payer = Abebe) — high-stakes, needs a fresh action OTP
  const escrowOtp = await actionOtp(abebe.token, '+251 911 000 001');
  const funded = await api(`/api/deals/${dealId}/escrow/deposit`, { method: 'POST', token: abebe.token, body: { otp: escrowOtp } });
  check('escrow funded', funded.status === 200 && funded.json.deal.escrow_state === 'funded', funded.json.deal?.escrow_ref);

  // 5. start → deliver → confirm
  await api(`/api/deals/${dealId}/start`, { method: 'POST', token: abebe.token });
  const delivered = await api(`/api/deals/${dealId}/deliver`, { method: 'POST', token: abebe.token });
  check('delivered', delivered.json.deal.status === 'delivered');
  const confirmOtp = await actionOtp(sara.token, '+251 911 000 002');
  const confirmed = await api(`/api/deals/${dealId}/confirm`, { method: 'POST', token: sara.token, body: { otp: confirmOtp } });
  check('confirmed + escrow released', confirmed.status === 200 && confirmed.json.deal.status === 'confirmed' && confirmed.json.deal.escrow_state === 'released');

  // 6. ledger integrity
  const chain = await api('/api/ledger/verify', { token: abebe.token });
  check('ledger chain valid', chain.json.valid === true, `${chain.json.count} entries`);
  const dealLedger = await api(`/api/deals/${dealId}/ledger`, { token: abebe.token });
  check('deal has chained ledger trail', dealLedger.json.entries.length >= 6);

  // 7. reputation updated
  const meSara = await api('/api/auth/me', { token: sara.token });
  check('reputation exists for Sara', meSara.json.reputation?.total_completed >= 1);

  // 8. trust report (public, by token)
  const tokenRes = await api('/api/me/report-token', { token: sara.token });
  const report = await api(`/api/public/report/${tokenRes.json.reportToken}`);
  check('public trust report generated', report.status === 200 && !!report.json.seal, `${report.json.report?.history?.length ?? 0} history rows`);

  // 9. directory
  const dir = await api('/api/directory?q=Abebe', { token: sara.token });
  check('directory search finds Abebe', dir.json.results.some((r) => r.name === 'Abebe Kebede'));

  // 10. dispute flow on a second deal (no escrow) — moderator resolves
  const created2 = await api('/api/deals', {
    method: 'POST', token: abebe.token,
    body: { phone: '+251911000002', description: 'Smoke test: disputed job', deliverable: 'Deliverable X', amount: 900, currency: 'ETB', escrow: false },
  });
  const deal2 = created2.json.deal.id;
  await api(`/api/deals/${deal2}/respond`, { method: 'POST', token: sara.token, body: { accept: true } });
  await api(`/api/deals/${deal2}/start`, { method: 'POST', token: abebe.token });
  await api(`/api/deals/${deal2}/deliver`, { method: 'POST', token: abebe.token });
  const dispute = await api('/api/disputes', { method: 'POST', token: sara.token, body: { transaction_id: deal2, reason: 'Work not as described' } });
  check('dispute raised', dispute.status === 201 && dispute.json.dispute?.status === 'open');
  const disputeId = dispute.json.dispute.id;

  await api(`/api/disputes/${disputeId}/statements`, { method: 'POST', token: sara.token, body: { body: 'The delivered work is not what we agreed.' } });
  const stmt2 = await api(`/api/disputes/${disputeId}/statements`, { method: 'POST', token: abebe.token, body: { body: 'We agreed on these specs.' } });
  check('both parties filed statements', stmt2.json.dispute.statements.length === 2);

  const lidya = await login('+251 911 000 004');
  const meron = await login('+251 911 000 008');
  const queue = await api('/api/disputes/modqueue', { token: lidya.token });
  check('moderator queue shows dispute', queue.json.disputes.some((d) => d.id === disputeId));

  const voted = await api(`/api/disputes/${disputeId}/vote`, { method: 'POST', token: lidya.token, body: { verdict: 'party_a', note: 'Deliverer (Abebe) wins — release escrow to deliverer.' } });
  check('moderator vote resolves dispute', voted.json.dispute.status === 'resolved', `resolution=${voted.json.dispute.resolution}`);

  const deal2After = await api(`/api/deals/${deal2}`, { token: sara.token });
  // verdict party_a = deliverer (Abebe) wins → deal confirmed
  check('disputed deal confirmed (deliverer won)', deal2After.json.deal.status === 'confirmed');

  // 11. staff override — two-person sign-off: a proposal alone must not
  // resolve; a second, different staff account confirms it.
  const created3 = await api('/api/deals', {
    method: 'POST', token: sara.token,
    body: { phone: '+251911000001', description: 'Smoke test: staff resolve', deliverable: 'Y', amount: 700, currency: 'ETB', escrow: false },
  });
  const deal3 = created3.json.deal.id;
  await api(`/api/deals/${deal3}/respond`, { method: 'POST', token: abebe.token, body: { accept: true } });
  await api(`/api/deals/${deal3}/start`, { method: 'POST', token: sara.token });
  await api(`/api/deals/${deal3}/deliver`, { method: 'POST', token: sara.token });
  const d3 = await api('/api/disputes', { method: 'POST', token: abebe.token, body: { transaction_id: deal3, reason: 'Test staff path' } });
  const proposed = await api(`/api/disputes/${d3.json.dispute.id}/resolve`, { method: 'POST', token: lidya.token, body: { action: 'propose', verdict: 'party_b', reason: 'Smoke: staff override proposal' } });
  check('staff proposal alone does not resolve', proposed.json.dispute.status === 'open');
  const overrideConfirmed = await api(`/api/disputes/${d3.json.dispute.id}/resolve`, { method: 'POST', token: meron.token, body: { action: 'confirm', verdict: 'party_b', reason: 'Smoke: second staff agrees' } });
  check('second staff confirm resolves the override', overrideConfirmed.json.dispute.status === 'resolved');
  const deal3After = await api(`/api/deals/${deal3}`, { token: sara.token });
  // verdict party_b ≠ deliverer (Sara) → payer wins → deal failed
  check('staff resolution marked deal failed', deal3After.json.deal.status === 'failed');

  // 12. privacy: phone masked on public profile
  const profile = await api(`/api/users/${sara.user.id}`, { token: abebe.token });
  const masked = profile.json.user.phone;
  check('phone masked on public profile', masked.includes('•••') && !masked.replace(/[^0-9+]/g, '').includes('11000'));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length ? 1 : 0);
};

main().catch((e) => {
  console.error('Smoke test crashed:', e);
  process.exit(1);
});
