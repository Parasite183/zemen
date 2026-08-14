import { Router } from 'express';
import { db } from '../db.js';
import { wrap, ok, badRequest, forbidden, notFound } from '../http.js';
import { authMiddleware, requireStaff } from '../auth.js';
import { nowIso } from '../crypto.js';
import { uploadId } from '../uploads.js';
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

// ── ID document upload (manual review — not automated KYC at MVP) ───
router.post('/me/id-document', uploadId, wrap(async (req, res) => {
  if (!req.file) throw badRequest('Attach an ID document (photo/scan)', 'file_required');
  const status = req.user.id_verification_status === 'rejected' ? 'pending' : 'pending';
  await db.run('UPDATE users SET id_doc_path = ?, id_verification_status = ? WHERE id = ?',
    [req.file.path.replaceAll('\\', '/'), status, req.user.id]);
  ok(res, { user: await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]) });
}));

// Staff-only: flip verification status after manual review.
router.post('/me/verification', requireStaff, wrap(async (req, res) => {
  const { userId, status } = req.body;
  if (!userId || !['none', 'pending', 'verified', 'rejected'].includes(status)) {
    throw badRequest('userId and a valid status are required');
  }
  await db.run('UPDATE users SET id_verification_status = ? WHERE id = ?', [status, userId]);
  ok(res, { user: await db.get('SELECT * FROM users WHERE id = ?', [userId]) });
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
