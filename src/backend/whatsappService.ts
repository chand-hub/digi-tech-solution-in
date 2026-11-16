/**
 * Server-Side WhatsApp Business Cloud API & Deep-Link Helper
 * Supports Meta WhatsApp Cloud API when WHATSAPP_ACCESS_TOKEN & WHATSAPP_PHONE_NUMBER_ID are set.
 * Never falsely reports messages as delivered when API credentials are missing.
 */

import { D1DatabaseLike, EnvBindings } from './types';
import {
  logWhatsAppMessage,
  updateEnquiryWhatsAppStatus,
  updateWhatsAppStatusByProviderId,
} from './db';

const DEFAULT_AGENCY_WHATSAPP = '917319785754';

export function buildWhatsAppDeepLink(message: string, targetPhone = DEFAULT_AGENCY_WHATSAPP): string {
  const digits = targetPhone.replace(/[^0-9]/g, '');
  const normalized = digits.length === 10 ? `91${digits}` : digits;
  return `https://wa.me/${normalized}?text=${encodeURIComponent(message)}`;
}

export function getWhatsAppConfigStatus(env: EnvBindings) {
  const hasToken = Boolean(env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_ACCESS_TOKEN.trim().length > 0);
  const hasPhoneId = Boolean(
    env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_PHONE_NUMBER_ID.trim().length > 0
  );
  const hasVerifyToken = Boolean(
    env.WHATSAPP_VERIFY_TOKEN && env.WHATSAPP_VERIFY_TOKEN.trim().length > 0
  );

  return {
    businessApiConfigured: hasToken && hasPhoneId,
    webhookConfigured: hasVerifyToken,
    directLinkAvailable: true,
    defaultAgencyLink: buildWhatsAppDeepLink(
      'Hello DIGI TECH SOLUTION! I would like to discuss a website project.'
    ),
  };
}

export function normalizeWhatsAppRecipient(phone: string): string {
  const digits = (phone || '').replace(/[^0-9]/g, '');
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

export async function sendWhatsAppBusinessNotification(
  env: EnvBindings,
  db: D1DatabaseLike,
  input: {
    enquiryReferenceId?: string;
    recipientPhone: string;
    messageText: string;
    templateName?: string;
  }
): Promise<{
  configured: boolean;
  sent: boolean;
  status: 'sent' | 'failed' | 'not_configured';
  providerMessageId?: string;
  error?: string;
  fallbackWhatsAppUrl: string;
}> {
  const fallbackWhatsAppUrl = buildWhatsAppDeepLink(input.messageText);
  const accessToken = env.WHATSAPP_ACCESS_TOKEN?.trim();
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  const normalizedRecipient = normalizeWhatsAppRecipient(input.recipientPhone);

  if (!accessToken || !phoneNumberId) {
    await logWhatsAppMessage(db, {
      enquiryReferenceId: input.enquiryReferenceId,
      recipientPhone: normalizedRecipient || DEFAULT_AGENCY_WHATSAPP,
      messageType: 'text',
      templateOrBody: input.messageText.slice(0, 500),
      status: 'not_configured',
      errorMessage: 'WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID is not configured.',
    });

    if (input.enquiryReferenceId) {
      await updateEnquiryWhatsAppStatus(db, input.enquiryReferenceId, 'not_configured');
    }

    return {
      configured: false,
      sent: false,
      status: 'not_configured',
      error: 'WhatsApp Business Cloud API credentials are not configured on server.',
      fallbackWhatsAppUrl,
    };
  }

  if (!normalizedRecipient || normalizedRecipient.length < 10) {
    return {
      configured: true,
      sent: false,
      status: 'failed',
      error: 'Invalid recipient phone number for WhatsApp delivery.',
      fallbackWhatsAppUrl,
    };
  }

  try {
    const endpoint = `https://graph.facebook.com/v21.0/${encodeURIComponent(phoneNumberId)}/messages`;
    const bodyPayload = input.templateName
      ? {
          messaging_product: 'whatsapp',
          to: normalizedRecipient,
          type: 'template',
          template: {
            name: input.templateName,
            language: { code: 'en' },
          },
        }
      : {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: normalizedRecipient,
          type: 'text',
          text: {
            preview_url: false,
            body: input.messageText,
          },
        };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(bodyPayload),
    });

    const data = (await res.json().catch(() => ({}))) as {
      messages?: Array<{ id?: string }>;
      error?: { message?: string };
    };

    if (!res.ok || !data?.messages?.[0]?.id) {
      const errorMsg = data?.error?.message || `WhatsApp Cloud API HTTP ${res.status}`;
      await logWhatsAppMessage(db, {
        enquiryReferenceId: input.enquiryReferenceId,
        recipientPhone: normalizedRecipient,
        messageType: input.templateName ? 'template' : 'text',
        templateOrBody: input.templateName || input.messageText.slice(0, 500),
        status: 'failed',
        errorMessage: errorMsg,
      });

      if (input.enquiryReferenceId) {
        await updateEnquiryWhatsAppStatus(db, input.enquiryReferenceId, 'failed');
      }

      return {
        configured: true,
        sent: false,
        status: 'failed',
        error: errorMsg,
        fallbackWhatsAppUrl,
      };
    }

    const providerMessageId = data.messages[0].id;
    await logWhatsAppMessage(db, {
      enquiryReferenceId: input.enquiryReferenceId,
      recipientPhone: normalizedRecipient,
      messageType: input.templateName ? 'template' : 'text',
      templateOrBody: input.templateName || input.messageText.slice(0, 500),
      providerMessageId,
      status: 'sent',
    });

    if (input.enquiryReferenceId) {
      await updateEnquiryWhatsAppStatus(db, input.enquiryReferenceId, 'sent', providerMessageId);
    }

    return {
      configured: true,
      sent: true,
      status: 'sent',
      providerMessageId,
      fallbackWhatsAppUrl,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await logWhatsAppMessage(db, {
      enquiryReferenceId: input.enquiryReferenceId,
      recipientPhone: normalizedRecipient,
      messageType: 'text',
      templateOrBody: input.messageText.slice(0, 500),
      status: 'failed',
      errorMessage: errorMsg,
    });
    return {
      configured: true,
      sent: false,
      status: 'failed',
      error: errorMsg,
      fallbackWhatsAppUrl,
    };
  }
}

export async function processWhatsAppWebhookPayload(
  db: D1DatabaseLike,
  payload: Record<string, unknown>
): Promise<{ updatedStatuses: number }> {
  let updatedStatuses = 0;
  const entries = Array.isArray(payload.entry) ? payload.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray((entry as Record<string, unknown>)?.changes)
      ? ((entry as Record<string, unknown>).changes as Array<Record<string, unknown>>)
      : [];
    for (const change of changes) {
      const value = (change.value || {}) as Record<string, unknown>;
      const statuses = Array.isArray(value.statuses)
        ? (value.statuses as Array<Record<string, unknown>>)
        : [];
      for (const st of statuses) {
        const msgId = st.id ? String(st.id) : '';
        const status = st.status ? String(st.status) : '';
        const errors = Array.isArray(st.errors) ? st.errors : [];
        const errMessage =
          errors.length > 0 && typeof errors[0] === 'object' && errors[0] !== null
            ? String((errors[0] as Record<string, unknown>).title || 'Delivery error')
            : undefined;
        if (msgId && status) {
          await updateWhatsAppStatusByProviderId(db, msgId, status, errMessage);
          updatedStatuses += 1;
        }
      }
    }
  }

  return { updatedStatuses };
}
