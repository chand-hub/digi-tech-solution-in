# DIGI TECH SOLUTION — Backend Architecture, Database Schema, API & Cloudflare Deployment Guide

## 1. Architecture Overview

DIGI TECH SOLUTION uses a **unified Web-Standard TypeScript backend** (`src/backend/`) that runs seamlessly in two runtimes without code duplication:

1. **Local / AI Studio Development (`server.ts`)**: Express server on port `3000` using Node 22 built-in `node:sqlite` (`data/digitech.db`), automatically migrating existing records from `data/enquiries.json` and mirroring enquiry writes back to `data/enquiries.json`.
2. **Production Cloudflare Pages (`functions/api/[[route]].ts`)**: Cloudflare Pages Functions (`onRequest`) bound to **Cloudflare D1** (`env.DB`) and Cloudflare encrypted Secrets.

All external integrations (Resend REST API, Razorpay Orders/Payments API, Meta WhatsApp Cloud API) and HMAC-SHA256 cryptographic checks use standard Web APIs (`fetch`, `Request`, `Response`, `globalThis.crypto.subtle`) so edge workers and Node behave identically.

---

## 2. Database Schema (`schema.sql`)

| Table | Purpose |
| :--- | :--- |
| `customers` | Deduplicated customer profiles keyed by normalized 10-digit phone number. |
| `enquiries` | Website contact & quotation submissions with `reference_id`, `idempotency_key`, email delivery state, retry count, and WhatsApp status. |
| `payment_orders` | Server-created Razorpay orders (`razorpay_order_id`, `idempotency_key`, authoritative `amount_paise`, `mode`, `status`, `receipt`). |
| `payment_transactions` | Cryptographically verified Checkout and Webhook payment records (`razorpay_payment_id` UNIQUE, `signature_verified`, `method`, failure details). |
| `payment_webhooks` | Deduplication & audit log for incoming Razorpay webhooks (`event_id` PRIMARY KEY). |
| `whatsapp_messages` | Outbound WhatsApp Cloud API message logs and Meta delivery/read status updates. |
| `rate_limits` | Persistent IP/endpoint rate-limit counters compatible with distributed D1 storage. |
| `admin_audit_logs` | Audit trail for protected `/api/admin/*` endpoints. |

Apply schema to Cloudflare D1:
```bash
npx wrangler d1 create digitech-solution-db
npx wrangler d1 execute digitech-solution-db --remote --file=./schema.sql
```

---

## 3. REST API Reference (`/api/*`)

All `/api/*` endpoints return `Content-Type: application/json; charset=utf-8` and `Cache-Control: no-store`.

| Method & Route | Description | Auth / Protection |
| :--- | :--- | :--- |
| `GET /api/health` | Service readiness & integration booleans (no secrets). | Public |
| `GET /api/email-status` | Resend email readiness, provider, and configured recipient address. | Public |
| `POST /api/test-email` | Sends a diagnostic verification email via Resend. | D1/SQLite rate-limited |
| `POST /api/contact` | Validates, persists customer/enquiry, prevents duplicates via `idempotencyKey`, and sends Resend alert. | Rate limit + Honeypot + Validation |
| `POST /api/quote` | Same pipeline tailored for Quick Quotation requests. | Rate limit + Validation |
| `POST /api/retry-email` | Re-attempts Resend email delivery by `referenceId` without creating duplicate DB rows. | Rate limit |
| `GET /api/payments/config` | Returns public `RAZORPAY_KEY_ID`, `mode` (`test`/`live`), and authoritative package catalog. Never returns secrets. | Public |
| `POST /api/payments/create-order` | Validates customer details, computes authoritative INR paise amount on server, creates Razorpay order with `idempotencyKey`. | Rate limit + Validation |
| `POST /api/payments/verify` | Verifies HMAC-SHA256 signature (`order_id\|payment_id`) with constant-time compare + fetches payment from Razorpay API before marking order `paid`. | Cryptographic HMAC-SHA256 |
| `POST /api/payments/failure` | Records failed/abandoned payment attempt without marking order `paid`. | Public order status update |
| `GET /api/payments/order/:orderId` | Checks DB + live Razorpay order payments to recover interrupted checkout sessions safely. | Public order lookup |
| `POST /api/razorpay/webhook` (and `/api/payments/webhook`) | Verifies `x-razorpay-signature` against raw body using `RAZORPAY_WEBHOOK_SECRET`, handles `payment.captured`, `payment.failed`, `order.paid`, and deduplicates by `x-razorpay-event-id`. | HMAC-SHA256 Webhook Secret |
| `GET /api/whatsapp/status` | Reports whether WhatsApp Business Cloud API is configured + fallback `wa.me` link. | Public |
| `POST /api/whatsapp/send` | Sends WhatsApp Business API message or returns honest `{ configured: false, fallbackWhatsAppUrl }`. | Rate limit |
| `GET/POST /api/whatsapp/webhook` | Meta WhatsApp webhook challenge verification (`hub.verify_token`) and status receipt updates. | `WHATSAPP_VERIFY_TOKEN` |
| `GET /api/admin/overview` | Returns recent enquiries, payment orders, and aggregate counts. | Requires `Authorization: Bearer <ADMIN_API_KEY>` or `x-admin-key` |

---

## 4. Environment Variables (`.env.example`)

Configure these in `.env` locally (never commit `.env`) and in **Cloudflare Pages -> Settings -> Environment Variables**:

- `OFFICIAL_NOTIFICATION_EMAIL`: Target Gmail receiving leads (e.g. `mdc476728@gmail.com`).
- `RESEND_API_KEY`: Server-side Resend API key (`re_...`).
- `RESEND_FROM_EMAIL`: Verified sender (`DIGI TECH SOLUTION <onboarding@resend.dev>` for testing, or custom domain sender).
- `RAZORPAY_KEY_ID`: Public Key ID (`rzp_test_...` for Test Mode, `rzp_live_...` for Live Mode).
- `RAZORPAY_KEY_SECRET`: **Secret** Key Secret (server-only).
- `RAZORPAY_WEBHOOK_SECRET`: **Secret** Webhook Signing Secret (server-only).
- `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`: Optional Meta WhatsApp Cloud API credentials.
- `ADMIN_API_KEY`: Strong random secret for `/api/admin/overview`.
- `ALLOWED_ORIGINS`: Optional comma-separated origins for CORS.

---

## 5. PWA & Offline Behavior

- Configured with `vite-plugin-pwa` (`manifest.webmanifest`, `192x192`, `512x512`, `maskable-512x512`, and `apple-touch-icon.png`).
- Static UI assets and Google Fonts are cached for offline browsing while `/api/*` stays strictly `NetworkOnly`.
- **IndexedDB (`dts_offline_db`)** persists contact/quote drafts across refreshes and safely queues **only non-payment enquiries** when offline, syncing them once connectivity returns using `idempotencyKey`.
- **Payment Guardrail**: Online payments are blocked while offline and are never confirmed without server-side cryptographic verification.

---

## 6. Deployment: Google AI Studio → GitHub → Cloudflare Pages + D1

1. **Push to GitHub**: Commit the project (verify `.env` and `data/*.db*` are ignored).
2. **Create Cloudflare D1 Database**:
   ```bash
   npx wrangler login
   npx wrangler d1 create digitech-solution-db
   ```
   Copy the `database_id` into `wrangler.toml`.
3. **Apply Database Schema**:
   ```bash
   npx wrangler d1 execute digitech-solution-db --remote --file=./schema.sql
   ```
4. **Create Cloudflare Pages Project**:
   - Connect your GitHub repository in **Cloudflare Dashboard → Workers & Pages → Create → Pages**.
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
5. **Bind D1 Database in Cloudflare Pages**:
   - Go to **Pages Project → Settings → Functions → D1 database bindings**.
   - Variable name: `DB` → Select `digitech-solution-db`.
6. **Add Encrypted Secrets in Cloudflare Pages**:
   - Go to **Settings → Variables and Secrets → Add Secret** for `RESEND_API_KEY`, `OFFICIAL_NOTIFICATION_EMAIL`, `RESEND_FROM_EMAIL`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `ADMIN_API_KEY`, and optional WhatsApp secrets.
7. **Configure Webhooks in Razorpay Dashboard**:
   - Add Webhook URL: `https://your-domain.com/api/payments/webhook`
   - Set Secret matching `RAZORPAY_WEBHOOK_SECRET`
   - Subscribe to `payment.captured`, `order.paid`, and `payment.failed`.

---

## 7. Local & Production Testing Checklist

1. Build & Typecheck: `npm run lint && npm run build`
2. Health check: `curl http://localhost:3000/api/health`
3. Email test: `POST /api/test-email` & form submission on `/api/contact` + `/api/quote`
4. Duplicate prevention: Repeat POST `/api/contact` with identical `idempotencyKey` and confirm `duplicate: true` with 1 DB row.
5. Razorpay signature verification & webhook HMAC check: Verify `POST /api/payments/verify` rejects forged signatures with HTTP `400`, and `POST /api/payments/webhook` rejects invalid HMAC headers.
6. Admin protection: Verify `GET /api/admin/overview` rejects missing/wrong tokens (`401`/`503`).
