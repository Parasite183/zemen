import { Router } from 'express';
import { db } from '../db.js';
import { wrap, ok, badRequest, forbidden, notFound } from '../http.js';
import { authMiddleware, requireStaff, requireModerator, verifyActionOtp, revokeAllSessions, isModerator } from '../auth.js';
import { nowIso, sha256, normalizePhone, genRef } from '../crypto.js';
import { uploadId, readUploadedBytes, assertUploadContent, deleteUploadedFile } from '../uploads.js';
import { logger } from '../logger.js';
import { normalizeIdNumber, registerIdDocument } from '../services/identity.js';
import { runFraudChecks, fraudClustersForReview } from '../services/anti-fraud.js';
import { computeReputation, getReputation } from '../services/reputation.js';

const router = Router();
router.use(authMiddleware);

function maskPhone(phone) {
  const s = String(phone || '');
  return s.length > 7 ? s.slice(0, 5) + ' ••• ••• ' + s.slice(-3) : s;
}

// ── own profile ─────────────────────────────────────────────────────
router.patch('/me', wrap(async (req, res) => {
  const name = (req.body?.name || '').trim();
  const category = (req.body?.category || '').trim();
  const bio = (req.body?.bio || '').trim();
  if (!name) throw badRequest('Your name is required', 'name_required');

  await db.run('UPDATE users SET name = ?, category = ?, bio = ? WHERE id = ?',
    [name, category, bio, req.user.id]);
  ok(res, { user: await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]) });
}));

// ── ID document upload (manual review, with duplicate detection) ─────
// Deduplication compares three signals against every other account:
//   1. the ID number the user enters (hashed — OCR is fine at MVP,
//      flagged for manual review either way)
//   2. a perceptual hash of the document image, computed client-side on
//      a canvas and sent with the upload
//   3. the exact SHA-256 of the uploaded file bytes (server-side, always)
// Matches are auto-flagged as 'rejected' with a reason for staff review
// — never silently accepted.
router.post('/me/id-document', uploadId, wrap(async (req, res) => {
  if (!req.file) throw badRequest('Attach an ID document (photo/scan)', 'file_required');
  // Magic-byte check: the file's real content must match its claimed
  // type, and only image/PDF are allowed (uploads.js assertUploadContent).
  await assertUploadContent(req.file, { badRequest });
  const docType = ['national_id', 'business_license'].includes(req.body?.docType) ? req.body.docType : 'national_id';
  const idNumber = String(req.body?.idNumber || '');
  const phash = String(req.body?.phash || '');
  const fileSha256 = sha256(await readUploadedBytes(req.file));
  const idNumHash = normalizeIdNumber(idNumber) ? sha256(normalizeIdNumber(idNumber)) : '';
  const filePath = req.file.path.replaceAll('\\', '/');

  const { duplicate } = await registerIdDocument({ userId: req.user.id, docType, idNumber, phash, fileSha256, filePath });
  const status = duplicate.code ? 'rejected' : 'pending';
  await db.run(
    `UPDATE users SET id_doc_path = ?, id_verification_status = ?, id_number_hash = ?, id_phash = ?, id_flag_reason = ? WHERE id = ?`,
    [filePath, status, idNumHash, phash, duplicate.label, req.user.id]
  );
  const user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  ok(res, { user, duplicate });
}));

// Staff-only: flip verification status after manual review. Sets
// verified_at so the unverified-lifetime-volume cap stops counting
// deals made before verification. The matching document row is updated
// too so the moderator review queue reflects the decision.
router.post('/me/verification', requireStaff, wrap(async (req, res) => {
  const { userId, status } = req.body;
  if (!userId || !['none', 'pending', 'verified', 'rejected'].includes(status)) {
    throw badRequest('userId and a valid status are required');
  }
  const verifiedAt = status === 'verified' ? nowIso() : null;
  await db.run('UPDATE users SET id_verification_status = ?, verified_at = ? WHERE id = ?', [status, verifiedAt, userId]);
  await db.run(
    `UPDATE id_documents SET status = ? WHERE user_id = ? AND status IN ('pending', 'rejected')`,
    [status === 'verified' ? 'approved' : status, userId]
  );
  ok(res, { user: await db.get('SELECT * FROM users WHERE id = ?', [userId]) });
}));

// Change the phone number tied to the account. Requires an action OTP
// sent to the CURRENT phone (re-auth before a sensitive change).
router.post('/me/phone', wrap(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) throw badRequest('Enter a valid phone number', 'phone_invalid');
  const okOtp = await verifyActionOtp(req.user, req.body?.otp);
  if (!okOtp) throw badRequest('Enter the code we sent to your current phone', 'otp_required');
  const clash = await db.get('SELECT id FROM users WHERE phone = ? AND id <> ?', [phone, req.user.id]);
  if (clash) throw badRequest('That phone number is already registered', 'phone_taken');
  await db.run('UPDATE users SET phone = ? WHERE id = ?', [phone, req.user.id]);
  ok(res, { user: await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]) });
}));

// ── account deletion (data protection: right to erasure) ─────────────
// Deletes the user's ID documents (the sensitive PII) and anonymises
// the account row. Ledger/transaction/dispute rows are immutable by
// design (the ledger's integrity depends on it) and are NOT deleted —
// they keep referencing the anonymised row, which strips the PII
// linkage. See LAUNCH_CHECKLIST.md §Data retention & deletion.
router.post('/me/delete', wrap(async (req, res) => {
  const okOtp = await verifyActionOtp(req.user, req.body?.otp);
  if (!okOtp) throw badRequest('Enter the code we sent to your phone to delete your account', 'otp_required');

  // 1. Delete uploaded ID documents (the sensitive personal data).
  const docs = await db.all('SELECT file_path FROM id_documents WHERE user_id = ?', [req.user.id]);
  for (const d of docs) await deleteUploadedFile(d.file_path).catch(() => {});
  await db.run('DELETE FROM id_documents WHERE user_id = ?', [req.user.id]);

  // 2. Anonymise the account row; drop any privileges it carried.
  await db.run(
    `UPDATE users SET
       phone = ?, name = 'Deleted user', category = '', bio = '',
       id_verification_status = 'none', id_doc_path = '',
       device_fingerprint = '', signup_ip = '', last_ip = '',
       id_number_hash = '', id_phash = '', id_flag_reason = '',
       verified_at = NULL, is_moderator = 0, is_staff = 0,
       report_token = ?, deleted_at = ?
     WHERE id = ?`,
    [`deleted:${req.user.id}`, genRef('RP'), nowIso(), req.user.id]
  );

  // 3. Revoke every session and purge OTP records for the number.
  await revokeAllSessions(req.user.id);
  await db.run('DELETE FROM otp_codes WHERE phone = ?', [req.user.phone]);

  logger.info('account_deleted', { userId: req.user.id });
  ok(res, { deleted: true });
}));

// ── role management (who becomes a moderator / staff / owner) ────────
// Moderator flags are granted by staff; staff flags are granted ONLY by
// an owner (the top tier — there is no higher role). Every change is
// written to role_audit: who did it, to whom, when, and why, so role
// changes are as accountable as ledger entries.

/** User rows carrying any role flag, plus recent role-change history. */
async function roleOverview() {
  const [roles, audit] = await Promise.all([
    db.all(
      `SELECT id, name, phone, is_moderator, is_staff, is_owner, id_verification_status, created_at
       FROM users WHERE is_moderator = 1 OR is_staff = 1 OR is_owner = 1
       ORDER BY is_owner DESC, is_staff DESC, is_moderator DESC, id ASC`
    ),
    db.all(
      `SELECT a.*, u.name AS actor_name, t.name AS target_name
       FROM role_audit a
       JOIN users u ON u.id = a.actor_id
       JOIN users t ON t.id = a.target_id
       ORDER BY a.id DESC LIMIT 50`
    ),
  ]);
  return { roles, audit };
}

// List everyone holding a role + recent changes. Staff and owners see
// this; moderators do not (they are not allowed to hand out roles).
router.get('/mod/roles', requireStaff, wrap(async (req, res) => {
  ok(res, await roleOverview());
}));

// Search users by name or phone, so a staff member can find someone to
// promote. Returns a few lightweight fields only — full profiles stay
// behind /users/:id.
router.get('/mod/search', requireStaff, wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return ok(res, { users: [] });
  const like = `%${q.toLowerCase()}%`;
  const users = await db.all(
    `SELECT id, name, phone, is_moderator, is_staff, is_owner, id_verification_status, created_at
     FROM users WHERE LOWER(name) LIKE ? OR phone LIKE ?
     ORDER BY (is_owner + is_staff + is_moderator) DESC, id ASC LIMIT 20`,
    [like, like]
  );
  ok(res, { users });
}));

// Grant or revoke a role. `role` is moderator | staff; `grant` true
// grants, false revokes; `reason` is recorded in the audit trail.
// Moderator changes: any staff. Staff changes: owner only. Nobody can
// change their own role, and the owner flag is never touched here.
router.post('/mod/manage', requireStaff, wrap(async (req, res) => {
  const { userId, role, grant, reason } = req.body || {};
  const targetId = Number(userId);
  if (!targetId || !['moderator', 'staff'].includes(role)) {
    throw badRequest('userId and role (moderator|staff) are required', 'bad_role_request');
  }
  if (targetId === req.user.id) throw forbidden('You cannot change your own role', 'self_role_change');
  if (role === 'staff' && !req.user.is_owner) {
    throw forbidden('Only the owner can grant or revoke staff', 'owner_only');
  }

  const target = await db.get('SELECT id, is_moderator, is_staff, is_owner FROM users WHERE id = ?', [targetId]);
  if (!target) throw notFound('User not found');

  const col = role === 'moderator' ? 'is_moderator' : 'is_staff';
  const currently = target[col] === 1;
  if (currently === !!grant) {
    // No-op (already has / already lacks the role) — nothing to record.
    return ok(res, await roleOverview());
  }

  await db.run(`UPDATE users SET ${col} = ? WHERE id = ?`, [grant ? 1 : 0, targetId]);
  await db.run(
    `INSERT INTO role_audit (actor_id, target_id, action, reason, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [req.user.id, targetId, `${grant ? 'grant' : 'revoke'}_${role}`, String(reason || '').trim().slice(0, 500), nowIso()]
  );
  logger.info('role_changed', { actor: req.user.id, target: targetId, role, grant: !!grant });
  ok(res, await roleOverview());
}));

// Moderators: re-run the graph/velocity/cluster fraud checks on demand.
router.post('/mod/fraud/refresh', requireModerator, wrap(async (req, res) => {
  ok(res, await runFraudChecks());
}));

// Moderators: the whole review screen in one call — identity documents
// awaiting manual review (staff flips status via /me/verification),
// structured fraud clusters with member accounts, and every account
// carrying any flag. One row per user needing review, with their latest
// document attached (some users are flagged pending before a document
// exists, e.g. a placeholder profile).
router.get('/mod/review', requireModerator, wrap(async (req, res) => {
  const documents = await db.all(
    `SELECT u.id AS user_id, u.name, u.phone, u.id_verification_status, u.id_flag_reason,
            d.id AS doc_id, d.doc_type, d.status AS doc_status, d.reason AS doc_reason,
            d.file_path AS doc_path, d.created_at AS doc_created_at
     FROM users u
     LEFT JOIN id_documents d ON d.id = (
       SELECT id FROM id_documents WHERE user_id = u.id ORDER BY id DESC LIMIT 1
     )
     WHERE u.id_verification_status IN ('pending', 'rejected')
     ORDER BY (u.id_verification_status = 'pending') DESC, u.id ASC
     LIMIT 100`
  );
  const flaggedRows = await db.all(
    `SELECT r.user_id, r.flags_json, u.name, u.category, u.id_verification_status
     FROM reputation_scores r JOIN users u ON u.id = r.user_id
     WHERE r.flags_json IS NOT NULL AND r.flags_json <> '' AND r.flags_json <> '[]'
     ORDER BY u.id ASC`
  );
  const flaggedAccounts = [];
  for (const r of flaggedRows) {
    let flags = [];
    try { flags = JSON.parse(r.flags_json); } catch { flags = []; }
    if (flags.length) {
      flaggedAccounts.push({
        user: { id: r.user_id, name: r.name, category: r.category, id_verification_status: r.id_verification_status },
        flags,
      });
    }
  }
  ok(res, {
    documents: documents.map((d) => ({ ...d, phone: maskPhone(d.phone) })),
    clusters: await fraudClustersForReview(),
    flaggedAccounts,
  });
}));

router.get('/me/report-token', wrap(async (req, res) => {
  ok(res, { reportToken: req.user.report_token });
}));

// ── public profile ──────────────────────────────────────────────────
router.get('/users/:id', wrap(async (req, res) => {
  const u = await db.get('SELECT * FROM users WHERE id = ?', [Number(req.params.id)]);
  if (!u) throw notFound('User not found');
  const reputation = await getReputation(u.id);
  const isSelf = u.id === req.user.id;
  const isMod = isModerator(req.user);
  ok(res, {
    user: {
      id: u.id,
      name: u.name || 'Unnamed user',
      category: u.category,
      bio: u.bio,
      phone: isSelf ? u.phone : maskPhone(u.phone),
      id_verification_status: u.id_verification_status,
      created_at: u.created_at,
      is_moderator: u.is_moderator,
    },
    reputation,
    // flags are internal — only moderators see them
    flags: isMod && reputation ? JSON.parse(reputation.flags_json || '[]') : [],
  });
}));

// ── directory ───────────────────────────────────────────────────────
router.get('/directory', wrap(async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  const category = (req.query.category || '').trim();

  let rows = await db.all(
    `SELECT u.id, u.name, u.category, u.bio, u.id_verification_status, u.created_at,
            COALESCE(r.completion_rate, 0) AS completion_rate,
            COALESCE(r.dispute_rate, 0) AS dispute_rate,
            COALESCE(r.total_volume, 0) AS total_volume,
            COALESCE(r.total_completed, 0) AS total_completed
     FROM users u
     LEFT JOIN reputation_scores r ON r.user_id = u.id
     WHERE u.name <> '' AND u.id <> ?
     ORDER BY (u.id_verification_status = 'verified') DESC, r.total_completed DESC, u.id ASC
     LIMIT 200`,
    [req.user.id]
  );

  if (q) rows = rows.filter((r) => (r.name || '').toLowerCase().includes(q) || (r.category || '').toLowerCase().includes(q));
  if (category) rows = rows.filter((r) => r.category === category);

  const categories = await db.all("SELECT category, COUNT(*) AS n FROM users WHERE name <> '' AND category <> '' GROUP BY category ORDER BY n DESC");
  ok(res, { results: rows, categories: categories.map((c) => c.category) });
}));

export default router;
