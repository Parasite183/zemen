# ዘመን Zemen — a portable trust & transaction-verification platform

**Zemen (Amharic for "era")** is a working full-stack prototype of a digital trust layer for people and small
businesses operating in economies with weak formal credit, contract-enforcement, and registry infrastructure —
starting with Ethiopia.

Where a lender, client, or stranger elsewhere relies on credit bureaus, courts, and property registries to
decide who to trust, Zemen substitutes a **portable, verifiable trust record**: verified identity, a tamper-evident
transaction history, an optional escrow flow, structured dispute resolution, and a shareable trust report.

> ⚠️ This is an MVP prototype for local development and demoing. It is **not** a legal registry, does not perform
> automated KYC, and cannot fully prevent sybil attacks (see [Known limitations](#known-limitations)). SMS delivery
> is real when provider credentials are set, otherwise stubbed (see [Swapping the stubs](#swapping-the-stubs)).

---

## Core features

1. **Verified identity layer** — phone-number OTP sign-in; optional national-ID / business-license upload with
   manual review; public profile with verified badge, join date, completion count, and dispute rate.
2. **Transaction logging & lightweight escrow** — two users create a *deal* (description, amount, currency,
   deadline, deliverable); both parties digitally accept the terms, which are **hashed and stored on a
   tamper-evident, append-only hash-chained ledger**; status flow `Awaiting → Agreed → In progress → Delivered →
   Completed` (or `Disputed → resolved`). Optional escrow holds funds through a swappable mobile-money provider
   interface and releases only on mutual confirmation.
3. **Reputation / credit-history engine** — completion rate, on-time rate, dispute rate, total volume, with
   **recent activity weighted more heavily** (6-month half-life). A **shareable trust report** (printable PDF /
   link) is the artifact a user can hand to a bank, new client, or lender. One-sided collusion-like patterns are
   flagged for moderator review.
4. **Dispute resolution** — structured flow: raise dispute → both parties file statements + evidence (photos/PDF) →
   moderators vote → outcome applied (deal confirmed & funds released, or failed & refunded) and logged permanently
   against both records. Moderators are **chosen manually, ad hoc** — staff flag accounts as moderators (`is_moderator`
   in the DB, see the demo account below) — there is no public application or election process yet (see
   [Known limitations](#known-limitations)). Once moderating, the flow is hardened so no single conflicted vote can
   decide a case: every voter must be **independent** (never transacted with either party, not in the same device/IP
   cluster), **high-value disputes (> 2,000 ETB) require a 3-moderator quorum** and resolve by majority while small
   ones resolve on a single vote, every vote and its reasoning is stored for audit, and the **losing party gets one
   appeal** judged by a fresh panel that excludes the original voters.
5. **Discovery / directory** — searchable directory of verified users and businesses by category, so a good trust
   record actually helps find new counterparties.

**Localization** — every UI string runs through an i18n dictionary; **English and Amharic (አማርኛ)** are included
(the Amharic set is a starter translation — extend `web/src/i18n/am.js`).

---

## What's implemented vs. stubbed

This is a working prototype, not a production service. Here is exactly what is real
and what is mocked:

| Area | Status | Details |
|---|---|---|
| OTP phone login | ✅ Implemented | Real 6-digit codes, 10-min TTL, single-use, 5-attempt brute-force cap. **Delivery** is real via Twilio / Africa's Talking when credentials are set (with line-type / VOIP rejection where the provider supports it); falls back to the console stub without credentials. |
| Sessions | ✅ Implemented | `sessions` table backed by jti (revocable), **7-day tokens with silent refresh**, *Sign out of all devices* endpoint. OTP re-auth required for high-stakes actions (fund escrow, confirm a large deal, change phone). |
| Verification tier & unverified caps | ✅ Implemented | Deals above ~500 ETB require verification; unverified accounts are capped at 3 deals / 5,000 ETB lifetime. |
| ID document dedup | ✅ Implemented | Client-computed perceptual hash (pHash) + extracted ID number stored per document; duplicate ID number or near-duplicate image is rejected/flagged. |
| Device / IP fingerprinting | ✅ Implemented | Coarse device fingerprint + IP range logged at signup; clusters of new accounts sharing a device or narrow IP range are flagged for moderator review before they can transact with each other. |
| Anti-gaming detection | ✅ Implemented | One-sided-concentration flags (existing) plus **clique detection** (connected-components + internal-edge density over the transaction graph), **velocity checks** (e.g. 10 confirmed deals in < 48h), and device-cluster flags — each surfaced to moderators with the specific signal that tripped it. |
| Deal lifecycle | ✅ Implemented | create → accept terms (hashed) → fund escrow → start → deliver → confirm; guarded `UPDATE … WHERE status = expected` transitions. |
| Tamper-evident ledger | ✅ Implemented | Append-only hash chain with per-entry content + link hashes, verifiable via `GET /api/ledger/verify`. Lives in the app database — **not** yet anchored to an external chain. |
| Reputation engine | ✅ Implemented | Completion / on-time / dispute rates, total volume, 6-month half-life weighting, one-sided-collusion flags. |
| Disputes + moderator votes | ✅ Implemented | Statements, evidence upload, votes, staff resolve, outcome applied to the deal + escrow. Hardened: conflict-of-interest guard (prior dealings / device-IP cluster), 3-vote quorum above 2,000 ETB, one appeal per dispute on a fresh panel, per-moderator track record, blocked attempts logged. |
| Directory & public profiles | ✅ Implemented | Searchable, phone masked on public pages, shareable trust report at `/r/<token>`. |
| i18n (EN + AM) | ✅ Implemented | Amharic is a starter translation — extend `web/src/i18n/am.js`. |
| SMS / OTP delivery | 🟢 **Real (gated)** | `server/src/providers/sms.js` sends via Africa's Talking or Twilio; per-recipient delivery status is parsed (non-delivery → loud error), transient failures retry with backoff, and `SMS_PROVIDER=console` (dev stub) is **refused at boot in production**. |
| Mobile-money escrow | 🟢 **Real (non-custodial)** | `server/src/providers/payments.js` integrates **Chapa hosted checkout + HMAC webhooks** — Zemen never holds funds, it records provider-confirmed state (escrow `pending → funded` on webhook, then releases/refunds via Chapa payouts). Stub provider exists for dev/tests and is **refused at boot in production**. |
| Secrets & env validation | ✅ Implemented | Production refuses to boot with a missing/invalid `JWT_SECRET`, stub providers, or missing provider keys — `config.js validateConfig()` lists exactly what's missing. |
| Abuse protection | ✅ Implemented | Rate limits on OTP request/verify (per IP + per phone) and deal/dispute creation (per account + per IP); 429 + `Retry-After`; JSON bodies capped at 256 KB. |
| Upload security | ✅ Implemented | Image/PDF allowlist, 10 MB cap, magic-byte content checks, access-gated serving (owner/staff/parties only). |
| Account deletion | ✅ Implemented | `POST /api/me/delete` (action-OTP) deletes ID documents + anonymises the account; ledger stays immutable. |
| Structured logging | ✅ Implemented | JSON-per-line logger; auth failures, blocked moderator attempts, payment/SMS provider errors stream as alertable events. |
| ID verification / KYC | 🟡 **Partial** | Documents uploaded with ID number + doc type, deduped by pHash / ID number, stored for **manual staff review**; no automated KYC. |
| Ledger anchoring | 🟡 **Partial** | Chain lives in Postgres/SQLite/D1; swap the backing store in `server/src/ledger.js` to anchor externally. |
| Email / notifications | ❌ Not implemented | Only SMS delivery (real or console stub) exists. |

> **Note on the deal lifecycle, ledger, and reputation math:** these were reviewed and deliberately **left
> unchanged** by the identity-hardening work — the changes above (verification gates, dedup, fingerprinting,
> anti-gaming flags, sessions) layer *around* them without altering their semantics. The same holds for the
> dispute-hardening work: conflict-of-interest guards, quorum voting, and the appeal path touch only the disputes
> module (plus its own tables and routes); the deal lifecycle, ledger, reputation engine, and anti-fraud checks
> are untouched.

---

## Quick start (local, zero extra setup)

Requires **Node.js ≥ 22** (tested on v24). No Docker or PostgreSQL needed for local dev — SQLite is used
automatically.

```bash
cd zemen
npm install          # installs server + web workspaces
npm run seed         # demo data (users, deals, dispute history, flags)
npm run dev          # API on :3001 + web app on :5173
```

Then open **http://localhost:5173**.

> The API console prints OTPs as they're "sent" (stub SMS). On the login screen you can also tap
> **"Dev: autofill code"** to fill the code automatically (dev mode only).

### Demo accounts

| Name | Phone | Notes |
|---|---|---|
| Abebe Kebede | `+251911000001` | Freelance, verified |
| Sara Tesfaye | `+251911000002` | Trade, verified |
| Bekele Alemu | `+251911000003` | Agriculture, verification pending |
| Lidya Hailu | `+251911000004` | Moderator & staff (dispute queue) |
| Tesfaye Girma | `+251911000005` | One-sided pattern flag example |
| Girma Haile | `+251911000006` | One-sided pattern flag example |
| Hana Worku | `+251911000007` | Agriculture, verified |

### Suggested click-through

1. **Sara** logs in → dashboard shows her trust stats.
2. **Sara** creates a deal with **Abebe** (phone `+251911000001`), escrow ON.
3. **Abebe** logs in → accepts terms → **Sara** funds the escrow → **Abebe** starts & delivers → **Sara** confirms →
   escrow released. (This exact flow is automated by `node server/scripts/ui-smoke.js`.)
4. **Sara** → Profile → *Copy link* → open the **trust report** (also reachable at `/r/<token>` without login);
   use *Print / save as PDF*.
5. **Directory** → search / filter by category → start a deal from a public profile.
6. **Lidya** (moderator) → *Moderator* page: open dispute queue and flagged patterns. Raise a dispute on any
   in-flight deal (Deal page → *Raise dispute*), file statements, then resolve as staff.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Runs API (`:3001`) + web dev server (`:5173`, proxies `/api`) |
| `npm run seed` | Seeds demo data (safe to re-run; skips if already seeded) |
| `npm test` | Server unit tests (ledger integrity, reputation math, canonical hashing) |
| `npm run build && npm run start` | Production: build web, serve everything from the API (`:3001`) |
| `npm run docker:up` | Full stack with PostgreSQL via Docker (see below) |
| `node server/scripts/smoke-api.js` | 21-step API end-to-end test (server must be running) |
| `node server/scripts/ui-smoke.js` | Real-browser click-through of the whole flow (Chrome, mobile viewport) |

---

## Environment variables (copy `.env.example` → `.env`)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | API port |
| `DATABASE_URL` | *(empty → SQLite)* | `postgres://user:pass@host:5432/db` switches to PostgreSQL |
| `DB_FILE` | `./data/zemen.db` | SQLite file (only used when `DATABASE_URL` is empty) |
| `JWT_SECRET` | dev default | **Change in production.** Signs session tokens |
| `DEV_MODE` | `true` | Enables the dev OTP-peek endpoint & autofill helper. **Auto-disabled in `NODE_ENV=production`** |
| `DEFAULT_CURRENCY` | `ETB` | Default deal currency |
| `SMS_PROVIDER` | `console` | `twilio` or `africastalking` switches to a real gateway; `console` is **refused in production** |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` | *(empty)* | Twilio credentials (also enables Lookup line-type check when `TWILIO_LOOKUP_SID` is set) |
| `AFRICASTALKING_USERNAME` / `AFRICASTALKING_API_KEY` / `AFRICASTALKING_FROM` | *(empty)* | Africa's Talking credentials |
| `PAYMENT_PROVIDER` | `stub` | `chapa` switches to the real hosted-checkout provider; `stub` is **refused in production** |
| `CHAPA_SECRET_KEY` / `CHAPA_WEBHOOK_SECRET` / `CHAPA_API_URL` | *(empty)* | Chapa server key + webhook secret hash (required with `PAYMENT_PROVIDER=chapa`) |

> 🚀 **Going live?** See **[LAUNCH_CHECKLIST.md](LAUNCH_CHECKLIST.md)** — env vars, provider accounts,
> moderator/staff vetting, retention & deletion, backups, monitoring, HTTPS, and the escrow regulatory note.

## Storage: SQLite ↔ PostgreSQL

The data layer (`server/src/db.js`) is written against the common SQL dialect of both engines — ISO-8601 TEXT
timestamps, JSON-as-TEXT, INTEGER booleans, `?` placeholders. **Switching databases is one environment variable.**

```bash
# Zero-setup local dev (default)
npm run dev

# PostgreSQL (e.g. via docker compose)
docker compose up --build        # starts postgres + app on :3001
# or point the API at any existing Postgres:
DATABASE_URL=postgres://user:pass@host:5432/zemen npm run dev
```

## Architecture

```
zemen/
├─ package.json            # npm workspaces (server + web), dev scripts
├─ docker-compose.yml      # postgres + app (production-style)
├─ Dockerfile              # multi-stage: builds web, runs API
├─ server/                 # Node.js + Express (ESM)
│  ├─ src/
│  │  ├─ index.js          # entry: init db/schema, listen
│  │  ├─ app.js            # express app, uploads, static SPA serving
│  │  ├─ db.js             # dual-driver (SQLite/Postgres) async data layer
│  │  ├─ schema.js         # portable DDL + migrations
│  │  ├─ crypto.js         # sha256, canonical JSON, refs, OTP
│  │  ├─ ledger.js         # append-only hash-chained ledger + verify
│  │  ├─ auth.js           # sessions (jti), JWT issue/verify, action-OTP helpers
│  │  ├─ providers/
│  │  │  ├─ sms.js         # console stub + Twilio / Africa's Talking (number validation)
│  │  │  └─ payments.js    # STUB mobile-money escrow (Telebirr-style)
│  │  ├─ services/
│  │  │  ├─ identity.js    # verification tier, unverified caps, doc dedup, IP prefixing
│  │  │  ├─ anti-fraud.js  # clique + velocity + device-cluster detection
│  │  │  └─ …              # deals lifecycle, disputes, reputation engine
│  │  └─ routes/           # auth, users, deals, disputes, reports, directory
│  ├─ scripts/             # smoke-api.js, ui-smoke.js (tests)
│  ├─ tests/               # node:test unit tests
│  └─ uploads/             # ID documents + dispute evidence
└─ web/                    # React 18 + Vite + Tailwind v4 (mobile-first)
   └─ src/
      ├─ i18n/             # en.js + am.js dictionaries, t() provider
      ├─ phash.js          # client-side perceptual hash (ID-doc dedup)
      ├─ fingerprint.js    # coarse device fingerprint for fraud detection
      ├─ components/       # ui primitives, app layout (sidebar/bottom nav)
      └─ pages/            # login, dashboard, deals, deal detail, disputes,
                           # moderator, directory, profile, trust report, settings
```

### The tamper-evident ledger

Every significant event (`deal_created`, `terms_agreed`, `escrow_funded`, `delivered`, `deal_confirmed`,
`dispute_resolved`, …) is appended to an **immutable, hash-chained table**. Each entry stores its canonical JSON
content, a `content_hash`, the previous entry's hash, and `hash = sha256(prev_hash || content_hash)`. The
`GET /api/ledger/verify` endpoint (visible per-deal in the UI under *Tamper-evidence check*) walks the chain and
recomputes every hash — **any alteration to any historical field or link is detected**.

**MVP note:** the chain lives in Postgres/SQLite, which is cheap to run and sufficient while users trust the
platform operator. **If trust in the operator itself ever becomes a concern, `server/src/ledger.js` is the single
place to change** — swap the backing store for a real distributed ledger (e.g. periodically anchor the chain head
hash to a public chain or a set of independent notaries). Nothing else in the codebase needs to move.

### Swapping the stubs

- **SMS/OTP** (`server/src/providers/sms.js`): set `SMS_PROVIDER=africastalking` (or `twilio`) with the matching
  credentials from `.env`; `console` is the dev stub and is refused in production. Delivery status is parsed
  per recipient (non-101 → loud error), failures retry with backoff, and the operator can enable the provider's
  delivery-report webhook. **Note:** real SMS raises the cost of sybil accounts but doesn't eliminate them —
  VOIP detection is not perfect, so the anti-fraud layer still applies.
- **Mobile money escrow** (`server/src/providers/payments.js`): **Chapa** is wired end-to-end (hosted checkout,
  HMAC-signed webhooks, server-side re-verify, payouts). Zemen never holds funds — it records provider-confirmed
  state. Deal and dispute services are unchanged apart from plumbing the payout recipient phone.
- **ID verification**: documents are uploaded and stored for **manual review** (staff flips the status via the
  API). The provider-style seam for a real government ID API or biometric check is `server/src/services/identity.js`
  — swap the `verifyDocument` logic there without touching the deal/reputation/ledger code.
- **Government ID API / biometrics**: `server/src/services/identity.js` is the single seam; a real registry lookup
  can slot in later without changing routes, deals, reputation, or the ledger.
- **Telebirr / M-Pesa**: Chapa's hosted checkout already lets payers use Telebirr/CBE Birr. A direct Telebirr or
  M-Pesa Daraja integration would be a new provider implementing the same `paymentsProvider` interface
  (`deposit` / `release` / `refund` / `verifyWebhook` / `confirmPayment`) — see LAUNCH_CHECKLIST.md §Payments.

## Known limitations

- **No identity system without a government registry behind it can fully prevent determined sybil attacks.**
  This platform raises the *cost* of fabricating trust history (paid/validated SMS, verification tier, document
  dedup, device/IP fingerprinting) and improves *detection* (clique, velocity, and concentration flags reviewed
  by moderators) — it does not make fabrication impossible. A motivated attacker with multiple SIMs, devices,
  and documents can still create multiple accounts.
- Wide hub-and-spoke networks with distributed infrastructure (different devices/IPs per spoke) — a
  coordinated operator trading one-off deals with many throwaway accounts (who never trade each other) defeats
  the clique and concentration checks by construction; the hub-spoke and shallow-network flags raise it for
  review, but a ring that varies infrastructure per spoke can still slip through, like the SMS/VOIP caveat
  below, because every per-device signal is fresh.
- Document dedup relies on a client-computed perceptual hash and a self-reported ID number; both are **flagged
  for manual review, not auto-trusted**. OCR of the ID number is a future improvement — today the applicant
  types it in.
- Device fingerprints are **coarse** (canvas/WebGL/UA-derived) and can be spoofed; they are a signal for review,
  not proof of identity.
- VOIP-number rejection depends on the SMS provider's line-type data, which is imperfect and may have
  geographic blind spots (including for Ethiopian numbers).
- **Session tokens are still JWTs signed with `JWT_SECRET`** — set a real secret before any non-demo deployment.
- **Moderator selection itself isn't yet a solved trust problem.** Dispute resolution is hardened so a conflicted
  or sub-quorum vote can't decide a case, but the platform still ultimately vouches for *who is allowed to judge*:
  staff manually flip `is_moderator` on accounts, with no public application, election, or reputation-gated
  progression for moderators. That is the same centralization caveat noted for the ledger — if trust in the
  operator ever becomes a concern, moderator selection is the next seam to decentralize.

## Security notes (prototype-grade)

- OTPs: 6 digits, 10-minute TTL, single-use, and **capped at 5 wrong attempts** before the code is burned.
- The dev OTP-peek endpoint (`GET /api/auth/dev/otp?phone=…`) exists **only in dev mode and is automatically
  disabled when `NODE_ENV=production`**, even if `DEV_MODE` is left on.
- Escrow-critical transitions are guarded (`UPDATE … WHERE status = expected`) so concurrent requests can't
  double-confirm or double-release funds; ledger appends are serialized so the chain can't fork.
- Sessions: jti-backed `sessions` rows with `device_info`, revocable via *Sign out of all devices*;
  tokens live **7 days** with silent refresh on activity; funding escrow, confirming large deals, and changing
  the account phone number require a fresh OTP. Change `JWT_SECRET` for any real deployment.

## Security notes (prototype-grade)

- OTPs: 6 digits, 10-minute TTL, single-use, and **capped at 5 wrong attempts** before the code is burned.
- The dev OTP-peek endpoint (`GET /api/auth/dev/otp?phone=…`) exists **only in dev mode and is automatically
  disabled when `NODE_ENV=production`**, even if `DEV_MODE` is left on.
- Escrow-critical transitions are guarded (`UPDATE … WHERE status = expected`) so concurrent requests can't
  double-confirm or double-release funds; ledger appends are serialized so the chain can't fork.
- JWT sessions expire after 30 days; change `JWT_SECRET` for any real deployment.

## Out of scope for MVP

- Real payment-provider integration (stub interface only)
- Automated ID verification (manual review only; OCR of the ID number is future work)
- Government/legal integration — Zemen is a private trust layer, not a legal registry
- Fully sybil-proof identity (see [Known limitations](#known-limitations))

---

## Deploying to Cloudflare (Workers + Pages)

The API runs as a Worker (`server/src/worker.js` — the Express app via `cloudflare:node`), the
frontend is static on Cloudflare Pages, and a Pages Function (`functions/_middleware.js`) proxies
`/api/*` and `/uploads/*` to the Worker — Pages `_redirects` cannot proxy to external domains, so
the Function is required. Everything else is served as static assets with Pages' native SPA fallback.

```bash
npm install
npx wrangler login                        # once per machine
npx wrangler d1 create zemen-db           # paste the returned database_id into wrangler.jsonc
npx wrangler r2 bucket create zemen-uploads
npm run deploy:web                        # Worker + frontend build + Pages deploy (one command)
npm run deploy:seed                       # seed the remote D1 with demo data
npx wrangler secret put JWT_SECRET        # required before real use
```

Local emulation: `npx wrangler dev` (miniflare provides local D1 + R2).

## Tests

```bash
npm test                          # unit tests: ledger integrity (+tamper), reputation math, hashing,
                                  # identity dedup, anti-fraud signals, dispute guards/quorum/appeal
npm run dev                       # (in another terminal)
node server/scripts/smoke-api.js  # 21-step API end-to-end: auth → deal → escrow → dispute → report
node server/scripts/ui-smoke.js   # real-Chrome click-through (mobile viewport), screenshots in server/scripts/shots/
```

`ui-smoke.js` runs against localhost by default; to drive the deployed site instead, see the header of the script
(reads OTP codes from `wrangler tail` output via `OTP_LOG`, since the dev autofill helper is disabled in production).

The API smoke covers: OTP auth, deal creation, terms acceptance + hash, escrow fund/release, ledger integrity,
reputation, public trust report, directory search, dispute raise → statements → moderator vote → staff resolve,
and phone-number masking on public profiles.
