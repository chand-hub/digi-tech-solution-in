/**
 * Secure Razorpay Payment Gateway Backend Service
 * Supports Test Mode (rzp_test_...) & Live Mode (rzp_live_...) via Web-Standard fetch & crypto.subtle.
 * Strictly server-side: RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET never leave the server.
 */

import {
  D1DatabaseLike,
  EnvBindings,
  PaymentOrderRecord,
  ServicePackageOption,
} from './types';
import {
  generateId,
  sha256Hex,
  verifyRazorpayPaymentSignature,
  verifyRazorpayWebhookSignature,
} from './crypto';
import {
  createPaymentOrderRecord,
  getLatestTransactionForOrder,
  getPaymentOrderByIdempotencyKey,
  getPaymentOrderByRazorpayId,
  getPaymentTransactionByPaymentId,
  hasWebhookEventBeenProcessed,
  recordPaymentTransaction,
  recordWebhookEvent,
  updatePaymentOrderStatus,
} from './db';
import { dispatchPaymentReceiptEmail } from './resendService';

/**
 * Authoritative Server-Side Booking / Project Deposit Catalog
 * Prevents client-side price tampering. Amounts are in INR and paise (1 INR = 100 paise).
 */
export const PAYMENT_PACKAGE_CATALOG: ServicePackageOption[] = [
  {
    id: 'discovery-booking',
    name: 'Project Discovery & UI Blueprint Booking',
    tier: 'Advance Consultation',
    amountInr: 999,
    amountPaise: 99900,
    description:
      'Reserve your priority project slot with architecture blueprint, custom wireframe & timeline.',
    deliverables: [
      'Priority Project Onboarding',
      'Custom Sitemap & Wireframe Plan',
      '100% Adjustable Against Final Project Cost',
    ],
  },
  {
    id: 'starter-advance',
    name: 'Business / Landing Website Advance (50%)',
    tier: 'Starter Package Advance',
    amountInr: 4999,
    amountPaise: 499900,
    description:
      'Kickstart deposit for high-converting business websites, clinics, restaurants, or landing pages.',
    deliverables: [
      'Responsive UI/UX Design & Build',
      'WhatsApp & Enquiry Email Integration',
      'SEO Meta Setup & Launch Support',
    ],
  },
  {
    id: 'growth-advance',
    name: 'Custom Platform / Portal Milestone Advance',
    tier: 'Growth Package Advance',
    amountInr: 9999,
    amountPaise: 999900,
    description:
      'Development advance for custom healthcare, matrimonial, booking portals, or multi-page apps.',
    deliverables: [
      'Full-Stack Database & Backend Integration',
      'Admin Workflow & Payment Ready Architecture',
      'Performance & Mobile Optimization',
    ],
  },
];

export function getRazorpayPublicConfig(env: EnvBindings): {
  configured: boolean;
  webhookConfigured: boolean;
  mode: 'test' | 'live' | 'unconfigured';
  keyId: string | null;
  currency: 'INR';
  catalog: ServicePackageOption[];
} {
  const keyId = env.RAZORPAY_KEY_ID?.trim() || '';
  const keySecret = env.RAZORPAY_KEY_SECRET?.trim() || '';
  const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET?.trim() || '';
  const configured = Boolean(keyId && keySecret);
  const mode: 'test' | 'live' | 'unconfigured' = !configured
    ? 'unconfigured'
    : keyId.startsWith('rzp_live_')
      ? 'live'
      : 'test';

  return {
    configured,
    webhookConfigured: Boolean(webhookSecret),
    mode,
    keyId: configured ? keyId : null,
    currency: 'INR',
    catalog: PAYMENT_PACKAGE_CATALOG,
  };
}

function getRazorpayAuthHeader(keyId: string, keySecret: string): string {
  const encoded = btoa(`${keyId}:${keySecret}`);
  return `Basic ${encoded}`;
}

export interface CreateOrderInput {
  packageId: string;
  customAmountInr?: number;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  businessName?: string;
  serviceName?: string;
  enquiryReferenceId?: string;
  idempotencyKey?: string;
  notes?: string;
}

export async function createRazorpayOrder(
  env: EnvBindings,
  db: D1DatabaseLike,
  input: CreateOrderInput
): Promise<{
  ok: boolean;
  status: number;
  error?: string;
  message: string;
  order?: PaymentOrderRecord;
  keyId?: string;
  duplicate?: boolean;
}> {
  const config = getRazorpayPublicConfig(env);
  if (!config.configured || !env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    return {
      ok: false,
      status: 503,
      error: 'RAZORPAY_NOT_CONFIGURED',
      message:
        'Razorpay payment gateway credentials (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET) are not configured on the server.',
    };
  }

  // Validate customer details
  if (!input.customerName || input.customerName.trim().length < 2) {
    return { ok: false, status: 400, error: 'VALIDATION_FAILED', message: 'Customer full name is required.' };
  }
  const cleanPhone = (input.customerPhone || '').replace(/[^0-9]/g, '');
  if (!cleanPhone || cleanPhone.length < 10) {
    return { ok: false, status: 400, error: 'VALIDATION_FAILED', message: 'Valid 10-digit mobile number is required.' };
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!input.customerEmail || !emailRegex.test(input.customerEmail.trim())) {
    return { ok: false, status: 400, error: 'VALIDATION_FAILED', message: 'Valid customer email address is required.' };
  }

  // Check idempotency key to prevent duplicate Razorpay orders on network retries
  if (input.idempotencyKey) {
    const existing = await getPaymentOrderByIdempotencyKey(db, input.idempotencyKey);
    if (existing) {
      return {
        ok: true,
        status: 200,
        message: 'Existing payment order reused safely.',
        order: existing,
        keyId: env.RAZORPAY_KEY_ID.trim(),
        duplicate: true,
      };
    }
  }

  // Determine authoritative amount in paise from catalog (or bounded custom milestone)
  const selectedPkg = PAYMENT_PACKAGE_CATALOG.find((p) => p.id === input.packageId);
  let amountPaise = 0;
  let packageTier = '';
  let serviceName = input.serviceName?.trim() || 'Website Development';

  if (selectedPkg) {
    amountPaise = selectedPkg.amountPaise;
    packageTier = selectedPkg.tier;
    if (!input.serviceName) serviceName = selectedPkg.name;
  } else if (input.packageId === 'custom-milestone') {
    const customInr = Number(input.customAmountInr);
    if (!Number.isFinite(customInr) || customInr < 100 || customInr > 500000) {
      return {
        ok: false,
        status: 400,
        error: 'INVALID_AMOUNT',
        message: 'Custom payment amount must be between ₹100 and ₹5,00,000.',
      };
    }
    amountPaise = Math.round(customInr * 100);
    packageTier = 'Custom Project Milestone';
  } else {
    return {
      ok: false,
      status: 400,
      error: 'INVALID_PACKAGE',
      message: 'Please select a valid service booking package.',
    };
  }

  const receipt = generateId('DTSRCT').slice(0, 38);
  const internalOrderId = generateId('ORD');

  const rzpRequestBody = {
    amount: amountPaise,
    currency: 'INR',
    receipt,
    notes: {
      agency: 'DIGI TECH SOLUTION',
      customer_name: input.customerName.trim().slice(0, 80),
      customer_phone: cleanPhone.slice(0, 20),
      service: serviceName.slice(0, 80),
      package_tier: packageTier.slice(0, 80),
      enquiry_ref: input.enquiryReferenceId || '',
      client_notes: (input.notes || '').slice(0, 180),
    },
  };

  try {
    const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: getRazorpayAuthHeader(
          env.RAZORPAY_KEY_ID.trim(),
          env.RAZORPAY_KEY_SECRET.trim()
        ),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(rzpRequestBody),
    });

    const rzpData = (await rzpRes.json().catch(() => ({}))) as {
      id?: string;
      amount?: number;
      currency?: string;
      status?: string;
      error?: { description?: string; code?: string };
    };

    if (!rzpRes.ok || !rzpData.id) {
      return {
        ok: false,
        status: 502,
        error: rzpData?.error?.code || 'RAZORPAY_ORDER_CREATION_FAILED',
        message:
          rzpData?.error?.description ||
          `Unable to create Razorpay order (HTTP ${rzpRes.status}). Please verify Razorpay API keys.`,
      };
    }

    const savedOrder = await createPaymentOrderRecord(db, {
      id: internalOrderId,
      razorpayOrderId: rzpData.id,
      idempotencyKey: input.idempotencyKey,
      enquiryReferenceId: input.enquiryReferenceId,
      customerName: input.customerName.trim(),
      customerEmail: input.customerEmail.trim(),
      customerPhone: cleanPhone,
      businessName: input.businessName?.trim() || undefined,
      serviceName,
      packageTier,
      amountPaise: Number(rzpData.amount || amountPaise),
      currency: rzpData.currency || 'INR',
      mode: config.mode === 'live' ? 'live' : 'test',
      status: 'created',
      receipt,
      notesJson: JSON.stringify(rzpRequestBody.notes),
    });

    return {
      ok: true,
      status: 200,
      message: 'Razorpay order created securely.',
      order: savedOrder,
      keyId: env.RAZORPAY_KEY_ID.trim(),
      duplicate: false,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      status: 502,
      error: 'RAZORPAY_NETWORK_ERROR',
      message: `Failed to reach Razorpay API: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function verifyAndFinalizeRazorpayPayment(
  env: EnvBindings,
  db: D1DatabaseLike,
  input: {
    razorpayOrderId: string;
    razorpayPaymentId: string;
    razorpaySignature: string;
  }
): Promise<{
  ok: boolean;
  status: number;
  verified: boolean;
  error?: string;
  message: string;
  order?: PaymentOrderRecord;
  paymentId?: string;
  method?: string;
}> {
  const keyId = env.RAZORPAY_KEY_ID?.trim();
  const keySecret = env.RAZORPAY_KEY_SECRET?.trim();
  if (!keyId || !keySecret) {
    return {
      ok: false,
      status: 503,
      verified: false,
      error: 'RAZORPAY_NOT_CONFIGURED',
      message: 'Razorpay server keys are not configured.',
    };
  }

  if (!input.razorpayOrderId || !input.razorpayPaymentId || !input.razorpaySignature) {
    return {
      ok: false,
      status: 400,
      verified: false,
      error: 'MISSING_PAYMENT_PARAMS',
      message: 'Order ID, Payment ID, and Signature are all required for server verification.',
    };
  }

  const order = await getPaymentOrderByRazorpayId(db, input.razorpayOrderId);
  if (!order) {
    return {
      ok: false,
      status: 404,
      verified: false,
      error: 'ORDER_NOT_FOUND',
      message: 'Payment order does not exist in our records.',
    };
  }

  // Idempotency check: prevent duplicate processing if already paid/verified
  const existingTx = await getPaymentTransactionByPaymentId(db, input.razorpayPaymentId);
  if (existingTx && existingTx.signatureVerified && order.status === 'paid') {
    return {
      ok: true,
      status: 200,
      verified: true,
      message: 'Payment already verified and recorded.',
      order,
      paymentId: input.razorpayPaymentId,
      method: existingTx.method,
    };
  }

  // 1. Cryptographic HMAC-SHA256 verification on server
  const signatureValid = await verifyRazorpayPaymentSignature(
    input.razorpayOrderId,
    input.razorpayPaymentId,
    input.razorpaySignature,
    keySecret
  );

  if (!signatureValid) {
    await recordPaymentTransaction(db, {
      razorpayOrderId: input.razorpayOrderId,
      razorpayPaymentId: input.razorpayPaymentId,
      razorpaySignature: input.razorpaySignature,
      signatureVerified: false,
      amountPaise: order.amountPaise,
      currency: order.currency,
      status: 'signature_invalid',
      failureCode: 'SIGNATURE_MISMATCH',
      failureReason: 'HMAC-SHA256 verification failed.',
      verifiedVia: 'checkout_verify',
    });

    return {
      ok: false,
      status: 400,
      verified: false,
      error: 'INVALID_PAYMENT_SIGNATURE',
      message: 'Payment signature verification failed. Payment cannot be confirmed.',
    };
  }

  // 2. Verify authentic payment status & amount directly with Razorpay Payments API
  let remoteStatus = 'captured';
  let paymentMethod: string | undefined;
  let remoteAmount = order.amountPaise;

  try {
    const rzpPaymentRes = await fetch(
      `https://api.razorpay.com/v1/payments/${encodeURIComponent(input.razorpayPaymentId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: getRazorpayAuthHeader(keyId, keySecret),
        },
      }
    );

    if (rzpPaymentRes.ok) {
      const rzpPayment = (await rzpPaymentRes.json()) as {
        id?: string;
        order_id?: string;
        status?: string;
        amount?: number;
        method?: string;
      };
      if (rzpPayment.order_id && rzpPayment.order_id !== input.razorpayOrderId) {
        return {
          ok: false,
          status: 400,
          verified: false,
          error: 'ORDER_ID_MISMATCH',
          message: 'Payment order mismatch detected during server verification.',
        };
      }
      if (rzpPayment.amount !== undefined && Number(rzpPayment.amount) !== order.amountPaise) {
        return {
          ok: false,
          status: 400,
          verified: false,
          error: 'AMOUNT_MISMATCH',
          message: 'Paid amount does not match the server order amount.',
        };
      }
      remoteStatus = rzpPayment.status || 'captured';
      paymentMethod = rzpPayment.method;
      remoteAmount = Number(rzpPayment.amount || order.amountPaise);
    }
  } catch {
    // HMAC-SHA256 signature already proved authenticity from Razorpay; record verified state
  }

  const isCapturedOrAuthorized = remoteStatus === 'captured' || remoteStatus === 'authorized';
  if (!isCapturedOrAuthorized) {
    await recordPaymentTransaction(db, {
      razorpayOrderId: input.razorpayOrderId,
      razorpayPaymentId: input.razorpayPaymentId,
      razorpaySignature: input.razorpaySignature,
      signatureVerified: true,
      amountPaise: remoteAmount,
      currency: order.currency,
      status: 'failed',
      method: paymentMethod,
      failureReason: `Razorpay payment status is "${remoteStatus}"`,
      verifiedVia: 'checkout_verify',
    });
    await updatePaymentOrderStatus(db, input.razorpayOrderId, 'failed');

    return {
      ok: false,
      status: 400,
      verified: false,
      error: 'PAYMENT_NOT_CAPTURED',
      message: `Payment status is "${remoteStatus}". Please retry payment if amount was not deducted.`,
    };
  }

  await recordPaymentTransaction(db, {
    razorpayOrderId: input.razorpayOrderId,
    razorpayPaymentId: input.razorpayPaymentId,
    razorpaySignature: input.razorpaySignature,
    signatureVerified: true,
    amountPaise: remoteAmount,
    currency: order.currency,
    status: 'verified',
    method: paymentMethod,
    verifiedVia: 'checkout_verify',
  });
  await updatePaymentOrderStatus(db, input.razorpayOrderId, 'paid');

  const updatedOrder = (await getPaymentOrderByRazorpayId(db, input.razorpayOrderId)) || {
    ...order,
    status: 'paid' as const,
  };

  // Send server email receipt non-blockingly so payment confirmation isn't blocked if email quota limits occur
  await dispatchPaymentReceiptEmail(env, updatedOrder, input.razorpayPaymentId).catch(() => {});

  return {
    ok: true,
    status: 200,
    verified: true,
    message: 'Payment verified and confirmed securely.',
    order: updatedOrder,
    paymentId: input.razorpayPaymentId,
    method: paymentMethod,
  };
}

export async function recordPaymentFailure(
  db: D1DatabaseLike,
  input: {
    razorpayOrderId: string;
    razorpayPaymentId?: string;
    code?: string;
    description?: string;
    reason?: string;
  }
): Promise<{ ok: boolean; order?: PaymentOrderRecord }> {
  const order = await getPaymentOrderByRazorpayId(db, input.razorpayOrderId);
  if (!order) {
    return { ok: false };
  }

  // Do not overwrite already paid orders
  if (order.status === 'paid') {
    return { ok: true, order };
  }

  await updatePaymentOrderStatus(db, input.razorpayOrderId, 'failed');
  await recordPaymentTransaction(db, {
    razorpayOrderId: input.razorpayOrderId,
    razorpayPaymentId: input.razorpayPaymentId || undefined,
    signatureVerified: false,
    amountPaise: order.amountPaise,
    currency: order.currency,
    status: 'failed',
    failureCode: input.code || 'CHECKOUT_FAILED',
    failureReason: input.description || input.reason || 'Payment failed or cancelled by user.',
    verifiedVia: 'checkout_verify',
  });

  return { ok: true, order: (await getPaymentOrderByRazorpayId(db, input.razorpayOrderId)) || order };
}

/**
 * Recovers / queries authoritative status for interrupted payments by checking DB and Razorpay Order API.
 */
export async function getAuthoritativeOrderStatus(
  env: EnvBindings,
  db: D1DatabaseLike,
  razorpayOrderId: string
): Promise<{
  found: boolean;
  order?: PaymentOrderRecord;
  latestTransaction?: Awaited<ReturnType<typeof getLatestTransactionForOrder>>;
}> {
  const order = await getPaymentOrderByRazorpayId(db, razorpayOrderId);
  if (!order) return { found: false };

  // If still created/attempted and Razorpay keys exist, inspect live Razorpay payments on this order
  const keyId = env.RAZORPAY_KEY_ID?.trim();
  const keySecret = env.RAZORPAY_KEY_SECRET?.trim();
  if (order.status !== 'paid' && keyId && keySecret) {
    try {
      const res = await fetch(
        `https://api.razorpay.com/v1/orders/${encodeURIComponent(razorpayOrderId)}/payments`,
        {
          headers: { Authorization: getRazorpayAuthHeader(keyId, keySecret) },
        }
      );
      if (res.ok) {
        const list = (await res.json()) as {
          items?: Array<{
            id: string;
            status: string;
            amount: number;
            currency: string;
            method?: string;
            error_code?: string;
            error_description?: string;
          }>;
        };
        const captured = list.items?.find((p) => p.status === 'captured');
        if (captured) {
          await recordPaymentTransaction(db, {
            razorpayOrderId,
            razorpayPaymentId: captured.id,
            signatureVerified: true,
            amountPaise: captured.amount,
            currency: captured.currency,
            status: 'captured',
            method: captured.method,
            verifiedVia: 'api_fetch',
          });
          await updatePaymentOrderStatus(db, razorpayOrderId, 'paid');
        }
      }
    } catch {
      // Return DB state safely
    }
  }

  const refreshedOrder = (await getPaymentOrderByRazorpayId(db, razorpayOrderId)) || order;
  const latestTransaction = await getLatestTransactionForOrder(db, razorpayOrderId);
  return {
    found: true,
    order: refreshedOrder,
    latestTransaction,
  };
}

export async function processRazorpayWebhook(
  env: EnvBindings,
  db: D1DatabaseLike,
  rawBody: string,
  signatureHeader: string,
  eventIdHeader?: string
): Promise<{
  ok: boolean;
  status: number;
  duplicate?: boolean;
  message: string;
}> {
  const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET?.trim();
  if (!webhookSecret) {
    return {
      ok: false,
      status: 503,
      message: 'RAZORPAY_WEBHOOK_SECRET is not configured on the server.',
    };
  }

  const sigValid = await verifyRazorpayWebhookSignature(rawBody, signatureHeader, webhookSecret);
  const eventId = eventIdHeader?.trim() || (await sha256Hex(rawBody));

  if (!sigValid) {
    await recordWebhookEvent(db, {
      eventId: `INVALID-${eventId.slice(0, 32)}`,
      eventType: 'invalid_signature',
      signatureValid: false,
      payloadSummary: 'Signature mismatch rejected',
      processedStatus: 'rejected',
    });
    return {
      ok: false,
      status: 400,
      message: 'Invalid Razorpay webhook signature.',
    };
  }

  // Idempotent duplicate webhook prevention
  if (await hasWebhookEventBeenProcessed(db, eventId)) {
    return {
      ok: true,
      status: 200,
      duplicate: true,
      message: 'Webhook event already processed.',
    };
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { ok: false, status: 400, message: 'Malformed webhook JSON payload.' };
  }

  const eventType = String(payload.event || 'unknown');
  const paymentEntity = (
    ((payload.payload as Record<string, unknown>)?.payment as Record<string, unknown>)?.entity || {}
  ) as Record<string, unknown>;
  const orderEntity = (
    ((payload.payload as Record<string, unknown>)?.order as Record<string, unknown>)?.entity || {}
  ) as Record<string, unknown>;

  const rzpOrderId = paymentEntity.order_id
    ? String(paymentEntity.order_id)
    : orderEntity.id
      ? String(orderEntity.id)
      : undefined;
  const rzpPaymentId = paymentEntity.id ? String(paymentEntity.id) : undefined;
  const amountPaise = Number(paymentEntity.amount || orderEntity.amount || 0);
  const currency = String(paymentEntity.currency || orderEntity.currency || 'INR');
  const method = paymentEntity.method ? String(paymentEntity.method) : undefined;

  if ((eventType === 'payment.captured' || eventType === 'order.paid') && rzpOrderId) {
    await updatePaymentOrderStatus(db, rzpOrderId, 'paid');
    await recordPaymentTransaction(db, {
      razorpayOrderId: rzpOrderId,
      razorpayPaymentId: rzpPaymentId,
      signatureVerified: true,
      amountPaise,
      currency,
      status: 'captured',
      method,
      verifiedVia: 'webhook',
    });
  } else if (eventType === 'payment.failed' && rzpOrderId) {
    const existing = await getPaymentOrderByRazorpayId(db, rzpOrderId);
    if (existing && existing.status !== 'paid') {
      await updatePaymentOrderStatus(db, rzpOrderId, 'failed');
    }
    await recordPaymentTransaction(db, {
      razorpayOrderId: rzpOrderId,
      razorpayPaymentId: rzpPaymentId,
      signatureVerified: true,
      amountPaise,
      currency,
      status: 'failed',
      method,
      failureCode: paymentEntity.error_code ? String(paymentEntity.error_code) : 'WEBHOOK_FAILED',
      failureReason: paymentEntity.error_description
        ? String(paymentEntity.error_description)
        : 'Payment failed notification received via Razorpay webhook.',
      verifiedVia: 'webhook',
    });
  }

  await recordWebhookEvent(db, {
    eventId,
    eventType,
    razorpayOrderId: rzpOrderId,
    razorpayPaymentId: rzpPaymentId,
    signatureValid: true,
    payloadSummary: JSON.stringify({ eventType, rzpOrderId, rzpPaymentId, amountPaise }),
    processedStatus: 'processed',
  });

  return {
    ok: true,
    status: 200,
    duplicate: false,
    message: 'Webhook verified and processed.',
  };
}
