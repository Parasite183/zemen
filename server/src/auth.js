import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { db } from './db.js';
import { unauthorized, forbidden } from './http.js';

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, phone: user.phone },
    config.jwtSecret,
    { expiresIn: '30d' }
  );
}

/** Attach `req.user` (fresh from the DB) when a valid token is present. */
export async function authMiddleware(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(unauthorized());
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const user = await db.get('SELECT * FROM users WHERE id = ?', [payload.sub]);
    if (!user) return next(unauthorized('Account no longer exists'));
    req.user = user;
    req.token = payload;
    next();
  } catch {
    next(unauthorized('Session expired, sign in again'));
  }
}

export const requireModerator = (req, _res, next) => {
  if (!req.user?.is_moderator) return next(forbidden('Moderator role required'));
  next();
};

export const requireStaff = (req, _res, next) => {
  if (!req.user?.is_staff) return next(forbidden('Staff role required'));
  next();
};
