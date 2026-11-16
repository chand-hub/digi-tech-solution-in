/**
 * Shared Web-Standard Backend Types & Database Abstractions
 * Runs identically in Node.js 22 (Express) and Cloudflare Pages Functions (Workers + D1).
 */

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean }>;
  run(): Promise<{ success: boolean; meta?: { changes?: number } }>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  exec?(query: string): Promise<unknown>;
  batch?<T = unknown>(statements: D1PreparedStatementLike[]): Promise<T[]>;
}

export interface EnvBindings {
  DB?: D1DatabaseLike;
  NODE_ENV?: string;
  APP_URL?: string;
  ALLOWED_ORIGINS?: string;

  // Email (Resend)
  RESEND_API_KEY?: string;
  OFFICIAL_NOTIFICATION_EMAIL?: string;
  NOTIFICATION_EMAIL?: string;
  RESEND_FROM_EMAIL?: string;

  // Razorpay
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;

  // WhatsApp Business Cloud API
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_BUSINESS_ACCOUNT_ID?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_DEFAULT_TEMPLATE?: string;

  // Admin Protection
  ADMIN_API_KEY?: string;
}

export interface ProjectEnquiryPayload {
  referenceId: string;
  idempotencyKey?: string;
  requestType?: 'enquiry' | 'quotation';
  fullName: string;
  businessName: string;
  phoneNumber: string;
  whatsAppNumber?: string;
  emailAddress: string;
  businessLocation: string;
  websiteType: string;
  hasExistingWebsite: 'Yes' | 'No';
  existingWebsiteUrl?: string;
  requiredFeatures: string[];
  projectBudget: string;
  additionalRequirements: string;
  submittedAt: string;
  botHoneypot?: string;
  source?: 'web' | 'offline_sync';
}

export interface StoredEnquiry extends ProjectEnquiryPayload {
  customerId?: string;
  emailStatus?: 'pending' | 'delivered' | 'failed' | 'key_missing';
  emailMessageId?: string;
  emailError?: string;
  lastEmailAttemptAt?: string;
  retryCount?: number;
  whatsappStatus?: string;
  whatsappMessageId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface EmailDispatchResult {
  delivered: boolean;
  provider: 'resend' | 'none';
  messageId?: string;
  error?: string;
  details?: string;
  recipientEmail: string;
}

export interface ServicePackageOption {
  id: string;
  name: string;
  tier: string;
  amountInr: number;
  amountPaise: number;
  description: string;
  deliverables: string[];
}

export interface PaymentOrderRecord {
  id: string;
  razorpayOrderId: string;
  idempotencyKey?: string;
  enquiryReferenceId?: string;
  customerId?: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  businessName?: string;
  serviceName: string;
  packageTier: string;
  amountPaise: number;
  currency: string;
  mode: 'test' | 'live';
  status: 'created' | 'attempted' | 'paid' | 'failed' | 'refunded';
  receipt: string;
  notesJson?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentTransactionRecord {
  id: string;
  razorpayOrderId: string;
  razorpayPaymentId?: string;
  razorpaySignature?: string;
  signatureVerified: boolean;
  amountPaise: number;
  currency: string;
  status: 'captured' | 'authorized' | 'failed' | 'verified' | 'signature_invalid';
  method?: string;
  failureCode?: string;
  failureReason?: string;
  verifiedVia: 'checkout_verify' | 'webhook' | 'api_fetch';
  createdAt: string;
  updatedAt: string;
}

export interface WhatsAppMessageRecord {
  id: string;
  enquiryReferenceId?: string;
  recipientPhone: string;
  messageType: string;
  templateOrBody: string;
  providerMessageId?: string;
  status: 'sent' | 'delivered' | 'read' | 'failed' | 'not_configured';
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}
