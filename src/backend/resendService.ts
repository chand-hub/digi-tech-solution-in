/**
 * Cloudflare-Compatible & Node-Compatible Transactional Email Service (Resend REST API)
 * Replaces Node-only Resend SDK / Nodemailer dependencies with standard fetch().
 * Strictly server-side: never exposes RESEND_API_KEY to clients.
 */

import { EmailDispatchResult, EnvBindings, PaymentOrderRecord, ProjectEnquiryPayload } from './types';
import { escapeHtml } from './crypto';

export function validateEnquiryPayload(data: Partial<ProjectEnquiryPayload>): {
  valid: boolean;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};

  if (!data.fullName || data.fullName.trim().length < 2) {
    errors.fullName = 'Full Name is required (minimum 2 characters).';
  }

  if (!data.businessName || data.businessName.trim().length < 2) {
    errors.businessName = 'Business / Company Name is required.';
  }

  const cleanPhone = (data.phoneNumber || '').replace(/[^0-9]/g, '');
  if (!cleanPhone || cleanPhone.length < 10) {
    errors.phoneNumber = 'A valid 10-digit mobile number is required.';
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!data.emailAddress || !emailRegex.test(data.emailAddress.trim())) {
    errors.emailAddress = 'A valid email address is required.';
  }

  if (!data.businessLocation || data.businessLocation.trim().length < 2) {
    errors.businessLocation = 'Business location is required.';
  }

  if (!data.websiteType || data.websiteType.trim().length === 0) {
    errors.websiteType = 'Website type selection is required.';
  }

  if (!data.hasExistingWebsite || !['Yes', 'No'].includes(data.hasExistingWebsite)) {
    errors.hasExistingWebsite = 'Please specify if you already have a website (Yes/No).';
  }

  if (!data.projectBudget || data.projectBudget.trim().length === 0) {
    errors.projectBudget = 'Please select a project budget range.';
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

export function validateQuotePayload(data: Partial<ProjectEnquiryPayload>): {
  valid: boolean;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};

  if (!data.fullName || data.fullName.trim().length < 2) {
    errors.fullName = 'Full Name is required (minimum 2 characters).';
  }

  const cleanPhone = (data.phoneNumber || '').replace(/[^0-9]/g, '');
  if (!cleanPhone || cleanPhone.length < 10) {
    errors.phoneNumber = 'A valid 10-digit mobile / WhatsApp number is required.';
  }

  if (
    data.emailAddress &&
    data.emailAddress.trim() !== '' &&
    data.emailAddress.trim() !== 'Not provided'
  ) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(data.emailAddress.trim())) {
      errors.emailAddress = 'Please provide a valid email address.';
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

export function getRecipientEmail(env: EnvBindings): string {
  return (
    env.OFFICIAL_NOTIFICATION_EMAIL?.trim() ||
    env.NOTIFICATION_EMAIL?.trim() ||
    'mdc476728@gmail.com'
  );
}

export function getEmailStatus(env: EnvBindings): {
  configured: boolean;
  provider: 'resend' | 'none';
  targetEmail: string;
  hasApiKey: boolean;
  senderAddress: string;
} {
  const targetEmail = getRecipientEmail(env);
  const hasApiKey = Boolean(env.RESEND_API_KEY && env.RESEND_API_KEY.trim().length > 0);
  const senderAddress = env.RESEND_FROM_EMAIL?.trim() || 'DIGI TECH SOLUTION <onboarding@resend.dev>';
  return {
    configured: hasApiKey,
    provider: hasApiKey ? 'resend' : 'none',
    targetEmail,
    hasApiKey,
    senderAddress,
  };
}

function getEmailSubject(enquiry: ProjectEnquiryPayload): string {
  return enquiry.requestType === 'quotation'
    ? 'NEW WEBSITE QUOTATION REQUEST – DIGI TECH SOLUTION'
    : 'NEW CLIENT ENQUIRY – DIGI TECH SOLUTION';
}

function generateEmailHtml(enquiry: ProjectEnquiryPayload, recipientEmail: string): string {
  const emailSubject = getEmailSubject(enquiry);
  const formattedDate = new Date(enquiry.submittedAt).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'full',
    timeStyle: 'medium',
  });

  const featuresList =
    enquiry.requiredFeatures && enquiry.requiredFeatures.length > 0
      ? enquiry.requiredFeatures.map((f) => escapeHtml(f)).join(', ')
      : 'Standard Website Setup';

  const safePhone = escapeHtml(enquiry.phoneNumber);
  const cleanWaDigits = (enquiry.whatsAppNumber || enquiry.phoneNumber).replace(/[^0-9]/g, '');

  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(emailSubject)}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #080B12; color: #FFFFFF; margin: 0; padding: 20px; }
      .container { max-width: 600px; margin: 0 auto; background-color: #0E1626; border: 1px solid #1E293B; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
      .header { background: linear-gradient(135deg, #101827 0%, #151F32 100%); padding: 24px; border-bottom: 2px solid #D6B46A; }
      .header h1 { margin: 0; font-size: 22px; color: #FFFFFF; letter-spacing: -0.5px; }
      .header p { margin: 6px 0 0 0; font-size: 13px; color: #D6B46A; font-weight: 500; }
      .content { padding: 24px; color: #E2E8F0; }
      .badge { display: inline-block; padding: 5px 12px; background-color: #1E293B; border: 1px solid #D6B46A; border-radius: 6px; font-size: 12px; color: #D6B46A; font-weight: bold; margin-bottom: 18px; font-family: monospace; }
      table { width: 100%; border-collapse: collapse; margin-top: 10px; }
      th, td { padding: 11px 12px; text-align: left; font-size: 13px; border-bottom: 1px solid #1E293B; }
      th { color: #94A3B8; width: 36%; font-weight: 600; }
      td { color: #F8FAFC; }
      .highlight { color: #3185FF; font-weight: 600; }
      .gold { color: #D6B46A; font-weight: 600; }
      .notes-box { background-color: #101827; border: 1px solid #1E293B; border-radius: 8px; padding: 14px; margin-top: 10px; font-size: 13px; line-height: 1.6; color: #CBD5E1; }
      .footer { background-color: #080B12; padding: 18px 24px; font-size: 12px; color: #64748B; text-align: center; border-top: 1px solid #1E293B; }
      .btn { display: inline-block; padding: 12px 22px; background-color: #25D366; color: #080B12; font-weight: bold; text-decoration: none; border-radius: 8px; font-size: 13px; margin-top: 20px; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>DIGI TECH SOLUTION</h1>
        <p>Your Digital Growth Partner · ${
          enquiry.requestType === 'quotation'
            ? 'New Website Quotation Request'
            : 'New Client Project Enquiry'
        }</p>
      </div>
      <div class="content">
        <div class="badge">Reference ID: ${escapeHtml(enquiry.referenceId)}</div>
        <p style="margin: 0 0 16px 0; font-size: 14px; color: #CBD5E1;">A client has submitted a project requirement inquiry on your website:</p>
        <table>
          <tr><th>Client Name</th><td class="gold"><strong>${escapeHtml(enquiry.fullName)}</strong></td></tr>
          <tr><th>Business Name</th><td><strong>${escapeHtml(enquiry.businessName)}</strong></td></tr>
          <tr><th>Business Category</th><td class="highlight"><strong>${escapeHtml(enquiry.websiteType)}</strong></td></tr>
          <tr><th>Phone Number</th><td><a href="tel:${safePhone}" style="color: #3185FF; text-decoration: none; font-weight: bold;">${safePhone}</a></td></tr>
          <tr><th>WhatsApp Number</th><td>${
            enquiry.whatsAppNumber
              ? `<a href="https://wa.me/91${enquiry.whatsAppNumber.replace(/[^0-9]/g, '')}" style="color: #25D366; text-decoration: none; font-weight: bold;">${escapeHtml(enquiry.whatsAppNumber)}</a>`
              : 'Same as Mobile / Not Provided'
          }</td></tr>
          <tr><th>Email Address</th><td><a href="mailto:${escapeHtml(enquiry.emailAddress)}" style="color: #3185FF; text-decoration: none;">${escapeHtml(enquiry.emailAddress)}</a></td></tr>
          <tr><th>Business Location</th><td>${escapeHtml(enquiry.businessLocation)}</td></tr>
          <tr><th>Required Service</th><td class="highlight">${escapeHtml(enquiry.websiteType)}</td></tr>
          <tr><th>Required Features</th><td>${featuresList}</td></tr>
          <tr><th>Existing Website Status</th><td>${escapeHtml(enquiry.hasExistingWebsite)}${
            enquiry.existingWebsiteUrl
              ? ` — <a href="${escapeHtml(enquiry.existingWebsiteUrl)}" target="_blank" style="color: #D6B46A;">${escapeHtml(enquiry.existingWebsiteUrl)}</a>`
              : ''
          }</td></tr>
          <tr><th>Project Budget</th><td class="gold"><strong>${escapeHtml(enquiry.projectBudget)}</strong></td></tr>
          <tr><th>Submission Date & Time</th><td>${escapeHtml(formattedDate)}</td></tr>
        </table>
        <div style="margin-top: 20px;">
          <strong style="color: #D6B46A; font-size: 13px; text-transform: uppercase;">Project Requirements / Client Brief:</strong>
          <div class="notes-box">${
            enquiry.additionalRequirements
              ? escapeHtml(enquiry.additionalRequirements).replace(/\n/g, '<br/>')
              : 'No additional notes provided.'
          }</div>
        </div>
        <div style="text-align: center;">
          <a class="btn" href="https://wa.me/91${cleanWaDigits}?text=Hello%20${encodeURIComponent(enquiry.fullName)}!%20Thank%20you%20for%20contacting%20DIGI%20TECH%20SOLUTION%20regarding%20your%20${encodeURIComponent(enquiry.websiteType)}%20project.">Reply to Client on WhatsApp</a>
        </div>
      </div>
      <div class="footer">
        DIGI TECH SOLUTION · Darbhanga, Bihar, India · Recipient: ${escapeHtml(recipientEmail)}
      </div>
    </div>
  </body>
  </html>`;
}

function generatePlainText(enquiry: ProjectEnquiryPayload): string {
  return `
${getEmailSubject(enquiry)}
==================================================
Reference ID: ${enquiry.referenceId}
Submission Date & Time: ${enquiry.submittedAt}

CLIENT DETAILS:
- Client Name: ${enquiry.fullName}
- Business Name: ${enquiry.businessName}
- Business Category: ${enquiry.websiteType}
- Phone Number: ${enquiry.phoneNumber}
- WhatsApp Number: ${enquiry.whatsAppNumber || 'Same as Mobile'}
- Email Address: ${enquiry.emailAddress}
- Business Location: ${enquiry.businessLocation}

PROJECT SPECIFICATIONS:
- Required Service: ${enquiry.websiteType}
- Required Features: ${enquiry.requiredFeatures?.join(', ') || 'None'}
- Existing Website Status: ${enquiry.hasExistingWebsite}
- Existing Website URL: ${enquiry.existingWebsiteUrl || 'None'}
- Project Budget: ${enquiry.projectBudget}

PROJECT REQUIREMENTS:
${enquiry.additionalRequirements || 'None provided'}
==================================================
`;
}

async function sendViaResendApi(
  apiKey: string,
  payload: {
    from: string;
    to: string[];
    subject: string;
    html: string;
    text: string;
    reply_to?: string;
  }
): Promise<{ id?: string; error?: string; details?: string }> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const rawText = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = { message: rawText };
  }

  if (!response.ok) {
    const errMsg = String(parsed.message || parsed.name || `Resend HTTP ${response.status}`);
    return {
      error: errMsg,
      details: rawText,
    };
  }

  return {
    id: parsed.id ? String(parsed.id) : undefined,
  };
}

export async function dispatchEnquiryEmail(
  env: EnvBindings,
  enquiry: ProjectEnquiryPayload
): Promise<EmailDispatchResult> {
  const recipientEmail = getRecipientEmail(env);
  const resendApiKey = env.RESEND_API_KEY?.trim();

  if (!resendApiKey) {
    return {
      delivered: false,
      provider: 'none',
      recipientEmail,
      error: 'RESEND_API_KEY_NOT_CONFIGURED',
      details:
        'RESEND_API_KEY environment variable is missing on the server. Add your Resend API Key to server secrets to enable instant Gmail notifications.',
    };
  }

  const fromEmail = env.RESEND_FROM_EMAIL?.trim() || 'DIGI TECH SOLUTION <onboarding@resend.dev>';

  try {
    const res = await sendViaResendApi(resendApiKey, {
      from: fromEmail,
      to: [recipientEmail],
      subject: getEmailSubject(enquiry),
      html: generateEmailHtml(enquiry, recipientEmail),
      text: generatePlainText(enquiry),
      ...(enquiry.emailAddress && enquiry.emailAddress.includes('@')
        ? { reply_to: enquiry.emailAddress }
        : {}),
    });

    if (res.error || !res.id) {
      return {
        delivered: false,
        provider: 'resend',
        recipientEmail,
        error: res.error || 'Resend did not return a message ID',
        details: res.details,
      };
    }

    return {
      delivered: true,
      provider: 'resend',
      recipientEmail,
      messageId: res.id,
    };
  } catch (err: unknown) {
    return {
      delivered: false,
      provider: 'resend',
      recipientEmail,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function sendTestEmail(env: EnvBindings): Promise<{
  success: boolean;
  messageId?: string;
  error?: string;
  recipientEmail: string;
}> {
  const recipientEmail = getRecipientEmail(env);
  const resendApiKey = env.RESEND_API_KEY?.trim();

  if (!resendApiKey) {
    return {
      success: false,
      recipientEmail,
      error: 'RESEND_API_KEY is not configured in server environment.',
    };
  }

  const fromEmail = env.RESEND_FROM_EMAIL?.trim() || 'DIGI TECH SOLUTION <onboarding@resend.dev>';

  try {
    const res = await sendViaResendApi(resendApiKey, {
      from: fromEmail,
      to: [recipientEmail],
      subject: 'TEST EMAIL – DIGI TECH SOLUTION Backend Verification',
      html: `
      <div style="font-family: sans-serif; padding: 24px; background-color: #0E1626; color: #FFFFFF; border-radius: 10px; border: 1px solid #1E293B; max-width: 500px;">
        <h2 style="color: #D6B46A; margin-top: 0;">DIGI TECH SOLUTION</h2>
        <p style="font-size: 14px; line-height: 1.6; color: #E2E8F0;">
          This is an official test email confirming that the <strong>Resend Server Integration</strong> is configured and communicating with your Gmail inbox.
        </p>
        <p style="font-size: 13px; color: #94A3B8;">Recipient Inbox: <strong style="color: #3185FF;">${escapeHtml(recipientEmail)}</strong></p>
        <p style="font-size: 12px; color: #64748B;">Timestamp: ${new Date().toISOString()}</p>
      </div>
      `,
      text: `DIGI TECH SOLUTION - Test email sent to ${recipientEmail} via Resend API.`,
    });

    if (res.error) {
      return {
        success: false,
        recipientEmail,
        error: res.error,
      };
    }

    return {
      success: true,
      recipientEmail,
      messageId: res.id,
    };
  } catch (err: unknown) {
    return {
      success: false,
      recipientEmail,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function dispatchPaymentReceiptEmail(
  env: EnvBindings,
  order: PaymentOrderRecord,
  razorpayPaymentId: string
): Promise<EmailDispatchResult> {
  const recipientEmail = getRecipientEmail(env);
  const resendApiKey = env.RESEND_API_KEY?.trim();

  if (!resendApiKey) {
    return {
      delivered: false,
      provider: 'none',
      recipientEmail,
      error: 'RESEND_API_KEY_NOT_CONFIGURED',
    };
  }

  const fromEmail = env.RESEND_FROM_EMAIL?.trim() || 'DIGI TECH SOLUTION <onboarding@resend.dev>';
  const amountInr = (order.amountPaise / 100).toLocaleString('en-IN');

  const res = await sendViaResendApi(resendApiKey, {
    from: fromEmail,
    to: [recipientEmail],
    subject: `VERIFIED PAYMENT RECEIVED (₹${amountInr}) – DIGI TECH SOLUTION [${order.receipt}]`,
    html: `
      <div style="font-family: sans-serif; padding: 24px; background-color: #080B12; color: #FFFFFF; border: 1px solid #1E293B; border-radius: 12px; max-width: 580px;">
        <h2 style="color: #D6B46A; margin-top: 0;">DIGI TECH SOLUTION · Verified Payment</h2>
        <p style="font-size: 14px; color: #CBD5E1;">A Razorpay payment has been cryptographically verified on the server.</p>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 12px;">
          <tr><td style="padding: 8px; color: #94A3B8;">Mode</td><td style="padding: 8px; color: #FFFFFF;">${escapeHtml(order.mode.toUpperCase())}</td></tr>
          <tr><td style="padding: 8px; color: #94A3B8;">Amount</td><td style="padding: 8px; color: #34D399; font-weight: bold;">₹${escapeHtml(amountInr)} (${escapeHtml(order.currency)})</td></tr>
          <tr><td style="padding: 8px; color: #94A3B8;">Customer</td><td style="padding: 8px;">${escapeHtml(order.customerName)} (${escapeHtml(order.customerPhone)})</td></tr>
          <tr><td style="padding: 8px; color: #94A3B8;">Email</td><td style="padding: 8px;">${escapeHtml(order.customerEmail)}</td></tr>
          <tr><td style="padding: 8px; color: #94A3B8;">Service / Plan</td><td style="padding: 8px;">${escapeHtml(order.serviceName)} — ${escapeHtml(order.packageTier)}</td></tr>
          <tr><td style="padding: 8px; color: #94A3B8;">Razorpay Order ID</td><td style="padding: 8px; font-family: monospace;">${escapeHtml(order.razorpayOrderId)}</td></tr>
          <tr><td style="padding: 8px; color: #94A3B8;">Razorpay Payment ID</td><td style="padding: 8px; font-family: monospace;">${escapeHtml(razorpayPaymentId)}</td></tr>
          <tr><td style="padding: 8px; color: #94A3B8;">Receipt</td><td style="padding: 8px; font-family: monospace;">${escapeHtml(order.receipt)}</td></tr>
        </table>
      </div>
    `,
    text: `Verified Razorpay Payment: ₹${amountInr} (${order.mode}) | Order: ${order.razorpayOrderId} | Payment: ${razorpayPaymentId} | Customer: ${order.customerName} (${order.customerPhone})`,
    reply_to: order.customerEmail,
  });

  if (res.error || !res.id) {
    return {
      delivered: false,
      provider: 'resend',
      recipientEmail,
      error: res.error || 'Failed to send payment receipt email',
      details: res.details,
    };
  }

  return {
    delivered: true,
    provider: 'resend',
    recipientEmail,
    messageId: res.id,
  };
}
