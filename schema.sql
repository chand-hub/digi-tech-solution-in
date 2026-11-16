-- ============================================================================
-- DIGI TECH SOLUTION - Persistent Database Schema
-- Compatible with Cloudflare D1 (SQLite) & Node.js 22+ built-in node:sqlite
-- ============================================================================

PRAGMA foreign_keys = ON;

-- 1. Customers Table
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  business_name TEXT,
  phone_number TEXT NOT NULL UNIQUE,
  whatsapp_number TEXT,
  email_address TEXT,
  business_location TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone_number);
CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email_address);

-- 2. Enquiries & Quotation Requests Table
CREATE TABLE IF NOT EXISTS enquiries (
  reference_id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  request_type TEXT NOT NULL DEFAULT 'enquiry',
  full_name TEXT NOT NULL,
  business_name TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  whatsapp_number TEXT,
  email_address TEXT NOT NULL,
  business_location TEXT NOT NULL,
  website_type TEXT NOT NULL,
  has_existing_website TEXT NOT NULL DEFAULT 'No',
  existing_website_url TEXT,
  required_features TEXT NOT NULL DEFAULT '[]',
  project_budget TEXT NOT NULL,
  additional_requirements TEXT NOT NULL DEFAULT '',
  submitted_at TEXT NOT NULL,
  email_status TEXT NOT NULL DEFAULT 'pending',
  email_message_id TEXT,
  email_error TEXT,
  last_email_attempt_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  whatsapp_status TEXT NOT NULL DEFAULT 'not_sent',
  whatsapp_message_id TEXT,
  source TEXT NOT NULL DEFAULT 'web',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_enquiries_submitted_at ON enquiries(submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_enquiries_phone ON enquiries(phone_number);
CREATE INDEX IF NOT EXISTS idx_enquiries_email_status ON enquiries(email_status);

-- 3. Razorpay Payment Orders Table
CREATE TABLE IF NOT EXISTS payment_orders (
  id TEXT PRIMARY KEY,
  razorpay_order_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT UNIQUE,
  enquiry_reference_id TEXT,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  business_name TEXT,
  service_name TEXT NOT NULL,
  package_tier TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  mode TEXT NOT NULL DEFAULT 'test',
  status TEXT NOT NULL DEFAULT 'created',
  receipt TEXT NOT NULL UNIQUE,
  notes_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payment_orders_status ON payment_orders(status);
CREATE INDEX IF NOT EXISTS idx_payment_orders_created ON payment_orders(created_at DESC);

-- 4. Razorpay Payment Transactions Table
CREATE TABLE IF NOT EXISTS payment_transactions (
  id TEXT PRIMARY KEY,
  razorpay_order_id TEXT NOT NULL,
  razorpay_payment_id TEXT UNIQUE,
  razorpay_signature TEXT,
  signature_verified INTEGER NOT NULL DEFAULT 0,
  amount_paise INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL,
  method TEXT,
  failure_code TEXT,
  failure_reason TEXT,
  verified_via TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payment_tx_order ON payment_transactions(razorpay_order_id);
CREATE INDEX IF NOT EXISTS idx_payment_tx_status ON payment_transactions(status);

-- 5. Razorpay Webhook Idempotency & Audit Table
CREATE TABLE IF NOT EXISTS payment_webhooks (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  razorpay_order_id TEXT,
  razorpay_payment_id TEXT,
  signature_valid INTEGER NOT NULL DEFAULT 0,
  payload_summary TEXT,
  processed_status TEXT NOT NULL,
  received_at TEXT NOT NULL
);

-- 6. WhatsApp Business API Message Logs
CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id TEXT PRIMARY KEY,
  enquiry_reference_id TEXT,
  recipient_phone TEXT NOT NULL,
  message_type TEXT NOT NULL,
  template_or_body TEXT NOT NULL,
  provider_message_id TEXT UNIQUE,
  status TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_ref ON whatsapp_messages(enquiry_reference_id);

-- 7. Distributed Rate Limiting Table (D1 + SQLite Safe)
CREATE TABLE IF NOT EXISTS rate_limits (
  rate_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 1,
  window_start_ms INTEGER NOT NULL
);

-- 8. Admin Audit Logs
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  actor_ip TEXT,
  target_id TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL
);
