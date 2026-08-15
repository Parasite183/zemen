# ዘመን Zemen — Launch Checklist

Everything an operator needs to take Zemen from local prototype to a real,
non-demo deployment. Work through it top to bottom; **section 1 (environment)
is enforced by the code** — in production the server refuses to boot with an
incomplete configuration and lists exactly what is missing.

---

## 1. Environment variables (mandatory in production)

The server validates these at startup (`config.js validateConfig()`). In
`NODE_ENV=production` any missing or wrong value → **no boot**, with a clear
list of what is missing. There are **no hardcoded fallbacks** for secrets.

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | yes | `production`. On the Cloudflare Worker this is set automatically. |
| `JWT_SECRET` | yes | ≥ 32 random chars. **Never** the dev default `zemen-dev-secret-change-me`. Generate: `openssl rand -hex 32`. |
| `SMS_PROVIDER` | yes | `africastalking` or `twilio`. `console` (dev stub) is refused in production. |
| `AFRICASTALKING_API_KEY` / `AFRICASTALKING_USERNAME` | for AT | Africa's Talking credentials (sandbox key while testing). |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` | for Twilio | If you choose Twilio instead. |
| `PAYMENT_PROVIDER` | yes | `chapa`. `stub` (dev) is refused in production. |
| `CHAPA_SECRET_KEY` | yes | Server-side key from the Chapa dashboard (Settings → API Keys). Never expose in the frontend. |
| `CHAPA_WEBHOOK_SECRET` | yes | The webhook secret hash you set in the Chapa dashboard; used to verify `chapa-signature` / `x-chapa-signature` headers. |
| `CHAPA_API_VERSION` | yes | `v1` or `v2` — **must match the platform that issued your secret key.** v1 (classic) keys start `CHASECK_...` / `CHASECK_TEST_...`, API at `api.chapa.co`; v2 (new) keys start `CHAPA_...`, API at `api.chapa.global`. A mismatch returns Chapa 401 `Invalid API key or User does not exist`. |
| `CHAPA_API_URL` | no | Defaults per version (`https://api.chapa.co` for v1, `https://api.chapa.global` for v2); override only if Chapa changes their host. |
| `CHAPA_PAYOUT_BANK_SLUG` | no | v1 payouts move money to a mobile-money provider listed in Chapa's bank list; default `telebirr`. |
| `DATABASE_URL` | for Postgres | Leave unset to use SQLite locally; on Cloudflare the D1 binding is used instead. |
| `DEFAULT_CURRENCY`, `FREE_DEAL_THRESHOLD_ETB`, `UNVERIFIED_LIFETIME_VOLUME_ETB`, `SMS_VOIP_BLOCK`, `JWT_TTL` | no | Have sensible defaults; tune deliberately. |

On Cloudflare, secrets are set with `wrangler secret put <NAME>` (they become
env vars to the Worker); non-secret vars live in `wrangler.jsonc` `vars`.

## 2. Provider accounts

- **Payments — Chapa (Ethiopia).** Create a merchant account at
  [chapa.co](https://chapa.co). Start in **Test mode**; switch to Live only
  after the sandbox flow passes. Configure the webhook URL to the
  **API Worker** (the most robust target — no Pages proxy in the path):
  `https://zemen-api.183georgedaniel.workers.dev/api/payments/webhook`,
  or the real Pages project domain `https://zemen-7xt.pages.dev/api/payments/webhook`.
  ⚠️ **Do NOT use `https://zemen.pages.dev/...`** — that domain is a
  *different* site (an unrelated project that does not proxy `/api/*`);
  webhook POSTs there get `405 Method Not Allowed` and never reach the
  Worker. Set a strong secret hash and mirror it in `CHAPA_WEBHOOK_SECRET`.
  Payment flow is **non-custodial**: Zemen never holds funds. `deposit()`
  creates a Chapa **hosted checkout**; the payer completes payment on
  Chapa's page; Chapa's webhook (HMAC-verified, then **re-verified
  server-side**) flips the deal's escrow to `funded`. `release()` /
  `refund()` initiate Chapa **payouts** to the winner's mobile-money
  wallet.
  **Two platforms, one provider:** `CHAPA_API_VERSION` must match the
  account that issued your key. v1 (classic, `CHASECK_TEST_...` keys) uses
  `POST /v1/transaction/initialize` (hosted checkout), verifies by
  **tx_ref** (`GET /v1/transaction/verify/{tx_ref}` — our deal ref), and
  pays out via `POST /v1/transfers` with the mobile-money provider's
  `bank_code` (resolved from `GET /v1/banks`). v2 (new, `CHAPA_...` keys)
  uses `POST /v2/payments/hosted`, `GET /v2/payments/{reference}/verify`,
  and `POST /v2/payouts/transfers`. Both platforms sign webhooks with
  HMAC-SHA256 (`chapa-signature` / `x-chapa-signature`) — verified, then
  always re-verified server-side before escrow flips to `funded`.
  > **Test mode note:** v1 test keys (`CHASECK_TEST_...`) make Chapa
  > **simulate** transfers (`status: success`) — payouts on test keys do
  > not move real money. Live keys omit the simulation flag.
  > **Verify before launch:** confirm your Chapa plan supports payouts to
  > Telebirr wallet numbers (`CHAPA_PAYOUT_BANK_SLUG`, default `telebirr`)
  > and that the v1 transfers payload matches your account's bank list.
- **SMS — Africa's Talking (or Twilio).** Create an AT account (sandbox → live
  production shortcode/long code). Set the sender in `AFRICASTALKING_FROM`.
  **Sandbox vs live hosts:** the provider routes automatically by username —
  `AFRICASTALKING_USERNAME=sandbox` (with the Sandbox app's API key) talks to
  `api.sandbox.africastalking.com`; any other username (live account) talks to
  `api.africastalking.com`. Mixing them up is a 401 `Invalid auth` — sandbox
  keys only authenticate against the sandbox host. Enable the
  **delivery-report webhook** in the AT dashboard if you want per-message
  delivery status; the code already parses the send response (non-101
  `statusCode` → loud `sms_delivery_failed` error + retries with backoff).
  Send failures are logged as `sms_delivery_failed` events.
- **Storage — Cloudflare R2.** The `zemen-uploads` bucket must stay
  **private** (default). Uploads are served only through the Worker's
  access-gated `/uploads` route (owner/staff for ID documents;
  parties/moderators for evidence).

## 3. Moderator & staff onboarding

There is **no public application flow** — becoming a moderator/staff is a
deliberate, human decision. Recommended process:

1. **Vet the person** — a real-world identity check (meeting, government ID
   shown to an existing staff member) plus a conflict-of-interest screen
   (no recent deals with platform users, no shared devices/IPs). The
   independence guards in the dispute engine will block conflicted votes
   automatically, but vetting first is cheaper than cleaning up after.
2. **Set the flag** via the in-app role management (recommended): on the
   Moderation page, any **staff** member can search a user and grant/revoke
   the **moderator** role; **staff** roles can only be granted/revoked by
   the **owner** (the top tier). Every change requires a written reason and
   is written to the `role_audit` table (who, whom, when, why) — the same
   accountability the ledger gives deals.
   - API: `POST /api/mod/manage` `{ userId, role: moderator|staff, grant, reason }`
     (staff for moderator changes, owner for staff changes).
   - View current holders + audit trail: `GET /api/mod/roles`.
   - Find a user to promote: `GET /api/mod/search?q=<name or phone>`.
   - The `is_owner` flag itself is never changed through the API — only by
     direct DB update by an operator (first owner is seeded on Lidya).
3. **Announce expectations** — moderators self-select from the queue; every
   vote and its reasoning is on the permanent ledger, and staff overrides
   require **two independent staff sign-offs** (three for heavy users), each
   with a written justification. All blocked attempts are recorded in
   `dispute_moderator_log` and streamed as `moderator_blocked` alerts.
4. **Start small** — one or two moderators for the first real disputes, then
   expand.

## 4. Data retention & deletion

**Retention policy (default):**
- **ID documents** (the sensitive PII): kept while the account is active and
  while any linked dispute/ledger record may need review. Automatically
  deleted on account deletion (see below). Recommend a scheduled purge of
  documents for accounts with `id_verification_status = 'rejected'` older
  than **90 days** — run manually or via a cron:
  `SELECT id FROM users WHERE id_verification_status = 'rejected' AND deleted_at IS NULL AND created_at < <90 days ago>` → delete their R2 objects / files.
- **Ledger, transactions, disputes**: **never deleted** — the hash-chained
  ledger's integrity *depends* on the data never being lost or altered.
- **OTP codes / sessions**: ephemeral; purged by expiry/revocation.

**User deletion path (implemented):** `POST /api/me/delete` (requires a
fresh action OTP) deletes the user's uploaded ID documents and **anonymises**
the account row (phone → `deleted:<id>`, name → "Deleted user", fingerprints,
IPs, ID hashes and privileges cleared, sessions revoked). Historical
ledger/transaction rows survive — with the PII linkage stripped — because
they are append-only evidence.

## 5. Encryption at rest

- **Cloudflare R2:** all objects are encrypted at rest by default (SSE with
  Cloudflare-managed keys) — no action needed; the bucket is private and
  served only through the gated Worker route. Documented here as the
  deployment's encryption-at-rest mechanism.
- **Local disk (dev only):** `server/uploads/` lives on the developer
  machine — rely on full-disk encryption (BitLocker/FileVault) for any
  machine holding real data. Production never serves uploads from disk.

## 6. Backups (the ledger must never be lost)

- **Cloudflare D1:** D1 has **automatic daily backups** (restorable from the
  dashboard / API). Additionally, schedule a **weekly export** to R2:
  ```bash
  wrangler d1 export zemen-db --remote --output=backups/zemen-$(date +%F).sql
  wrangler r2 object put zemen-backups/zemen-$(date +%F).sql --file=backups/...sql
  ```
  (a cron/Workers scheduled handler is the post-launch automation).
- **SQLite (local/dev):** copy `server/data/zemen.db` while the server is
  stopped (or use `sqlite3 .backup`). Keep a rolling 7-day set.
- **Verify restores** — a backup you have never restored is a wish. Do a
  quarterly restore drill into a scratch environment and run
  `GET /api/ledger/verify` (chain integrity) on the result.

## 7. Monitoring & alerting

Structured logs are JSON-per-line from `server/src/logger.js`. On
Cloudflare these appear in **Workers Logs**; stream them to an external sink
(Logpush → R2/S3 + a query tool) and alert on:

| Event | Level | Meaning |
|---|---|---|
| `auth_failed` | warn | wrong/expired OTP attempts (brute-force signal) |
| `auth_rate_limited` | warn | client hit a rate-limit window |
| `moderator_blocked` | warn | conflicted moderator/staff attempt (also in `dispute_moderator_log`) |
| `payment_provider_error` | error | Chapa API call failed |
| `payment_webhook_rejected` | warn/error | bad signature / unknown reference |
| `payment_not_confirmed` | warn | provider verify did not confirm a payment |
| `sms_delivery_failed` | error | SMS provider reported a non-delivery |

Also monitor: 429 rate by IP (abuse), `escrow_state` stuck in `pending`
(webhooks delayed — the `/api/deals/:id/escrow/check` poll is the fallback),
and the `staff`/`moderator` stats endpoints for overturn rates.

## 8. HTTPS / transport (confirmed)

- **End to end:** the Cloudflare edge terminates TLS for both the Pages
  site and the Worker (`https://zemen-api.…workers.dev`); Pages' Function
  proxies `/api` to the Worker over `https` (`functions/_middleware.js`),
  and Pages is served over `https` with automatic redirect from `http`.
- **Headers:** the API sets `Strict-Transport-Security`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and
  `X-Frame-Options: DENY` on every response.
- **Tokens:** JWTs travel only in the `Authorization: Bearer …` header over
  HTTPS; the dev OTP-peek endpoint is disabled in production.
- Recommended: enable **Always Use HTTPS** and the free WAF/edge rate-limit
  rules in the Cloudflare dashboard for extra abuse protection (the
  in-app rate limiter is per-isolate by design — see `rate-limit.js`).

## 9. Abuse protection (summary of what's in the code)

- OTP request/verify: rate-limited per IP **and** per phone number; codes
  burn after 5 wrong guesses (existing) and expire in 10 minutes.
- Deal and dispute creation: rate-limited per account and per IP (429 +
  `Retry-After`).
- Uploads: image/PDF allowlist, 10 MB max, **magic-byte** content checks
  (a PDF renamed `.png` is rejected), private access-gated serving.
- JSON API bodies capped at 256 KB.
- **Caveat:** the in-app limiter is in-memory (per Worker isolate) — a
  distributed attacker can exceed it. Enable Cloudflare edge rate limiting
  for `/api/auth/*` and `/api/deals` as the global layer. A D1-backed
  limiter is the documented follow-up if per-account limits must be global.

## 10. Regulatory note — operating real escrow (read this, it is on you)

Zemen's non-custodial payment flow uses a licensed payment processor
(Chapa) to collect and disburse funds — Zemen itself never holds money.
**Even so**, operating a service that facilitates payments or escrow-like
arrangements for others may require regulatory registration depending on
jurisdiction (payment services, money transmission, or e-money licensing in
Ethiopia: e.g. National Bank of Ethiopia requirements; elsewhere, consult
local law). **This checklist does not resolve that question** — it is a flag
for the operator to obtain qualified legal advice before accepting real
payments. The code's job is to be auditable; the operator's job is to be
licensed.

---

## Rollout order

1. Set all env vars / secrets (this page, §1).
2. Create Chapa + Africa's Talking accounts, run the sandbox flows (§2).
3. Promote the first moderators and document the vetting (§3).
4. Configure backups and a restore drill (§6).
5. Wire log streaming + alerts (§7).
6. Enable edge rate limiting + Always Use HTTPS (§8–9).
7. Legal sign-off (§10). Then flip to live keys and accept the first real
   deal.
