/**
 * Dedicated Cloudflare Pages Function for Razorpay Webhooks
 * Endpoint: POST /api/razorpay/webhook
 *
 * Verifies Razorpay HMAC-SHA256 webhook signature (`x-razorpay-signature`)
 * against the exact raw request body using `env.RAZORPAY_WEBHOOK_SECRET`,
 * processes `payment.captured`, `payment.failed`, and `order.paid` events,
 * and stores verified status in Cloudflare D1 (`env.DB`) when bound.
 */

import { D1DatabaseLike, EnvBindings } from '../../../src/backend/types';
import { verifyRazorpayWebhookSignature } from '../../../src/backend/crypto';
import { processRazorpayWebhook } from '../../../src/backend/razorpayService';

interface PagesContext {
  request: Request;
  env: EnvBindings & { DB?: D1DatabaseLike };
}

function jsonReply(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export const onRequestPost = async (context: PagesContext): Promise<Response> => {
  const { request, env } = context;

  const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET?.trim();
  if (!webhookSecret) {
    return jsonReply(
      {
        ok: false,
        error: 'WEBHOOK_SECRET_NOT_CONFIGURED',
        message: 'RAZORPAY_WEBHOOK_SECRET is not configured in Cloudflare environment variables.',
      },
      503
    );
  }

  const signature = request.headers.get('x-razorpay-signature') || '';
  if (!signature) {
    return jsonReply(
      {
        ok: false,
        error: 'MISSING_SIGNATURE',
        message: 'Missing x-razorpay-signature header.',
      },
      400
    );
  }

  const rawBody = await request.text();
  const eventId = request.headers.get('x-razorpay-event-id') || undefined;

  // When Cloudflare D1 ("DB") is bound, persist orders, transactions, and webhook idempotency
  if (env.DB) {
    const result = await processRazorpayWebhook(env, env.DB, rawBody, signature, eventId);
    return jsonReply(result, result.status);
  }

  // Fallback stateless verification if Cloudflare D1 DB binding has not been added yet
  const sigValid = await verifyRazorpayWebhookSignature(rawBody, signature, webhookSecret);
  if (!sigValid) {
    return jsonReply(
      {
        ok: false,
        error: 'INVALID_SIGNATURE',
        message: 'Invalid Razorpay webhook signature.',
      },
      400
    );
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonReply({ ok: false, error: 'INVALID_JSON', message: 'Malformed JSON body.' }, 400);
  }

  const eventType = String(payload.event || 'unknown');
  const paymentEntity = (
    ((payload.payload as Record<string, unknown>)?.payment as Record<string, unknown>)?.entity || {}
  ) as Record<string, unknown>;
  const orderEntity = (
    ((payload.payload as Record<string, unknown>)?.order as Record<string, unknown>)?.entity || {}
  ) as Record<string, unknown>;

  const orderId = paymentEntity.order_id || orderEntity.id || null;
  const paymentId = paymentEntity.id || null;

  if (
    eventType === 'payment.captured' ||
    eventType === 'payment.failed' ||
    eventType === 'order.paid'
  ) {
    console.log('[DIGI TECH SOLUTION] Verified Razorpay webhook event (stateless mode):', {
      eventType,
      orderId,
      paymentId,
    });
  }

  return jsonReply(
    {
      ok: true,
      verified: true,
      event: eventType,
      orderId,
      paymentId,
      databasePersisted: false,
      message: 'Webhook verified and acknowledged.',
    },
    200
  );
};

export const onRequest = async (context: PagesContext): Promise<Response> => {
  if (context.request.method.toUpperCase() === 'POST') {
    return onRequestPost(context);
  }
  return jsonReply(
    {
      ok: false,
      error: 'METHOD_NOT_ALLOWED',
      message: 'Razorpay webhook endpoint only accepts POST requests.',
    },
    405
  );
};
