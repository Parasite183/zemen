import { Router } from 'express';
import { db } from '../db.js';
import { wrap, ok, badRequest, forbidden, notFound } from '../http.js';
import { authMiddleware, requireStaff, requireModerator, verifyActionOtp } from '../auth.js';
import { nowIso, sha256, normalizePhone } from '../crypto.js';
import { uploadId, readUploadedBytes } from '../uploads.js';
import { normalizeIdNumber, registerIdDocument } from '../services/identity.js';
import { runFraudChecks } from '../services/anti-fraud.js';
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
// deals made before verification.
router.post('/me/verification', requireStaff, wrap(async (req, res) => {
  const { userId, status } = req.body;
  if (!userId || !['none', 'pending', 'verified', 'rejected'].includes(status)) {
    throw badRequest('userId and a valid status are required');
  }
  const verifiedAt = status === 'verified' ? nowIso() : null;
  await db.run('UPDATE users SET id_verification_status = ?, verified_at = ? WHERE id = ?', [status, verifiedAt, userId]);
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

// Moderators: re-run the graph/velocity/cluster fraud checks on demand.
router.post('/mod/fraud/refresh', requireModerator, wrap(async (req, res) => {
  ok(res, await runFraudChecks());
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
  const isMod = req.user.is_moderator;
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
