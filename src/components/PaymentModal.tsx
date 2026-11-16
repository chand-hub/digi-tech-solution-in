import React, { useEffect, useState } from 'react';
import {
  X,
  CreditCard,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  Loader2,
  WifiOff,
  MessageCircle,
  Printer,
  RefreshCw,
  Lock,
} from 'lucide-react';
import { getJsonSafely, postJsonSafely } from '../utils/apiClient';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { AGENCY_CONFIG } from '../config/agencyConfig';

interface PaymentPackage {
  id: string;
  name: string;
  tier: string;
  amountInr: number;
  amountPaise: number;
  description: string;
  deliverables: string[];
}

interface PaymentConfigResponse {
  configured: boolean;
  webhookConfigured: boolean;
  mode: 'test' | 'live' | 'unconfigured';
  keyId: string | null;
  currency: 'INR';
  catalog: PaymentPackage[];
}

interface OrderRecordDto {
  id: string;
  razorpayOrderId: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  businessName?: string;
  serviceName: string;
  packageTier: string;
  amountPaise: number;
  currency: string;
  mode: 'test' | 'live';
  status: string;
  receipt: string;
  createdAt: string;
}

interface PaymentModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultService?: string;
  enquiryReferenceId?: string;
  prefillCustomer?: {
    name?: string;
    email?: string;
    phone?: string;
    business?: string;
  };
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => {
      open: () => void;
      on: (event: string, handler: (response: Record<string, unknown>) => void) => void;
    };
  }
}

const PENDING_ORDER_STORAGE_KEY = 'dts_pending_payment_order_v1';

function loadRazorpayCheckoutScript(): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') {
      resolve(false);
      return;
    }
    if (window.Razorpay) {
      resolve(true);
      return;
    }
    const existing = document.querySelector('script[src="https://checkout.razorpay.com/v1/checkout.js"]');
    if (existing) {
      existing.addEventListener('load', () => resolve(Boolean(window.Razorpay)), { once: true });
      existing.addEventListener('error', () => resolve(false), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => resolve(Boolean(window.Razorpay));
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

export const PaymentModal: React.FC<PaymentModalProps> = ({
  isOpen,
  onClose,
  defaultService,
  enquiryReferenceId,
  prefillCustomer,
}) => {
  const isOnline = useOnlineStatus();
  const [config, setConfig] = useState<PaymentConfigResponse | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(false);

  const [selectedPackageId, setSelectedPackageId] = useState('discovery-booking');
  const [customAmountInr, setCustomAmountInr] = useState('1500');
  const [customerName, setCustomerName] = useState(prefillCustomer?.name || '');
  const [customerEmail, setCustomerEmail] = useState(prefillCustomer?.email || '');
  const [customerPhone, setCustomerPhone] = useState(prefillCustomer?.phone || '');
  const [businessName, setBusinessName] = useState(prefillCustomer?.business || '');
  const [serviceName, setServiceName] = useState(defaultService || 'Business Website Development');
  const [notes, setNotes] = useState('');

  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [pendingOrderId, setPendingOrderId] = useState<string | null>(null);

  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const [confirmedReceipt, setConfirmedReceipt] = useState<{
    order: OrderRecordDto;
    paymentId: string;
    method?: string;
  } | null>(null);

  useEffect(() => {
    if (prefillCustomer?.name) setCustomerName(prefillCustomer.name);
    if (prefillCustomer?.email && prefillCustomer.email !== 'Not provided') {
      setCustomerEmail(prefillCustomer.email);
    }
    if (prefillCustomer?.phone) setCustomerPhone(prefillCustomer.phone);
    if (prefillCustomer?.business && prefillCustomer.business !== 'Not provided') {
      setBusinessName(prefillCustomer.business);
    }
    if (defaultService) setServiceName(defaultService);
  }, [prefillCustomer, defaultService]);

  const fetchConfig = async () => {
    if (!navigator.onLine) return;
    setLoadingConfig(true);
    const res = await getJsonSafely<PaymentConfigResponse>('/api/payments/config');
    setLoadingConfig(false);
    if (res.ok && res.data) {
      setConfig(res.data);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    setErrorMsg('');
    if (!idempotencyKey) {
      setIdempotencyKey(`PAY-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`);
    }
    try {
      const savedOrderId = sessionStorage.getItem(PENDING_ORDER_STORAGE_KEY);
      if (savedOrderId) setPendingOrderId(savedOrderId);
    } catch {
      // Ignore
    }
    fetchConfig();
  }, [isOpen]);

  if (!isOpen) return null;

  const selectedPkg = config?.catalog.find((p) => p.id === selectedPackageId);
  const displayAmountInr =
    selectedPackageId === 'custom-milestone'
      ? Math.max(0, Number(customAmountInr) || 0)
      : selectedPkg?.amountInr || 999;

  const checkPendingOrderStatus = async (orderIdToCheck: string) => {
    if (!isOnline) {
      setErrorMsg('Cannot verify payment status while offline. Please reconnect to the internet.');
      return;
    }
    setIsProcessing(true);
    setErrorMsg('');
    const statusRes = await getJsonSafely<{
      found: boolean;
      order?: OrderRecordDto;
      latestTransaction?: { razorpayPaymentId?: string; method?: string };
    }>(`/api/payments/order/${encodeURIComponent(orderIdToCheck)}`);
    setIsProcessing(false);

    if (statusRes.ok && statusRes.data?.found && statusRes.data.order) {
      if (statusRes.data.order.status === 'paid') {
        try {
          sessionStorage.removeItem(PENDING_ORDER_STORAGE_KEY);
        } catch {
          // Ignore
        }
        setPendingOrderId(null);
        setConfirmedReceipt({
          order: statusRes.data.order,
          paymentId: statusRes.data.latestTransaction?.razorpayPaymentId || 'VERIFIED_VIA_ORDER',
          method: statusRes.data.latestTransaction?.method,
        });
      } else {
        setErrorMsg(
          `Order ${orderIdToCheck} current status on server: "${statusRes.data.order.status.toUpperCase()}". You may retry payment safely.`
        );
      }
    } else {
      setErrorMsg('Unable to locate that order on server.');
    }
  };

  const handleStartPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');

    if (!isOnline) {
      setErrorMsg(
        'Payments cannot be processed or confirmed offline. Please reconnect to the internet and try again.'
      );
      return;
    }

    if (!customerName.trim() || customerName.trim().length < 2) {
      setErrorMsg('Please enter your full name.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail.trim())) {
      setErrorMsg('Please enter a valid email address for receipt delivery.');
      return;
    }
    const cleanPhone = customerPhone.replace(/[^0-9]/g, '');
    if (!cleanPhone || cleanPhone.length < 10) {
      setErrorMsg('Please enter a valid 10-digit mobile number.');
      return;
    }

    setIsProcessing(true);

    // 1. Create authentic Razorpay order on server
    const orderRes = await postJsonSafely<{
      ok?: boolean;
      error?: string;
      message?: string;
      keyId?: string;
      order?: OrderRecordDto;
    }>(
      '/api/payments/create-order',
      {
        packageId: selectedPackageId,
        customAmountInr:
          selectedPackageId === 'custom-milestone' ? Number(customAmountInr) : undefined,
        customerName: customerName.trim(),
        customerEmail: customerEmail.trim(),
        customerPhone: cleanPhone,
        businessName: businessName.trim() || undefined,
        serviceName: serviceName.trim(),
        enquiryReferenceId,
        idempotencyKey,
        notes: notes.trim(),
      },
      { 'x-idempotency-key': idempotencyKey }
    );

    if (!orderRes.ok || !orderRes.data?.ok || !orderRes.data.order || !orderRes.data.keyId) {
      setIsProcessing(false);
      setErrorMsg(
        orderRes.data?.message ||
          orderRes.message ||
          'Unable to create payment order on server.'
      );
      return;
    }

    const serverOrder = orderRes.data.order;
    const publicKeyId = orderRes.data.keyId;

    try {
      sessionStorage.setItem(PENDING_ORDER_STORAGE_KEY, serverOrder.razorpayOrderId);
      setPendingOrderId(serverOrder.razorpayOrderId);
    } catch {
      // Ignore
    }

    // 2. Load Razorpay Checkout script safely
    const loaded = await loadRazorpayCheckoutScript();
    if (!loaded || !window.Razorpay) {
      setIsProcessing(false);
      setErrorMsg('Could not load Razorpay Checkout SDK. Please check your network connection.');
      return;
    }

    // 3. Open Razorpay Checkout Modal (verification still happens strictly on server)
    const rzp = new window.Razorpay({
      key: publicKeyId,
      amount: serverOrder.amountPaise,
      currency: serverOrder.currency,
      name: AGENCY_CONFIG.businessName,
      description: `${serverOrder.serviceName} (${serverOrder.packageTier})`,
      order_id: serverOrder.razorpayOrderId,
      prefill: {
        name: serverOrder.customerName,
        email: serverOrder.customerEmail,
        contact: serverOrder.customerPhone,
      },
      notes: {
        receipt: serverOrder.receipt,
        enquiry_ref: enquiryReferenceId || '',
      },
      theme: {
        color: '#D6B46A',
      },
      modal: {
        ondismiss: async () => {
          setIsProcessing(false);
          setErrorMsg(
            `Checkout closed before confirmation (Order: ${serverOrder.razorpayOrderId}). Use "Check Order Status" below if money was debited.`
          );
        },
      },
      handler: async (rzpResponse: Record<string, unknown>) => {
        // 4. Server-side cryptographic HMAC verification (never trust client alone)
        if (!navigator.onLine) {
          setIsProcessing(false);
          setErrorMsg(
            `Internet dropped after checkout. Do NOT pay again—reconnect and click "Check Order Status" for Order ${serverOrder.razorpayOrderId}.`
          );
          return;
        }

        const verifyRes = await postJsonSafely<{
          ok?: boolean;
          verified?: boolean;
          message?: string;
          order?: OrderRecordDto;
          paymentId?: string;
          method?: string;
        }>('/api/payments/verify', {
          razorpay_order_id: rzpResponse.razorpay_order_id,
          razorpay_payment_id: rzpResponse.razorpay_payment_id,
          razorpay_signature: rzpResponse.razorpay_signature,
        });

        setIsProcessing(false);

        if (verifyRes.ok && verifyRes.data?.verified && verifyRes.data.order) {
          try {
            sessionStorage.removeItem(PENDING_ORDER_STORAGE_KEY);
          } catch {
            // Ignore
          }
          setPendingOrderId(null);
          setIdempotencyKey('');
          setConfirmedReceipt({
            order: verifyRes.data.order,
            paymentId:
              verifyRes.data.paymentId || String(rzpResponse.razorpay_payment_id || ''),
            method: verifyRes.data.method,
          });
        } else {
          setErrorMsg(
            verifyRes.data?.message ||
              verifyRes.message ||
              'Server payment signature verification failed.'
          );
        }
      },
    });

    rzp.on('payment.failed', async (failEvent: Record<string, unknown>) => {
      const errDetail = (failEvent.error || {}) as Record<string, unknown>;
      await postJsonSafely('/api/payments/failure', {
        razorpayOrderId: serverOrder.razorpayOrderId,
        razorpayPaymentId: (errDetail.metadata as Record<string, unknown>)?.payment_id,
        code: errDetail.code ? String(errDetail.code) : 'PAYMENT_FAILED',
        description: errDetail.description ? String(errDetail.description) : 'Payment failed',
        reason: errDetail.reason ? String(errDetail.reason) : undefined,
      }).catch(() => {});

      setIsProcessing(false);
      setErrorMsg(
        `Payment failed: ${
          errDetail.description ? String(errDetail.description) : 'Transaction was declined.'
        }`
      );
    });

    rzp.open();
  };

  const receiptWhatsAppUrl = confirmedReceipt
    ? `https://wa.me/91${AGENCY_CONFIG.whatsappNumber}?text=${encodeURIComponent(
        `Hello DIGI TECH SOLUTION! I have completed a verified payment:\n- Receipt: ${
          confirmedReceipt.order.receipt
        }\n- Order ID: ${confirmedReceipt.order.razorpayOrderId}\n- Payment ID: ${
          confirmedReceipt.paymentId
        }\n- Amount: ₹${(confirmedReceipt.order.amountPaise / 100).toLocaleString('en-IN')}\n- Service: ${
          confirmedReceipt.order.serviceName
        }\n- Name: ${confirmedReceipt.order.customerName}`
      )}`
    : AGENCY_CONFIG.socialLinks.whatsapp;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-xl bg-[#0E1626] border border-slate-700 rounded-3xl p-6 sm:p-8 shadow-2xl overflow-y-auto max-h-[92vh]">
        <button
          type="button"
          onClick={() => {
            setConfirmedReceipt(null);
            setErrorMsg('');
            onClose();
          }}
          className="absolute top-5 right-5 p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
          aria-label="Close Payment Window"
        >
          <X className="w-5 h-5" />
        </button>

        {confirmedReceipt ? (
          /* Dedicated Server-Verified Payment Confirmation View */
          <div className="space-y-6 py-4 text-center">
            <div className="w-16 h-16 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 flex items-center justify-center mx-auto">
              <CheckCircle2 className="w-9 h-9" />
            </div>

            <div className="space-y-1.5">
              <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-[11px] font-mono text-emerald-300 uppercase">
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>Server Signature Verified · {confirmedReceipt.order.mode.toUpperCase()}</span>
              </div>
              <h3 className="font-display font-bold text-2xl text-white pt-1">
                Payment Confirmed
              </h3>
              <p className="text-xs sm:text-sm text-[#B7C0CE]">
                Thank you, <strong className="text-white">{confirmedReceipt.order.customerName}</strong>.
                Your project booking payment has been verified and saved permanently.
              </p>
            </div>

            <div className="rounded-2xl bg-[#080B12] border border-slate-800 p-4 text-left text-xs space-y-2.5">
              <div className="flex justify-between gap-2 border-b border-slate-800 pb-2">
                <span className="text-slate-400">Amount Paid</span>
                <span className="font-bold text-emerald-400 text-sm">
                  ₹{(confirmedReceipt.order.amountPaise / 100).toLocaleString('en-IN')} INR
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-400">Receipt No.</span>
                <span className="font-mono text-[#D6B46A]">{confirmedReceipt.order.receipt}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-400">Razorpay Order ID</span>
                <span className="font-mono text-slate-200 break-all text-right">
                  {confirmedReceipt.order.razorpayOrderId}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-400">Razorpay Payment ID</span>
                <span className="font-mono text-slate-200 break-all text-right">
                  {confirmedReceipt.paymentId}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-400">Service / Package</span>
                <span className="text-slate-200 text-right">
                  {confirmedReceipt.order.serviceName} ({confirmedReceipt.order.packageTier})
                </span>
              </div>
              {confirmedReceipt.method && (
                <div className="flex justify-between gap-2">
                  <span className="text-slate-400">Payment Method</span>
                  <span className="text-slate-200 uppercase font-mono">
                    {confirmedReceipt.method}
                  </span>
                </div>
              )}
            </div>

            <div className="flex flex-col sm:flex-row gap-3 pt-1">
              <a
                href={receiptWhatsAppUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 inline-flex items-center justify-center gap-2 py-3 px-4 rounded-xl text-xs font-semibold text-white bg-[#25D366] hover:bg-[#20ba5a] transition-colors"
              >
                <MessageCircle className="w-4 h-4" />
                <span>Send Receipt on WhatsApp</span>
              </a>
              <button
                type="button"
                onClick={() => window.print()}
                className="inline-flex items-center justify-center gap-2 py-3 px-4 rounded-xl text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 transition-colors cursor-pointer"
              >
                <Printer className="w-4 h-4" />
                <span>Print Receipt</span>
              </button>
            </div>
          </div>
        ) : (
          /* Booking & Payment Form */
          <form onSubmit={handleStartPayment} className="space-y-4">
            <div className="space-y-1 pr-8">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[#D6B46A]">
                <CreditCard className="w-4 h-4" />
                <span>Secure Razorpay Project Booking</span>
                {config && (
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-mono ${
                      config.mode === 'live'
                        ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                        : config.mode === 'test'
                          ? 'bg-blue-500/15 text-blue-300 border border-blue-500/30'
                          : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                    }`}
                  >
                    {config.mode === 'live'
                      ? 'LIVE MODE'
                      : config.mode === 'test'
                        ? 'TEST MODE'
                        : 'SETUP NEEDED'}
                  </span>
                )}
              </div>
              <h3 className="font-display font-bold text-xl sm:text-2xl text-white">
                Book Your Website Project
              </h3>
              <p className="text-xs text-[#B7C0CE]">
                Pay securely via UPI, Cards, Netbanking or Wallets with cryptographic server verification.
              </p>
            </div>

            {!isOnline && (
              <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/40 text-xs text-amber-200 flex items-start gap-2">
                <WifiOff className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <span>
                  You are offline. Online payments require an active internet connection and cannot be processed or confirmed offline.
                </span>
              </div>
            )}

            {config && !config.configured && (
              <div className="p-3.5 rounded-xl bg-[#101827] border border-amber-500/40 text-xs text-slate-300 space-y-1.5">
                <div className="font-semibold text-amber-300 flex items-center gap-1.5">
                  <Lock className="w-3.5 h-3.5" />
                  <span>Razorpay Gateway Awaiting Server Keys</span>
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Add <code className="text-[#D6B46A]">RAZORPAY_KEY_ID</code>,{' '}
                  <code className="text-[#D6B46A]">RAZORPAY_KEY_SECRET</code>, and{' '}
                  <code className="text-[#D6B46A]">RAZORPAY_WEBHOOK_SECRET</code> to your server{' '}
                  <code className="text-white">.env</code> or Cloudflare Pages Secrets to activate live/test checkout.
                </p>
              </div>
            )}

            {pendingOrderId && isOnline && (
              <div className="p-3 rounded-xl bg-blue-500/10 border border-blue-500/30 flex items-center justify-between gap-2 text-xs">
                <span className="text-blue-200 truncate">
                  Previous order: <strong className="font-mono">{pendingOrderId}</strong>
                </span>
                <button
                  type="button"
                  onClick={() => checkPendingOrderStatus(pendingOrderId)}
                  disabled={isProcessing}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#3185FF] text-white font-semibold text-[11px] shrink-0 cursor-pointer"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>Check Status</span>
                </button>
              </div>
            )}

            {errorMsg && (
              <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{errorMsg}</span>
              </div>
            )}

            {/* Package Selection */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-slate-300 block">
                Select Booking / Advance Option
              </label>
              {loadingConfig && !config ? (
                <div className="text-xs text-slate-400 flex items-center gap-2 py-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Loading secure payment catalog...</span>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2">
                  {(config?.catalog || []).map((pkg) => {
                    const active = selectedPackageId === pkg.id;
                    return (
                      <button
                        key={pkg.id}
                        type="button"
                        onClick={() => setSelectedPackageId(pkg.id)}
                        className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                          active
                            ? 'bg-[#D6B46A]/10 border-[#D6B46A] text-white'
                            : 'bg-[#101827] border-slate-800 text-slate-300 hover:border-slate-700'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-xs sm:text-sm">{pkg.name}</span>
                          <span className="font-mono font-bold text-[#D6B46A] text-sm shrink-0">
                            ₹{pkg.amountInr.toLocaleString('en-IN')}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-400 mt-1">{pkg.description}</p>
                      </button>
                    );
                  })}

                  <button
                    type="button"
                    onClick={() => setSelectedPackageId('custom-milestone')}
                    className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                      selectedPackageId === 'custom-milestone'
                        ? 'bg-[#D6B46A]/10 border-[#D6B46A] text-white'
                        : 'bg-[#101827] border-slate-800 text-slate-300 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-xs sm:text-sm">
                        Custom Milestone / Invoice Amount
                      </span>
                      <span className="font-mono text-xs text-[#3185FF]">₹100 – ₹5,00,000</span>
                    </div>
                  </button>
                </div>
              )}

              {selectedPackageId === 'custom-milestone' && (
                <div>
                  <label className="text-xs font-medium text-slate-300 block mb-1">
                    Amount in INR (₹)
                  </label>
                  <input
                    type="number"
                    min={100}
                    max={500000}
                    required
                    value={customAmountInr}
                    onChange={(e) => setCustomAmountInr(e.target.value)}
                    className="w-full px-3.5 py-2 rounded-xl bg-[#101827] border border-slate-800 text-sm text-white focus:outline-hidden focus:border-[#D6B46A]"
                  />
                </div>
              )}
            </div>

            {/* Customer Inputs */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-slate-300 block mb-1">Full Name *</label>
                <input
                  type="text"
                  required
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="e.g. Rahul Sharma"
                  className="w-full px-3.5 py-2 rounded-xl bg-[#101827] border border-slate-800 text-sm text-white placeholder-slate-500 focus:outline-hidden focus:border-[#D6B46A]"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-300 block mb-1">Mobile Number *</label>
                <input
                  type="tel"
                  required
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                  placeholder="10-digit mobile"
                  className="w-full px-3.5 py-2 rounded-xl bg-[#101827] border border-slate-800 text-sm text-white placeholder-slate-500 focus:outline-hidden focus:border-[#D6B46A]"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-slate-300 block mb-1">Email Address *</label>
                <input
                  type="email"
                  required
                  value={customerEmail}
                  onChange={(e) => setCustomerEmail(e.target.value)}
                  placeholder="receipt@email.com"
                  className="w-full px-3.5 py-2 rounded-xl bg-[#101827] border border-slate-800 text-sm text-white placeholder-slate-500 focus:outline-hidden focus:border-[#D6B46A]"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-300 block mb-1">Business Name</label>
                <input
                  type="text"
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  placeholder="Optional"
                  className="w-full px-3.5 py-2 rounded-xl bg-[#101827] border border-slate-800 text-sm text-white placeholder-slate-500 focus:outline-hidden focus:border-[#D6B46A]"
                />
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-slate-300 block mb-1">
                Project / Service Reference
              </label>
              <input
                type="text"
                value={serviceName}
                onChange={(e) => setServiceName(e.target.value)}
                className="w-full px-3.5 py-2 rounded-xl bg-[#101827] border border-slate-800 text-sm text-white focus:outline-hidden focus:border-[#D6B46A]"
              />
            </div>

            <div className="pt-2 flex flex-col sm:flex-row items-center gap-3">
              <button
                type="submit"
                disabled={isProcessing || !isOnline || (config !== null && !config.configured)}
                className="w-full sm:flex-1 py-3.5 px-5 rounded-xl text-xs font-bold uppercase tracking-wider text-[#080B12] bg-[#D6B46A] hover:bg-[#F0DCAB] transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Initializing Secure Checkout...</span>
                  </>
                ) : (
                  <>
                    <ShieldCheck className="w-4 h-4" />
                    <span>Pay ₹{displayAmountInr.toLocaleString('en-IN')} via Razorpay</span>
                  </>
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
