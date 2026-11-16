/**
 * Web-Standard Cryptography & Sanitization Utilities
 * Uses globalThis.crypto.subtle for 100% compatibility across Cloudflare Workers and Node.js 22.
 */

const textEncoder = new TextEncoder();

export function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', textEncoder.encode(input));
  return toHex(digest);
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, textEncoder.encode(message));
  return toHex(signature);
}

/**
 * Constant-time string comparison to prevent timing side-channel attacks
 * when checking Razorpay HMAC signatures, webhook secrets, or Admin API keys.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = textEncoder.encode(a);
  const bBytes = textEncoder.encode(b);
  const maxLen = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < maxLen; i++) {
    const ba = i < aBytes.length ? aBytes[i] : 0;
    const bb = i < bBytes.length ? bBytes[i] : 0;
    diff |= ba ^ bb;
  }
  return diff === 0;
}

/**
 * Verifies Razorpay Checkout signature: HMAC-SHA256(order_id + "|" + payment_id, key_secret)
 */
export async function verifyRazorpayPaymentSignature(
  razorpayOrderId: string,
  razorpayPaymentId: string,
  providedSignature: string,
  keySecret: string
): Promise<boolean> {
  if (!razorpayOrderId || !razorpayPaymentId || !providedSignature || !keySecret) {
    return false;
  }
  const expected = await hmacSha256Hex(keySecret, `${razorpayOrderId}|${razorpayPaymentId}`);
  return timingSafeEqual(expected.toLowerCase(), providedSignature.trim().toLowerCase());
}

/**
 * Verifies Razorpay Webhook signature: HMAC-SHA256(raw_body, webhook_secret)
 */
export async function verifyRazorpayWebhookSignature(
  rawBody: string,
  providedSignature: string,
  webhookSecret: string
): Promise<boolean> {
  if (!rawBody || !providedSignature || !webhookSecret) {
    return false;
  }
  const expected = await hmacSha256Hex(webhookSecret, rawBody);
  return timingSafeEqual(expected.toLowerCase(), providedSignature.trim().toLowerCase());
}

/**
 * Generates short cryptographically safe random IDs using Web Crypto.
 */
export function generateId(prefix: string): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (b) => b.toString(36).padStart(2, '0'))
    .join('')
    .toUpperCase()
    .slice(0, 10);
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${token}`;
}

/**
 * Escapes HTML special characters to prevent injection inside notification emails.
 */
export function escapeHtml(value: string | undefined | null): string {
  if (!value) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Masks sensitive values before logging (keeps first/last few characters only).
 */
export function maskSensitive(value: string | undefined | null, visibleChars = 4): string {
  if (!value) return 'not_set';
  const trimmed = value.trim();
  if (trimmed.length <= visibleChars * 2) return '***';
  return `${trimmed.slice(0, visibleChars)}...${trimmed.slice(-visibleChars)}`;
}
