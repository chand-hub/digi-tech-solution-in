/**
 * Unified Web-Standard API Router for DIGI TECH SOLUTION
 * Runs identically inside Cloudflare Pages Functions (/functions/api/[[route]].ts)
 * and Node.js Express (server.ts).
 */

import { D1DatabaseLike, EnvBindings, ProjectEnquiryPayload, StoredEnquiry } from './types';
import {
  checkPersistentRateLimit,
  getAdminOverview,
  getEnquiryByReferenceId,
  logAdminAudit,
  saveEnquiryRecord,
  updateEnquiryEmailStatus,
} from './db';
import {
  dispatchEnquiryEmail,
  getEmailStatus,
  sendTestEmail,
  validateEnquiryPayload,
  validateQuotePayload,
} from './resendService';
import {
  createRazorpayOrder,
  getAuthoritativeOrderStatus,
  getRazorpayPublicConfig,
  processRazorpayWebhook,
  recordPaymentFailure,
  verifyAndFinalizeRazorpayPayment,
} from './razorpayService';
import {
  getWhatsAppConfigStatus,
  processWhatsAppWebhookPayload,
  sendWhatsAppBusinessNotification,
} from './whatsappService';
import { maskSensitive, timingSafeEqual } from './crypto';

export interface RouterHooks {
  onEnquirySaved?: () => Promise<void> | void;
}

function resolveCorsHeaders(request: Request, env: EnvBindings): Record<string, string> {
  const origin = request.headers.get('origin') || '';
  const allowedList = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const requestOrigin = new URL(request.url).origin;
  let allowOrigin = requestOrigin;

  if (origin) {
    if (origin === requestOrigin) {
      allowOrigin = origin;
    } else if (allowedList.includes(origin) || allowedList.includes('*')) {
      allowOrigin = origin;
    } else if (
      origin.endsWith('.run.app') ||
      origin.endsWith('.pages.dev') ||
      origin.startsWith('http://localhost:') ||
      origin.startsWith('http://127.0.0.1:')
    ) {
      allowOrigin = origin;
    }
  }

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, x-admin-key, x-idempotency-key',
    Vary: 'Origin',
  };
}

function jsonResponse(
  data: unknown,
  status: number,
  corsHeaders: Record<string, string>
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      ...corsHeaders,
    },
  });
}

async function handleEnquirySubmission(
  request: Request,
  env: EnvBindings,
  db: D1DatabaseLike,
  clientIp: string,
  corsHeaders: Record<string, string>,
  forcedMode?: 'enquiry' | 'quotation',
  hooks?: RouterHooks
): Promise<Response> {
  const allowed = await checkPersistentRateLimit(db, `submit:${clientIp}`, 12, 10);
  if (!allowed) {
    return jsonResponse(
      {
        success: false,
        emailSent: false,
        error: 'RATE_LIMIT_EXCEEDED',
        message:
          'Too many requests from this IP address. Please wait a few minutes before submitting again.',
      },
      429,
      corsHeaders
    );
  }

  let rawData: Record<string, unknown> = {};
  try {
    rawData = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse(
      {
        success: false,
        emailSent: false,
        error: 'INVALID_JSON',
        message: 'Invalid JSON request payload.',
      },
      400,
      corsHeaders
    );
  }

  // Honeypot anti-spam trap
  if (rawData.botHoneypot && String(rawData.botHoneypot).trim().length > 0) {
    return jsonResponse(
      {
        success: true,
        emailSent: true,
        referenceId: 'DTS-SPAM-PREVENTED',
        message: 'Enquiry received.',
      },
      200,
      corsHeaders
    );
  }

  const mode: 'enquiry' | 'quotation' =
    forcedMode || (rawData.requestType === 'quotation' ? 'quotation' : 'enquiry');

  const validation =
    mode === 'quotation'
      ? validateQuotePayload(rawData as Partial<ProjectEnquiryPayload>)
      : validateEnquiryPayload(rawData as Partial<ProjectEnquiryPayload>);

  if (!validation.valid) {
    return jsonResponse(
      {
        success: false,
        emailSent: false,
        error: 'VALIDATION_FAILED',
        message: 'Please fill in all required fields accurately.',
        fieldErrors: validation.errors,
      },
      400,
      corsHeaders
    );
  }

  const idempotencyKey =
    (request.headers.get('x-idempotency-key') || '').trim() ||
    (rawData.idempotencyKey ? String(rawData.idempotencyKey).trim() : '') ||
    undefined;

  const referenceId =
    (rawData.referenceId ? String(rawData.referenceId).trim() : '') ||
    `${mode === 'quotation' ? 'DTS-QT' : 'DTS'}-${Date.now().toString(36).toUpperCase()}`;

  const payload: ProjectEnquiryPayload = {
    referenceId,
    idempotencyKey,
    requestType: mode,
    fullName: String(rawData.fullName).trim(),
    businessName: String(rawData.businessName || 'Not provided').trim(),
    phoneNumber: String(rawData.phoneNumber).trim(),
    whatsAppNumber: rawData.whatsAppNumber ? String(rawData.whatsAppNumber).trim() : undefined,
    emailAddress: String(rawData.emailAddress || 'Not provided').trim(),
    businessLocation: String(rawData.businessLocation || 'Not provided').trim(),
    websiteType: String(rawData.websiteType || 'Business Website Development').trim(),
    hasExistingWebsite: rawData.hasExistingWebsite === 'Yes' ? 'Yes' : 'No',
    existingWebsiteUrl: rawData.existingWebsiteUrl
      ? String(rawData.existingWebsiteUrl).trim()
      : undefined,
    requiredFeatures: Array.isArray(rawData.requiredFeatures)
      ? rawData.requiredFeatures.map((f) => String(f))
      : [],
    projectBudget: String(rawData.projectBudget || 'Need Consultation').trim(),
    additionalRequirements: String(
      rawData.additionalRequirements || rawData.projectRequirements || ''
    ).trim(),
    submittedAt: rawData.submittedAt ? String(rawData.submittedAt) : new Date().toISOString(),
    source: rawData.source === 'offline_sync' ? 'offline_sync' : 'web',
  };

  // 1. Save persistently in database BEFORE email dispatch (zero enquiry loss)
  const { record, isDuplicate } = await saveEnquiryRecord(db, {
    ...payload,
    emailStatus: 'pending',
  });

  if (hooks?.onEnquirySaved) {
    await hooks.onEnquirySaved();
  }

  if (isDuplicate && record.emailStatus === 'delivered') {
    const emailStatus = getEmailStatus(env);
    return jsonResponse(
      {
        success: true,
        emailSent: true,
        duplicate: true,
        provider: 'resend',
        messageId: record.emailMessageId,
        referenceId: record.referenceId,
        recipientEmail: emailStatus.targetEmail,
        savedLocally: true,
        message:
          mode === 'quotation'
            ? 'Your quotation request was already received and confirmed.'
            : 'Your project enquiry was already received and confirmed.',
      },
      200,
      corsHeaders
    );
  }

  console.log('[DIGI TECH SOLUTION] Enquiry persisted:', {
    referenceId: record.referenceId,
    mode,
    source: payload.source,
    phoneMasked: maskSensitive(payload.phoneNumber, 2),
  });

  // 2. Dispatch notification email via Resend REST API
  const emailResult = await dispatchEnquiryEmail(env, payload);

  if (emailResult.delivered) {
    await updateEnquiryEmailStatus(db, record.referenceId, {
      emailStatus: 'delivered',
      emailMessageId: emailResult.messageId,
    });
    if (hooks?.onEnquirySaved) {
      await hooks.onEnquirySaved();
    }

    return jsonResponse(
      {
        success: true,
        emailSent: true,
        duplicate: isDuplicate,
        provider: 'resend',
        messageId: emailResult.messageId,
        referenceId: record.referenceId,
        recipientEmail: emailResult.recipientEmail,
        savedLocally: true,
        message:
          mode === 'quotation'
            ? 'Your quotation request has been successfully submitted. Our team will contact you shortly.'
            : `Your project enquiry has been submitted successfully! An automated email notification was delivered to ${emailResult.recipientEmail}.`,
      },
      200,
      corsHeaders
    );
  }

  if (emailResult.error === 'RESEND_API_KEY_NOT_CONFIGURED') {
    await updateEnquiryEmailStatus(db, record.referenceId, {
      emailStatus: 'key_missing',
      emailError: 'RESEND_API_KEY_NOT_CONFIGURED',
    });
    if (hooks?.onEnquirySaved) {
      await hooks.onEnquirySaved();
    }

    return jsonResponse(
      {
        success: false,
        emailSent: false,
        error: 'RESEND_API_KEY_NOT_CONFIGURED',
        referenceId: record.referenceId,
        recipientEmail: emailResult.recipientEmail,
        savedLocally: true,
        message:
          mode === 'quotation'
            ? 'Your request could not be processed right now. Please try again or contact us directly on WhatsApp.'
            : `Enquiry permanently saved in agency database (Ref: ${record.referenceId}). However, RESEND_API_KEY is not configured in server environment to dispatch email alerts to ${emailResult.recipientEmail}.`,
        details: emailResult.details,
      },
      503,
      corsHeaders
    );
  }

  await updateEnquiryEmailStatus(db, record.referenceId, {
    emailStatus: 'failed',
    emailError: emailResult.error,
  });
  if (hooks?.onEnquirySaved) {
    await hooks.onEnquirySaved();
  }

  return jsonResponse(
    {
      success: false,
      emailSent: false,
      error: 'EMAIL_DELIVERY_FAILED',
      referenceId: record.referenceId,
      recipientEmail: emailResult.recipientEmail,
      savedLocally: true,
      message:
        mode === 'quotation'
          ? 'Your request could not be processed right now. Please try again or contact us directly on WhatsApp.'
          : `Resend email delivery to ${emailResult.recipientEmail} failed: ${emailResult.error}`,
      details: emailResult.details || emailResult.error,
    },
    502,
    corsHeaders
  );
}

export async function handleApiRequest(
  request: Request,
  env: EnvBindings,
  db: D1DatabaseLike,
  clientIp: string,
  hooks?: RouterHooks
): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();
  const corsHeaders = resolveCorsHeaders(request, env);

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // 1. Health & Integration Readiness Endpoint (zero secrets exposed)
    if (pathname === '/api/health' && method === 'GET') {
      const emailSt = getEmailStatus(env);
      const rzpSt = getRazorpayPublicConfig(env);
      const waSt = getWhatsAppConfigStatus(env);
      return jsonResponse(
        {
          ok: true,
          service: 'DIGI TECH SOLUTION API',
          timestamp: new Date().toISOString(),
          database: 'connected',
          integrations: {
            emailConfigured: emailSt.configured,
            razorpayConfigured: rzpSt.configured,
            razorpayMode: rzpSt.mode,
            razorpayWebhookConfigured: rzpSt.webhookConfigured,
            whatsappBusinessApiConfigured: waSt.businessApiConfigured,
            adminAuthConfigured: Boolean(env.ADMIN_API_KEY && env.ADMIN_API_KEY.trim().length > 0),
          },
        },
        200,
        corsHeaders
      );
    }

    // 2. Email Status Diagnostic Endpoint
    if (pathname === '/api/email-status' && method === 'GET') {
      return jsonResponse(getEmailStatus(env), 200, corsHeaders);
    }

    // 3. Dedicated Test Email Endpoint
    if (pathname === '/api/test-email' && method === 'POST') {
      const allowed = await checkPersistentRateLimit(db, `test-email:${clientIp}`, 5, 10);
      if (!allowed) {
        return jsonResponse(
          { success: false, error: 'RATE_LIMIT_EXCEEDED', message: 'Please wait before testing again.' },
          429,
          corsHeaders
        );
      }

      const testResult = await sendTestEmail(env);
      if (testResult.success) {
        return jsonResponse(
          {
            success: true,
            message: `Test email successfully dispatched to ${testResult.recipientEmail}! Check your inbox.`,
            messageId: testResult.messageId,
          },
          200,
          corsHeaders
        );
      }
      return jsonResponse(
        {
          success: false,
          error: testResult.error,
          recipientEmail: testResult.recipientEmail,
          message: `Failed to dispatch test email: ${testResult.error}`,
        },
        400,
        corsHeaders
      );
    }

    // 4. Safe Retry Email Endpoint (Zero duplicate DB records)
    if (pathname === '/api/retry-email' && method === 'POST') {
      const allowed = await checkPersistentRateLimit(db, `retry:${clientIp}`, 10, 10);
      if (!allowed) {
        return jsonResponse(
          {
            success: false,
            emailSent: false,
            error: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many requests. Please wait a moment before retrying.',
          },
          429,
          corsHeaders
        );
      }

      const body = (await request.json().catch(() => ({}))) as {
        referenceId?: string;
        enquiry?: Partial<StoredEnquiry>;
      };

      if (!body.referenceId) {
        return jsonResponse(
          {
            success: false,
            emailSent: false,
            error: 'MISSING_REFERENCE_ID',
            message: 'Reference ID is required to retry.',
          },
          400,
          corsHeaders
        );
      }

      let record = await getEnquiryByReferenceId(db, body.referenceId);
      if (!record && body.enquiry && body.enquiry.fullName && body.enquiry.phoneNumber) {
        const saved = await saveEnquiryRecord(db, {
          referenceId: body.referenceId,
          requestType: body.enquiry.requestType || 'enquiry',
          fullName: body.enquiry.fullName,
          businessName: body.enquiry.businessName || 'Not provided',
          phoneNumber: body.enquiry.phoneNumber,
          whatsAppNumber: body.enquiry.whatsAppNumber,
          emailAddress: body.enquiry.emailAddress || 'Not provided',
          businessLocation: body.enquiry.businessLocation || 'Not provided',
          websiteType: body.enquiry.websiteType || 'Business Website',
          hasExistingWebsite: body.enquiry.hasExistingWebsite === 'Yes' ? 'Yes' : 'No',
          existingWebsiteUrl: body.enquiry.existingWebsiteUrl,
          requiredFeatures: body.enquiry.requiredFeatures || [],
          projectBudget: body.enquiry.projectBudget || 'Need Consultation',
          additionalRequirements: body.enquiry.additionalRequirements || '',
          submittedAt: body.enquiry.submittedAt || new Date().toISOString(),
        });
        record = saved.record;
      }

      if (!record) {
        return jsonResponse(
          {
            success: false,
            emailSent: false,
            error: 'NOT_FOUND',
            message: 'Enquiry record not found in database.',
          },
          404,
          corsHeaders
        );
      }

      await saveEnquiryRecord(db, {
        ...record,
        retryCount: (record.retryCount || 0) + 1,
      });

      const emailResult = await dispatchEnquiryEmail(env, record);
      if (emailResult.delivered) {
        await updateEnquiryEmailStatus(db, body.referenceId, {
          emailStatus: 'delivered',
          emailMessageId: emailResult.messageId,
        });
        if (hooks?.onEnquirySaved) await hooks.onEnquirySaved();
        return jsonResponse(
          {
            success: true,
            emailSent: true,
            provider: 'resend',
            messageId: emailResult.messageId,
            referenceId: body.referenceId,
            recipientEmail: emailResult.recipientEmail,
            message: `Email notification successfully delivered via Resend to ${emailResult.recipientEmail}!`,
          },
          200,
          corsHeaders
        );
      }

      if (emailResult.error === 'RESEND_API_KEY_NOT_CONFIGURED') {
        await updateEnquiryEmailStatus(db, body.referenceId, {
          emailStatus: 'key_missing',
          emailError: 'RESEND_API_KEY_NOT_CONFIGURED',
        });
        if (hooks?.onEnquirySaved) await hooks.onEnquirySaved();
        return jsonResponse(
          {
            success: false,
            emailSent: false,
            error: 'RESEND_API_KEY_NOT_CONFIGURED',
            referenceId: body.referenceId,
            recipientEmail: emailResult.recipientEmail,
            message: `Enquiry is preserved in database (Ref: ${body.referenceId}). However, RESEND_API_KEY is not configured in server environment.`,
            details: emailResult.details,
          },
          503,
          corsHeaders
        );
      }

      await updateEnquiryEmailStatus(db, body.referenceId, {
        emailStatus: 'failed',
        emailError: emailResult.error,
      });
      if (hooks?.onEnquirySaved) await hooks.onEnquirySaved();
      return jsonResponse(
        {
          success: false,
          emailSent: false,
          error: 'EMAIL_DELIVERY_FAILED',
          referenceId: body.referenceId,
          recipientEmail: emailResult.recipientEmail,
          message: `Resend email delivery failed: ${emailResult.error}`,
          details: emailResult.details,
        },
        502,
        corsHeaders
      );
    }

    // 5. Main Project Enquiry & Quotation Submission Endpoints
    if (pathname === '/api/contact' && method === 'POST') {
      return await handleEnquirySubmission(request, env, db, clientIp, corsHeaders, undefined, hooks);
    }
    if (pathname === '/api/quote' && method === 'POST') {
      return await handleEnquirySubmission(request, env, db, clientIp, corsHeaders, 'quotation', hooks);
    }

    // 6. Razorpay Payment Gateway Endpoints
    if (pathname === '/api/payments/config' && method === 'GET') {
      return jsonResponse(getRazorpayPublicConfig(env), 200, corsHeaders);
    }

    if (pathname === '/api/payments/create-order' && method === 'POST') {
      const allowed = await checkPersistentRateLimit(db, `pay-create:${clientIp}`, 10, 10);
      if (!allowed) {
        return jsonResponse(
          { ok: false, error: 'RATE_LIMIT_EXCEEDED', message: 'Too many payment attempts. Please wait a few minutes.' },
          429,
          corsHeaders
        );
      }

      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const result = await createRazorpayOrder(env, db, {
        packageId: String(body.packageId || ''),
        customAmountInr: body.customAmountInr !== undefined ? Number(body.customAmountInr) : undefined,
        customerName: String(body.customerName || ''),
        customerEmail: String(body.customerEmail || ''),
        customerPhone: String(body.customerPhone || ''),
        businessName: body.businessName ? String(body.businessName) : undefined,
        serviceName: body.serviceName ? String(body.serviceName) : undefined,
        enquiryReferenceId: body.enquiryReferenceId ? String(body.enquiryReferenceId) : undefined,
        idempotencyKey:
          (request.headers.get('x-idempotency-key') || '').trim() ||
          (body.idempotencyKey ? String(body.idempotencyKey).trim() : undefined),
        notes: body.notes ? String(body.notes) : undefined,
      });

      return jsonResponse(result, result.status, corsHeaders);
    }

    if (pathname === '/api/payments/verify' && method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const result = await verifyAndFinalizeRazorpayPayment(env, db, {
        razorpayOrderId: String(body.razorpay_order_id || body.razorpayOrderId || ''),
        razorpayPaymentId: String(body.razorpay_payment_id || body.razorpayPaymentId || ''),
        razorpaySignature: String(body.razorpay_signature || body.razorpaySignature || ''),
      });
      return jsonResponse(result, result.status, corsHeaders);
    }

    if (pathname === '/api/payments/failure' && method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const res = await recordPaymentFailure(db, {
        razorpayOrderId: String(body.razorpay_order_id || body.razorpayOrderId || ''),
        razorpayPaymentId: body.razorpay_payment_id ? String(body.razorpay_payment_id) : undefined,
        code: body.code ? String(body.code) : undefined,
        description: body.description ? String(body.description) : undefined,
        reason: body.reason ? String(body.reason) : undefined,
      });
      return jsonResponse(
        {
          ok: res.ok,
          status: res.order?.status || 'unknown',
          message: 'Payment failure/interruption recorded safely.',
        },
        res.ok ? 200 : 404,
        corsHeaders
      );
    }

    if (pathname.startsWith('/api/payments/order/') && method === 'GET') {
      const orderId = decodeURIComponent(pathname.replace('/api/payments/order/', '')).trim();
      if (!orderId) {
        return jsonResponse({ found: false, message: 'Order ID required.' }, 400, corsHeaders);
      }
      const statusResult = await getAuthoritativeOrderStatus(env, db, orderId);
      return jsonResponse(statusResult, statusResult.found ? 200 : 404, corsHeaders);
    }

    if ((pathname === '/api/payments/webhook' || pathname === '/api/razorpay/webhook') && method === 'POST') {
      const rawBody = await request.text();
      const signature = request.headers.get('x-razorpay-signature') || '';
      const eventId = request.headers.get('x-razorpay-event-id') || undefined;
      const result = await processRazorpayWebhook(env, db, rawBody, signature, eventId);
      return jsonResponse(result, result.status, corsHeaders);
    }

    // 7. WhatsApp Business API Endpoints
    if (pathname === '/api/whatsapp/status' && method === 'GET') {
      return jsonResponse(getWhatsAppConfigStatus(env), 200, corsHeaders);
    }

    if (pathname === '/api/whatsapp/send' && method === 'POST') {
      const allowed = await checkPersistentRateLimit(db, `wa-send:${clientIp}`, 10, 10);
      if (!allowed) {
        return jsonResponse(
          { ok: false, error: 'RATE_LIMIT_EXCEEDED', message: 'Rate limit reached.' },
          429,
          corsHeaders
        );
      }

      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const messageText = String(body.message || body.messageText || '').trim();
      const recipientPhone = String(body.recipientPhone || '').trim();

      if (!messageText) {
        return jsonResponse(
          { ok: false, error: 'VALIDATION_FAILED', message: 'Message text is required.' },
          400,
          corsHeaders
        );
      }

      const result = await sendWhatsAppBusinessNotification(env, db, {
        enquiryReferenceId: body.enquiryReferenceId ? String(body.enquiryReferenceId) : undefined,
        recipientPhone: recipientPhone || '917319785754',
        messageText,
        templateName: body.templateName ? String(body.templateName) : undefined,
      });

      return jsonResponse(result, result.configured ? (result.sent ? 200 : 502) : 200, corsHeaders);
    }

    if (pathname === '/api/whatsapp/webhook' && method === 'GET') {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token') || '';
      const challenge = url.searchParams.get('hub.challenge') || '';
      const verifyToken = env.WHATSAPP_VERIFY_TOKEN?.trim() || '';

      if (mode === 'subscribe' && verifyToken && timingSafeEqual(token, verifyToken)) {
        return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
      }
      return jsonResponse({ error: 'FORBIDDEN' }, 403, corsHeaders);
    }

    if (pathname === '/api/whatsapp/webhook' && method === 'POST') {
      const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const processed = await processWhatsAppWebhookPayload(db, payload);
      return jsonResponse({ ok: true, ...processed }, 200, corsHeaders);
    }

    // 8. Protected Admin Summary Endpoint (Requires ADMIN_API_KEY)
    if (pathname === '/api/admin/overview' && method === 'GET') {
      const configuredAdminKey = env.ADMIN_API_KEY?.trim();
      if (!configuredAdminKey) {
        return jsonResponse(
          { ok: false, error: 'ADMIN_KEY_NOT_CONFIGURED', message: 'ADMIN_API_KEY is not set on server.' },
          503,
          corsHeaders
        );
      }

      const authHeader = request.headers.get('authorization') || '';
      const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7).trim()
        : '';
      const headerKey = (request.headers.get('x-admin-key') || '').trim();
      const providedKey = bearerToken || headerKey;

      if (!providedKey || !timingSafeEqual(providedKey, configuredAdminKey)) {
        await logAdminAudit(db, {
          action: 'ADMIN_UNAUTHORIZED_ACCESS',
          actorIp: clientIp,
        });
        return jsonResponse({ ok: false, error: 'UNAUTHORIZED' }, 401, corsHeaders);
      }

      await logAdminAudit(db, {
        action: 'ADMIN_OVERVIEW_READ',
        actorIp: clientIp,
      });
      const overview = await getAdminOverview(db);
      return jsonResponse({ ok: true, ...overview }, 200, corsHeaders);
    }

    // 9. API Catch-all (never return HTML for /api/*)
    return jsonResponse(
      {
        success: false,
        emailSent: false,
        error: 'API_ROUTE_NOT_FOUND',
        message: `API endpoint ${method} ${pathname} not found.`,
      },
      404,
      corsHeaders
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Internal server error';
    console.error('[DIGI TECH SOLUTION] API Router Unhandled Error:', msg);
    return jsonResponse(
      {
        success: false,
        emailSent: false,
        error: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected server error occurred while processing your request.',
      },
      500,
      corsHeaders
    );
  }
}
