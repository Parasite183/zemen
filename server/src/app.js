import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { serverRoot, config, validateConfig } from './config.js';
import { initDb } from './db.js';
import { initSchema } from './schema.js';
import { logger } from './logger.js';
import { authMiddleware } from './auth.js';
import { requireUploadAccess } from './uploads.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import dealRoutes from './routes/deals.js';
import disputeRoutes from './routes/disputes.js';
import paymentRoutes from './routes/payments.js';
import reportRoutes from './routes/reports.js';

// Upload middleware (multer) lives in uploads.js: local disk by
// default, Cloudflare R2 on Workers.

export function buildApp() {
  const app = express();
  app.disable('x-powered-by');

  // Transport/headers hardening: the Cloudflare edge already terminates
  // TLS end-to-end (see LAUNCH_CHECKLIST.md §HTTPS); these headers make
  // that explicit and lock down how the frontend may use responses.
  app.use((_req, res, next) => {
    res.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
    res.set('x-content-type-options', 'nosniff');
    res.set('referrer-policy', 'no-referrer');
    res.set('x-frame-options', 'DENY');
    next();
  });

  // Basic request-size limit: JSON API bodies are tiny (deal/dispute
  // creation, statements). Uploads go through multer with their own
  // larger limit (uploads.js).
  //
  // The payment webhook must arrive as the RAW body (HMAC signature is
  // computed over the exact bytes sent), so it is parsed before the
  // global JSON parser. body-parser marks the body as read, so the
  // JSON parser skips it afterwards.
  app.use('/api/payments/webhook', express.raw({ type: '*/*', limit: '1mb' }));
  app.use(express.json({ limit: '256kb' }));

  // Cloudflare Workers only: workerd forbids async I/O (like D1
  // queries) in module global scope, so the DB + schema must be
  // initialised lazily inside a request handler. Plain Node inits at
  // startup (server/src/index.js) and skips this middleware.
  if (config.worker) {
    let dbInitPromise = null;
    const ensureDb = () => {
      dbInitPromise ??= (async () => {
        // Production config validation (workers always run as
        // production): refuse to serve with a half-configured env.
        // The 500 below is the loud, visible failure mode — no silent
        // fallbacks, no stub providers.
        const problems = validateConfig();
        if (problems.length) {
          const err = new Error('Worker refused to start: production configuration is incomplete: ' + problems.map((p) => p.name).join(', '));
          err.status = 500;
          err.configProblems = problems;
          logger.error('config_invalid', { problems });
          throw err;
        }
        await initDb();
        await initSchema();
      })().catch((err) => {
        dbInitPromise = null; // allow a retry on the next request
        throw err;
      });
      return dbInitPromise;
    };
    app.use(async (req, res, next) => {
      try {
        await ensureDb();
        next();
      } catch (err) {
        if (err.configProblems) {
          return res.status(500).json({
            error: 'Server misconfigured — refusing to serve. Missing/invalid: ' + err.configProblems.map((p) => p.name).join(', '),
            code: 'config_invalid',
          });
        }
        next(err);
      }
    });
  }

  // Local dev only: serve uploaded files from disk. Same access gate
  // as the Worker path — uploads are never publicly web-servable.
  if (!config.worker) {
    app.use('/uploads', authMiddleware, requireUploadAccess(), express.static(path.join(serverRoot, 'uploads'), { maxAge: '7d' }));
  }

  // Cloudflare Workers: uploads live in R2. The object key is the path
  // after /uploads/ (e.g. /uploads/ids/x.jpg → key ids/x.jpg).
  // Access-gated: uploads are private (owner/staff for ID docs, parties/
  // moderators for evidence) — never publicly web-servable.
  if (config.worker) {
    app.use('/uploads', authMiddleware, requireUploadAccess(), async (req, res, next) => {
      const bucket = (globalThis.__ZEMEN_BINDINGS || {}).UPLOADS;
      if (!bucket) return next();
      try {
        const key = decodeURIComponent(req.path.replace(/^\/+/, ''));
        const obj = await bucket.get(key);
        if (!obj) return res.status(404).json({ error: 'Not found', code: 'not_found' });
        res.set('content-type', obj.httpMetadata?.contentType || 'application/octet-stream');
        res.set('cache-control', 'public, max-age=604800');
        if (obj.httpEtag) res.set('etag', obj.httpEtag);
        res.send(Buffer.from(await obj.arrayBuffer()));
      } catch (err) {
        next(err);
      }
    });
  }

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'zemen-api' }));
  app.use('/api/auth', authRoutes);
  // Public (token-addressable) routes must be mounted before the authed
  // /api routers so they are not shadowed by their auth middleware.
  // Provider webhooks are public (HMAC-authenticated) and must be
  // mounted BEFORE the authed /api routers so they are not shadowed by
  // their auth middleware.
  app.use('/api/payments', paymentRoutes); // provider webhooks
  app.use('/api', reportRoutes);    // /public/report/:token, /ledger/verify
  app.use('/api', userRoutes);      // /me, /users/:id, /directory
  app.use('/api/deals', dealRoutes);
  app.use('/api/disputes', disputeRoutes);

  // Serve the built frontend in production on plain Node (not on
  // Workers — Cloudflare Pages handles the static site there).
  if (config.nodeEnv === 'production' && !config.worker) {
    const dist = path.join(serverRoot, '..', 'web', 'dist');
    app.use(express.static(dist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message, code: 'upload_error' });
    console.error('[zemen] unhandled error:', err);
    res.status(500).json({ error: 'Internal server error', code: 'internal' });
  });

  return app;
}
