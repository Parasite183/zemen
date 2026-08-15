import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = '';
process.env.DB_FILE = ':memory:';

const { initDb, db } = await import('../src/db.js');
const { initSchema } = await import('../src/schema.js');
const { buildApp } = await import('../src/app.js');
const { issueSession } = await import('../src/auth.js');
const { nowIso } = await import('../src/crypto.js');

let server;
let base;

test('setup: in-memory app', async () => {
  await initDb();
  await initSchema();
  const app = buildApp();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

let n = 0;
async function mkUser({ name, moderator = false, staff = false, owner = false }) {
  const { lastId } = await db.run(
    `INSERT INTO users (phone, name, report_token, is_moderator, is_staff, is_owner, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['+2519' + String(90000000 + ++n), name, 'RP-' + n, moderator ? 1 : 0, staff ? 1 : 0, owner ? 1 : 0, nowIso()]
  );
  return lastId;
}

const post = (path, body, token) =>
  fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
const get = (path, token) => fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });

test('a plain user cannot manage roles', async () => {
  const actor = await mkUser({ name: 'PlainUser' });
  const target = await mkUser({ name: 'Target' });
  const { token } = await issueSession({ id: actor }, 'test', '');
  const res = await post('/api/mod/manage', { userId: target, role: 'moderator', grant: true, reason: 'x' }, token);
  assert.equal(res.status, 403);
});

test('a moderator (not staff) cannot manage roles', async () => {
  const actor = await mkUser({ name: 'ModOnly', moderator: true });
  const target = await mkUser({ name: 'Target2' });
  const { token } = await issueSession({ id: actor }, 'test', '');
  const res = await post('/api/mod/manage', { userId: target, role: 'moderator', grant: true, reason: 'x' }, token);
  assert.equal(res.status, 403);
});

test('staff can grant and revoke moderator, and every change is audited', async () => {
  const actor = await mkUser({ name: 'StaffActor', staff: true });
  const target = await mkUser({ name: 'NewMod' });
  const { token } = await issueSession({ id: actor }, 'test', '');

  const grant = await post('/api/mod/manage', { userId: target, role: 'moderator', grant: true, reason: 'Vetted in person' }, token);
  assert.equal(grant.status, 200);
  const row = await db.get('SELECT is_moderator FROM users WHERE id = ?', [target]);
  assert.equal(row.is_moderator, 1);
  const audit = await db.get('SELECT * FROM role_audit WHERE target_id = ? ORDER BY id DESC LIMIT 1', [target]);
  assert.equal(audit.action, 'grant_moderator');
  assert.equal(audit.actor_id, actor);
  assert.equal(audit.reason, 'Vetted in person');

  // Re-granting the same role is a no-op — no duplicate audit row.
  const dup = await post('/api/mod/manage', { userId: target, role: 'moderator', grant: true, reason: 'again' }, token);
  assert.equal(dup.status, 200);
  const count = await db.get('SELECT COUNT(*) AS n FROM role_audit WHERE target_id = ?', [target]);
  assert.equal(count.n, 1);

  const revoke = await post('/api/mod/manage', { userId: target, role: 'moderator', grant: false, reason: 'Inactive' }, token);
  assert.equal(revoke.status, 200);
  const row2 = await db.get('SELECT is_moderator FROM users WHERE id = ?', [target]);
  assert.equal(row2.is_moderator, 0);
});

test('only the owner can grant or revoke staff', async () => {
  const staffActor = await mkUser({ name: 'StaffOnly', staff: true });
  const target = await mkUser({ name: 'WouldBeStaff' });
  const { token: staffToken } = await issueSession({ id: staffActor }, 'test', '');
  const forbidden = await post('/api/mod/manage', { userId: target, role: 'staff', grant: true, reason: 'x' }, staffToken);
  assert.equal(forbidden.status, 403);
  assert.match((await forbidden.json()).code || '', /owner_only/);

  const owner = await mkUser({ name: 'Owner', owner: true, staff: true });
  const { token: ownerToken } = await issueSession({ id: owner }, 'test', '');
  const grant = await post('/api/mod/manage', { userId: target, role: 'staff', grant: true, reason: 'Ops lead' }, ownerToken);
  assert.equal(grant.status, 200);
  const row = await db.get('SELECT is_staff FROM users WHERE id = ?', [target]);
  assert.equal(row.is_staff, 1);
  const audit = await db.get('SELECT action FROM role_audit WHERE target_id = ? ORDER BY id DESC LIMIT 1', [target]);
  assert.equal(audit.action, 'grant_staff');
});

test('nobody can change their own role', async () => {
  const actor = await mkUser({ name: 'SelfPromoter', staff: true });
  const { token } = await issueSession({ id: actor }, 'test', '');
  const res = await post('/api/mod/manage', { userId: actor, role: 'moderator', grant: false, reason: 'x' }, token);
  assert.equal(res.status, 403);
});

test('missing or bad payloads are rejected', async () => {
  const actor = await mkUser({ name: 'Validator', staff: true });
  const { token } = await issueSession({ id: actor }, 'test', '');
  const noRole = await post('/api/mod/manage', { userId: actor, grant: true, reason: 'x' }, token);
  assert.equal(noRole.status, 400);
  const badRole = await post('/api/mod/manage', { userId: 1, role: 'admin', grant: true, reason: 'x' }, token);
  assert.equal(badRole.status, 400);
  const missingUser = await post('/api/mod/manage', { userId: 999999, role: 'moderator', grant: true, reason: 'x' }, token);
  assert.equal(missingUser.status, 404);
});

test('role overview and search are staff-only and return the expected shape', async () => {
  const owner = await mkUser({ name: 'Owner2', owner: true, staff: true });
  const mod = await mkUser({ name: 'Mod2', moderator: true });
  const { token: ownerToken } = await issueSession({ id: owner }, 'test', '');
  await post('/api/mod/manage', { userId: mod, role: 'moderator', grant: true, reason: 'audit trail' }, ownerToken);

  // A plain user cannot list roles.
  const plain = await mkUser({ name: 'Plain2' });
  const { token: plainToken } = await issueSession({ id: plain }, 'test', '');
  assert.equal((await get('/api/mod/roles', plainToken)).status, 403);

  const overview = await get('/api/mod/roles', ownerToken);
  assert.equal(overview.status, 200);
  const body = await overview.json();
  const ids = body.roles.map((r) => r.id);
  assert.ok(ids.includes(owner) && ids.includes(mod), 'role holders are listed');
  assert.ok(body.audit.length >= 1, 'audit trail is included');

  const search = await get(`/api/mod/search?q=Owner2`, ownerToken);
  assert.equal(search.status, 200);
  const found = (await search.json()).users;
  assert.ok(found.some((u) => u.id === owner), 'search finds the user by name');

  // No query → empty result, not an error.
  const empty = await get('/api/mod/search', ownerToken);
  assert.deepEqual((await empty.json()).users, []);
});

test('teardown', () => server?.close());
