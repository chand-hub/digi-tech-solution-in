/**
 * Unified Persistent Database Layer for DIGI TECH SOLUTION
 * Supports Cloudflare D1 (Pages Functions) and Node.js SQLite identically.
 */

import {
  D1DatabaseLike,
  PaymentOrderRecord,
  PaymentTransactionRecord,
  StoredEnquiry,
  WhatsAppMessageRecord,
} from './types';
import { generateId } from './crypto';

const initializedDatabases = new WeakSet<object>();

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    business_name TEXT,
    phone_number TEXT NOT NULL UNIQUE,
    whatsapp_number TEXT,
    email_address TEXT,
    business_location TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS enquiries (
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
  )`,
  `CREATE TABLE IF NOT EXISTS payment_orders (
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
  )`,
  `CREATE TABLE IF NOT EXISTS payment_transactions (
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
  )`,
  `CREATE TABLE IF NOT EXISTS payment_webhooks (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    razorpay_order_id TEXT,
    razorpay_payment_id TEXT,
    signature_valid INTEGER NOT NULL DEFAULT 0,
    payload_summary TEXT,
    processed_status TEXT NOT NULL,
    received_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS whatsapp_messages (
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
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    rate_key TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 1,
    window_start_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    actor_ip TEXT,
    target_id TEXT,
    details_json TEXT,
    created_at TEXT NOT NULL
  )`,
];

export async function ensureSchema(db: D1DatabaseLike): Promise<void> {
  if (initializedDatabases.has(db)) return;
  for (const stmt of SCHEMA_STATEMENTS) {
    await db.prepare(stmt).run();
  }
  initializedDatabases.add(db);
}

export function normalizePhoneDigits(phone: string): string {
  const digits = (phone || '').replace(/[^0-9]/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    return digits.slice(2);
  }
  return digits;
}

export async function upsertCustomer(
  db: D1DatabaseLike,
  input: {
    fullName: string;
    businessName?: string;
    phoneNumber: string;
    whatsAppNumber?: string;
    emailAddress?: string;
    businessLocation?: string;
  }
): Promise<string | undefined> {
  await ensureSchema(db);
  const normalizedPhone = normalizePhoneDigits(input.phoneNumber);
  if (!normalizedPhone) return undefined;

  const now = new Date().toISOString();
  const existing = await db
    .prepare('SELECT id FROM customers WHERE phone_number = ?')
    .bind(normalizedPhone)
    .first<{ id: string }>();

  if (existing?.id) {
    await db
      .prepare(
        `UPDATE customers
         SET full_name = COALESCE(NULLIF(?, ''), full_name),
             business_name = COALESCE(NULLIF(?, 'Not provided'), business_name),
             whatsapp_number = COALESCE(NULLIF(?, ''), whatsapp_number),
             email_address = COALESCE(NULLIF(?, 'Not provided'), email_address),
             business_location = COALESCE(NULLIF(?, 'Not provided'), business_location),
             updated_at = ?
         WHERE id = ?`
      )
      .bind(
        input.fullName.trim(),
        (input.businessName || '').trim(),
        (input.whatsAppNumber || '').trim(),
        (input.emailAddress || '').trim(),
        (input.businessLocation || '').trim(),
        now,
        existing.id
      )
      .run();
    return existing.id;
  }

  const customerId = generateId('CUST');
  await db
    .prepare(
      `INSERT INTO customers (id, full_name, business_name, phone_number, whatsapp_number, email_address, business_location, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      customerId,
      input.fullName.trim(),
      input.businessName?.trim() || null,
      normalizedPhone,
      input.whatsAppNumber?.trim() || null,
      input.emailAddress?.trim() || null,
      input.businessLocation?.trim() || null,
      now,
      now
    )
    .run();
  return customerId;
}

function mapEnquiryRow(row: Record<string, unknown>): StoredEnquiry {
  let features: string[] = [];
  try {
    const rawFeatures = row.required_features;
    if (typeof rawFeatures === 'string') {
      features = JSON.parse(rawFeatures);
    } else if (Array.isArray(rawFeatures)) {
      features = rawFeatures as string[];
    }
  } catch {
    features = [];
  }

  return {
    referenceId: String(row.reference_id),
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : undefined,
    customerId: row.customer_id ? String(row.customer_id) : undefined,
    requestType: row.request_type === 'quotation' ? 'quotation' : 'enquiry',
    fullName: String(row.full_name),
    businessName: String(row.business_name),
    phoneNumber: String(row.phone_number),
    whatsAppNumber: row.whatsapp_number ? String(row.whatsapp_number) : undefined,
    emailAddress: String(row.email_address),
    businessLocation: String(row.business_location),
    websiteType: String(row.website_type),
    hasExistingWebsite: row.has_existing_website === 'Yes' ? 'Yes' : 'No',
    existingWebsiteUrl: row.existing_website_url ? String(row.existing_website_url) : undefined,
    requiredFeatures: features,
    projectBudget: String(row.project_budget),
    additionalRequirements: String(row.additional_requirements || ''),
    submittedAt: String(row.submitted_at),
    emailStatus: (row.email_status as StoredEnquiry['emailStatus']) || 'pending',
    emailMessageId: row.email_message_id ? String(row.email_message_id) : undefined,
    emailError: row.email_error ? String(row.email_error) : undefined,
    lastEmailAttemptAt: row.last_email_attempt_at ? String(row.last_email_attempt_at) : undefined,
    retryCount: Number(row.retry_count || 0),
    whatsappStatus: row.whatsapp_status ? String(row.whatsapp_status) : undefined,
    whatsappMessageId: row.whatsapp_message_id ? String(row.whatsapp_message_id) : undefined,
    source: row.source === 'offline_sync' ? 'offline_sync' : 'web',
    createdAt: row.created_at ? String(row.created_at) : undefined,
    updatedAt: row.updated_at ? String(row.updated_at) : undefined,
  };
}

export async function getEnquiryByReferenceId(
  db: D1DatabaseLike,
  referenceId: string
): Promise<StoredEnquiry | null> {
  await ensureSchema(db);
  const row = await db
    .prepare('SELECT * FROM enquiries WHERE reference_id = ?')
    .bind(referenceId)
    .first<Record<string, unknown>>();
  return row ? mapEnquiryRow(row) : null;
}

export async function getEnquiryByIdempotencyKey(
  db: D1DatabaseLike,
  idempotencyKey: string
): Promise<StoredEnquiry | null> {
  if (!idempotencyKey) return null;
  await ensureSchema(db);
  const row = await db
    .prepare('SELECT * FROM enquiries WHERE idempotency_key = ?')
    .bind(idempotencyKey)
    .first<Record<string, unknown>>();
  return row ? mapEnquiryRow(row) : null;
}

/**
 * Inserts or updates an enquiry safely without duplicating records.
 * Returns { record, isDuplicate } when an idempotencyKey already exists.
 */
export async function saveEnquiryRecord(
  db: D1DatabaseLike,
  enquiry: StoredEnquiry
): Promise<{ record: StoredEnquiry; isDuplicate: boolean }> {
  await ensureSchema(db);
  const now = new Date().toISOString();

  if (enquiry.idempotencyKey) {
    const existingByIdem = await getEnquiryByIdempotencyKey(db, enquiry.idempotencyKey);
    if (existingByIdem) {
      return { record: existingByIdem, isDuplicate: true };
    }
  }

  const customerId = await upsertCustomer(db, {
    fullName: enquiry.fullName,
    businessName: enquiry.businessName,
    phoneNumber: enquiry.phoneNumber,
    whatsAppNumber: enquiry.whatsAppNumber,
    emailAddress: enquiry.emailAddress,
    businessLocation: enquiry.businessLocation,
  });

  const existingByRef = await getEnquiryByReferenceId(db, enquiry.referenceId);
  const featuresJson = JSON.stringify(enquiry.requiredFeatures || []);

  if (existingByRef) {
    const nextRetryCount = enquiry.retryCount ?? existingByRef.retryCount ?? 0;
    await db
      .prepare(
        `UPDATE enquiries
         SET customer_id = COALESCE(?, customer_id),
             email_status = COALESCE(?, email_status),
             email_message_id = COALESCE(?, email_message_id),
             email_error = COALESCE(?, email_error),
             last_email_attempt_at = COALESCE(?, last_email_attempt_at),
             retry_count = ?,
             updated_at = ?
         WHERE reference_id = ?`
      )
      .bind(
        customerId || null,
        enquiry.emailStatus || existingByRef.emailStatus || 'pending',
        enquiry.emailMessageId || null,
        enquiry.emailError || null,
        enquiry.lastEmailAttemptAt || null,
        nextRetryCount,
        now,
        enquiry.referenceId
      )
      .run();

    const updated = await getEnquiryByReferenceId(db, enquiry.referenceId);
    return { record: updated || existingByRef, isDuplicate: false };
  }

  await db
    .prepare(
      `INSERT INTO enquiries (
        reference_id, idempotency_key, customer_id, request_type, full_name, business_name,
        phone_number, whatsapp_number, email_address, business_location, website_type,
        has_existing_website, existing_website_url, required_features, project_budget,
        additional_requirements, submitted_at, email_status, email_message_id, email_error,
        last_email_attempt_at, retry_count, whatsapp_status, whatsapp_message_id, source,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      enquiry.referenceId,
      enquiry.idempotencyKey || null,
      customerId || null,
      enquiry.requestType || 'enquiry',
      enquiry.fullName,
      enquiry.businessName,
      enquiry.phoneNumber,
      enquiry.whatsAppNumber || null,
      enquiry.emailAddress,
      enquiry.businessLocation,
      enquiry.websiteType,
      enquiry.hasExistingWebsite,
      enquiry.existingWebsiteUrl || null,
      featuresJson,
      enquiry.projectBudget,
      enquiry.additionalRequirements || '',
      enquiry.submittedAt || now,
      enquiry.emailStatus || 'pending',
      enquiry.emailMessageId || null,
      enquiry.emailError || null,
      enquiry.lastEmailAttemptAt || null,
      enquiry.retryCount || 0,
      enquiry.whatsappStatus || 'not_sent',
      enquiry.whatsappMessageId || null,
      enquiry.source || 'web',
      enquiry.createdAt || now,
      now
    )
    .run();

  const saved = await getEnquiryByReferenceId(db, enquiry.referenceId);
  return { record: saved || enquiry, isDuplicate: false };
}

export async function updateEnquiryEmailStatus(
  db: D1DatabaseLike,
  referenceId: string,
  update: {
    emailStatus: 'pending' | 'delivered' | 'failed' | 'key_missing';
    emailMessageId?: string;
    emailError?: string;
  }
): Promise<boolean> {
  await ensureSchema(db);
  const now = new Date().toISOString();
  const res = await db
    .prepare(
      `UPDATE enquiries
       SET email_status = ?,
           email_message_id = COALESCE(?, email_message_id),
           email_error = ?,
           last_email_attempt_at = ?,
           updated_at = ?
       WHERE reference_id = ?`
    )
    .bind(
      update.emailStatus,
      update.emailMessageId || null,
      update.emailError ?? null,
      now,
      now,
      referenceId
    )
    .run();
  return res.success;
}

export async function updateEnquiryWhatsAppStatus(
  db: D1DatabaseLike,
  referenceId: string,
  whatsappStatus: string,
  whatsappMessageId?: string
): Promise<void> {
  await ensureSchema(db);
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE enquiries
       SET whatsapp_status = ?,
           whatsapp_message_id = COALESCE(?, whatsapp_message_id),
           updated_at = ?
       WHERE reference_id = ?`
    )
    .bind(whatsappStatus, whatsappMessageId || null, now, referenceId)
    .run();
}

export async function checkPersistentRateLimit(
  db: D1DatabaseLike,
  rateKey: string,
  maxRequests = 12,
  windowMinutes = 10
): Promise<boolean> {
  await ensureSchema(db);
  const nowMs = Date.now();
  const windowMs = windowMinutes * 60 * 1000;

  const existing = await db
    .prepare('SELECT count, window_start_ms FROM rate_limits WHERE rate_key = ?')
    .bind(rateKey)
    .first<{ count: number; window_start_ms: number }>();

  if (!existing || nowMs - Number(existing.window_start_ms) >= windowMs) {
    await db
      .prepare(
        `INSERT INTO rate_limits (rate_key, count, window_start_ms)
         VALUES (?, 1, ?)
         ON CONFLICT(rate_key) DO UPDATE SET count = 1, window_start_ms = excluded.window_start_ms`
      )
      .bind(rateKey, nowMs)
      .run();
    return true;
  }

  if (Number(existing.count) >= maxRequests) {
    return false;
  }

  await db
    .prepare('UPDATE rate_limits SET count = count + 1 WHERE rate_key = ?')
    .bind(rateKey)
    .run();
  return true;
}

function mapPaymentOrderRow(row: Record<string, unknown>): PaymentOrderRecord {
  return {
    id: String(row.id),
    razorpayOrderId: String(row.razorpay_order_id),
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : undefined,
    enquiryReferenceId: row.enquiry_reference_id ? String(row.enquiry_reference_id) : undefined,
    customerId: row.customer_id ? String(row.customer_id) : undefined,
    customerName: String(row.customer_name),
    customerEmail: String(row.customer_email),
    customerPhone: String(row.customer_phone),
    businessName: row.business_name ? String(row.business_name) : undefined,
    serviceName: String(row.service_name),
    packageTier: String(row.package_tier),
    amountPaise: Number(row.amount_paise),
    currency: String(row.currency),
    mode: row.mode === 'live' ? 'live' : 'test',
    status: (row.status as PaymentOrderRecord['status']) || 'created',
    receipt: String(row.receipt),
    notesJson: row.notes_json ? String(row.notes_json) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function getPaymentOrderByIdempotencyKey(
  db: D1DatabaseLike,
  idempotencyKey: string
): Promise<PaymentOrderRecord | null> {
  if (!idempotencyKey) return null;
  await ensureSchema(db);
  const row = await db
    .prepare('SELECT * FROM payment_orders WHERE idempotency_key = ?')
    .bind(idempotencyKey)
    .first<Record<string, unknown>>();
  return row ? mapPaymentOrderRow(row) : null;
}

export async function getPaymentOrderByRazorpayId(
  db: D1DatabaseLike,
  razorpayOrderId: string
): Promise<PaymentOrderRecord | null> {
  await ensureSchema(db);
  const row = await db
    .prepare('SELECT * FROM payment_orders WHERE razorpay_order_id = ?')
    .bind(razorpayOrderId)
    .first<Record<string, unknown>>();
  return row ? mapPaymentOrderRow(row) : null;
}

export async function createPaymentOrderRecord(
  db: D1DatabaseLike,
  order: Omit<PaymentOrderRecord, 'createdAt' | 'updatedAt' | 'customerId'>
): Promise<PaymentOrderRecord> {
  await ensureSchema(db);
  const now = new Date().toISOString();
  const customerId = await upsertCustomer(db, {
    fullName: order.customerName,
    businessName: order.businessName,
    phoneNumber: order.customerPhone,
    emailAddress: order.customerEmail,
  });

  await db
    .prepare(
      `INSERT INTO payment_orders (
        id, razorpay_order_id, idempotency_key, enquiry_reference_id, customer_id,
        customer_name, customer_email, customer_phone, business_name,
        service_name, package_tier, amount_paise, currency, mode, status, receipt, notes_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      order.id,
      order.razorpayOrderId,
      order.idempotencyKey || null,
      order.enquiryReferenceId || null,
      customerId || null,
      order.customerName,
      order.customerEmail,
      order.customerPhone,
      order.businessName || null,
      order.serviceName,
      order.packageTier,
      order.amountPaise,
      order.currency,
      order.mode,
      order.status,
      order.receipt,
      order.notesJson || null,
      now,
      now
    )
    .run();

  return (await getPaymentOrderByRazorpayId(db, order.razorpayOrderId))!;
}

export async function updatePaymentOrderStatus(
  db: D1DatabaseLike,
  razorpayOrderId: string,
  status: PaymentOrderRecord['status']
): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare('UPDATE payment_orders SET status = ?, updated_at = ? WHERE razorpay_order_id = ?')
    .bind(status, new Date().toISOString(), razorpayOrderId)
    .run();
}

export async function getPaymentTransactionByPaymentId(
  db: D1DatabaseLike,
  razorpayPaymentId: string
): Promise<PaymentTransactionRecord | null> {
  await ensureSchema(db);
  const row = await db
    .prepare('SELECT * FROM payment_transactions WHERE razorpay_payment_id = ?')
    .bind(razorpayPaymentId)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return {
    id: String(row.id),
    razorpayOrderId: String(row.razorpay_order_id),
    razorpayPaymentId: row.razorpay_payment_id ? String(row.razorpay_payment_id) : undefined,
    razorpaySignature: row.razorpay_signature ? String(row.razorpay_signature) : undefined,
    signatureVerified: Number(row.signature_verified) === 1,
    amountPaise: Number(row.amount_paise),
    currency: String(row.currency),
    status: row.status as PaymentTransactionRecord['status'],
    method: row.method ? String(row.method) : undefined,
    failureCode: row.failure_code ? String(row.failure_code) : undefined,
    failureReason: row.failure_reason ? String(row.failure_reason) : undefined,
    verifiedVia: row.verified_via as PaymentTransactionRecord['verifiedVia'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function recordPaymentTransaction(
  db: D1DatabaseLike,
  tx: Omit<PaymentTransactionRecord, 'id' | 'createdAt' | 'updatedAt'>
): Promise<PaymentTransactionRecord> {
  await ensureSchema(db);
  const now = new Date().toISOString();

  if (tx.razorpayPaymentId) {
    const existing = await getPaymentTransactionByPaymentId(db, tx.razorpayPaymentId);
    if (existing) {
      await db
        .prepare(
          `UPDATE payment_transactions
           SET signature_verified = CASE WHEN ? = 1 THEN 1 ELSE signature_verified END,
               razorpay_signature = COALESCE(?, razorpay_signature),
               status = ?,
               method = COALESCE(?, method),
               failure_code = COALESCE(?, failure_code),
               failure_reason = COALESCE(?, failure_reason),
               updated_at = ?
           WHERE razorpay_payment_id = ?`
        )
        .bind(
          tx.signatureVerified ? 1 : 0,
          tx.razorpaySignature || null,
          tx.status,
          tx.method || null,
          tx.failureCode || null,
          tx.failureReason || null,
          now,
          tx.razorpayPaymentId
        )
        .run();
      return (await getPaymentTransactionByPaymentId(db, tx.razorpayPaymentId))!;
    }
  }

  const id = generateId('TXN');
  await db
    .prepare(
      `INSERT INTO payment_transactions (
        id, razorpay_order_id, razorpay_payment_id, razorpay_signature, signature_verified,
        amount_paise, currency, status, method, failure_code, failure_reason, verified_via,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      tx.razorpayOrderId,
      tx.razorpayPaymentId || null,
      tx.razorpaySignature || null,
      tx.signatureVerified ? 1 : 0,
      tx.amountPaise,
      tx.currency,
      tx.status,
      tx.method || null,
      tx.failureCode || null,
      tx.failureReason || null,
      tx.verifiedVia,
      now,
      now
    )
    .run();

  return {
    id,
    ...tx,
    createdAt: now,
    updatedAt: now,
  };
}

export async function getLatestTransactionForOrder(
  db: D1DatabaseLike,
  razorpayOrderId: string
): Promise<PaymentTransactionRecord | null> {
  await ensureSchema(db);
  const row = await db
    .prepare('SELECT * FROM payment_transactions WHERE razorpay_order_id = ? ORDER BY created_at DESC LIMIT 1')
    .bind(razorpayOrderId)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return {
    id: String(row.id),
    razorpayOrderId: String(row.razorpay_order_id),
    razorpayPaymentId: row.razorpay_payment_id ? String(row.razorpay_payment_id) : undefined,
    razorpaySignature: row.razorpay_signature ? String(row.razorpay_signature) : undefined,
    signatureVerified: Number(row.signature_verified) === 1,
    amountPaise: Number(row.amount_paise),
    currency: String(row.currency),
    status: row.status as PaymentTransactionRecord['status'],
    method: row.method ? String(row.method) : undefined,
    failureCode: row.failure_code ? String(row.failure_code) : undefined,
    failureReason: row.failure_reason ? String(row.failure_reason) : undefined,
    verifiedVia: row.verified_via as PaymentTransactionRecord['verifiedVia'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function hasWebhookEventBeenProcessed(
  db: D1DatabaseLike,
  eventId: string
): Promise<boolean> {
  await ensureSchema(db);
  const row = await db
    .prepare('SELECT event_id FROM payment_webhooks WHERE event_id = ?')
    .bind(eventId)
    .first<{ event_id: string }>();
  return Boolean(row?.event_id);
}

export async function recordWebhookEvent(
  db: D1DatabaseLike,
  input: {
    eventId: string;
    eventType: string;
    razorpayOrderId?: string;
    razorpayPaymentId?: string;
    signatureValid: boolean;
    payloadSummary: string;
    processedStatus: string;
  }
): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare(
      `INSERT OR IGNORE INTO payment_webhooks (
        event_id, event_type, razorpay_order_id, razorpay_payment_id,
        signature_valid, payload_summary, processed_status, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.eventId,
      input.eventType,
      input.razorpayOrderId || null,
      input.razorpayPaymentId || null,
      input.signatureValid ? 1 : 0,
      input.payloadSummary,
      input.processedStatus,
      new Date().toISOString()
    )
    .run();
}

export async function logWhatsAppMessage(
  db: D1DatabaseLike,
  msg: Omit<WhatsAppMessageRecord, 'id' | 'createdAt' | 'updatedAt'>
): Promise<WhatsAppMessageRecord> {
  await ensureSchema(db);
  const id = generateId('WA');
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO whatsapp_messages (
        id, enquiry_reference_id, recipient_phone, message_type, template_or_body,
        provider_message_id, status, error_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      msg.enquiryReferenceId || null,
      msg.recipientPhone,
      msg.messageType,
      msg.templateOrBody,
      msg.providerMessageId || null,
      msg.status,
      msg.errorMessage || null,
      now,
      now
    )
    .run();
  return { id, ...msg, createdAt: now, updatedAt: now };
}

export async function updateWhatsAppStatusByProviderId(
  db: D1DatabaseLike,
  providerMessageId: string,
  status: string,
  errorMessage?: string
): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare(
      `UPDATE whatsapp_messages
       SET status = ?, error_message = COALESCE(?, error_message), updated_at = ?
       WHERE provider_message_id = ?`
    )
    .bind(status, errorMessage || null, new Date().toISOString(), providerMessageId)
    .run();
}

export async function logAdminAudit(
  db: D1DatabaseLike,
  entry: { action: string; actorIp?: string; targetId?: string; details?: Record<string, unknown> }
): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare(
      `INSERT INTO admin_audit_logs (id, action, actor_ip, target_id, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      generateId('AUD'),
      entry.action,
      entry.actorIp || null,
      entry.targetId || null,
      entry.details ? JSON.stringify(entry.details) : null,
      new Date().toISOString()
    )
    .run();
}

export async function listAllEnquiries(db: D1DatabaseLike, limit = 100): Promise<StoredEnquiry[]> {
  await ensureSchema(db);
  const res = await db
    .prepare('SELECT * FROM enquiries ORDER BY submitted_at DESC LIMIT ?')
    .bind(limit)
    .all<Record<string, unknown>>();
  return (res.results || []).map(mapEnquiryRow);
}

export async function getAdminOverview(db: D1DatabaseLike): Promise<{
  counts: {
    customers: number;
    enquiries: number;
    paymentOrders: number;
    paidOrders: number;
    whatsappMessages: number;
  };
  recentEnquiries: StoredEnquiry[];
  recentOrders: PaymentOrderRecord[];
}> {
  await ensureSchema(db);
  const [cust, enq, ord, paid, wa, recEnq, recOrd] = await Promise.all([
    db.prepare('SELECT COUNT(*) as cnt FROM customers').first<{ cnt: number }>(),
    db.prepare('SELECT COUNT(*) as cnt FROM enquiries').first<{ cnt: number }>(),
    db.prepare('SELECT COUNT(*) as cnt FROM payment_orders').first<{ cnt: number }>(),
    db.prepare("SELECT COUNT(*) as cnt FROM payment_orders WHERE status = 'paid'").first<{ cnt: number }>(),
    db.prepare('SELECT COUNT(*) as cnt FROM whatsapp_messages').first<{ cnt: number }>(),
    db.prepare('SELECT * FROM enquiries ORDER BY submitted_at DESC LIMIT 25').all<Record<string, unknown>>(),
    db.prepare('SELECT * FROM payment_orders ORDER BY created_at DESC LIMIT 25').all<Record<string, unknown>>(),
  ]);

  return {
    counts: {
      customers: Number(cust?.cnt || 0),
      enquiries: Number(enq?.cnt || 0),
      paymentOrders: Number(ord?.cnt || 0),
      paidOrders: Number(paid?.cnt || 0),
      whatsappMessages: Number(wa?.cnt || 0),
    },
    recentEnquiries: (recEnq.results || []).map(mapEnquiryRow),
    recentOrders: (recOrd.results || []).map(mapPaymentOrderRow),
  };
}
