/**
 * IndexedDB Offline Storage, Form Draft Preservation, Scroll/State Restoration,
 * and Non-Payment Enquiry Sync Queue for DIGI TECH SOLUTION.
 *
 * IMPORTANT SECURITY RULE:
 * Never queues or confirms payment requests offline. Only non-payment enquiry/quote
 * forms may be queued offline and synced with an idempotencyKey upon reconnection.
 */

import { postJsonSafely } from './apiClient';

const DB_NAME = 'dts_offline_db';
const DB_VERSION = 1;
const STORE_DRAFTS = 'drafts';
const STORE_QUEUE = 'syncQueue';
const PAGE_STATE_KEY = 'dts_page_state_v1';

export interface QueuedEnquiryItem {
  idempotencyKey: string;
  endpoint: '/api/contact' | '/api/quote';
  payload: Record<string, unknown>;
  createdAt: string;
  attempts: number;
  lastError?: string;
}

export interface PersistedPageState {
  scrollY: number;
  activeHash?: string;
  isQuoteModalOpen?: boolean;
  isPaymentModalOpen?: boolean;
  updatedAt: string;
}

function openOfflineDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_DRAFTS)) {
        db.createObjectStore(STORE_DRAFTS, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { keyPath: 'idempotencyKey' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function notifyQueueUpdated(eventDetail?: { syncedCount?: number; lastError?: string }) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('dts-offline-queue-updated', { detail: eventDetail || {} }));
  }
}

export async function saveFormDraft<T>(key: string, data: T): Promise<void> {
  try {
    const db = await openOfflineDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_DRAFTS, 'readwrite');
      tx.objectStore(STORE_DRAFTS).put({
        key,
        data,
        updatedAt: new Date().toISOString(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Fallback to sessionStorage if IndexedDB blocked in private browsing
    try {
      sessionStorage.setItem(`dts_draft_${key}`, JSON.stringify(data));
    } catch {
      // Ignore storage quota errors
    }
  }
}

export async function loadFormDraft<T>(key: string): Promise<T | null> {
  try {
    const db = await openOfflineDb();
    const record = await new Promise<{ key: string; data: T } | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_DRAFTS, 'readonly');
      const req = tx.objectStore(STORE_DRAFTS).get(key);
      req.onsuccess = () => resolve(req.result as { key: string; data: T } | undefined);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (record?.data) return record.data;
  } catch {
    // Check sessionStorage fallback
  }

  try {
    const raw = sessionStorage.getItem(`dts_draft_${key}`);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function clearFormDraft(key: string): Promise<void> {
  try {
    const db = await openOfflineDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_DRAFTS, 'readwrite');
      tx.objectStore(STORE_DRAFTS).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Ignore
  }
  try {
    sessionStorage.removeItem(`dts_draft_${key}`);
  } catch {
    // Ignore
  }
}

export async function enqueueOfflineEnquiry(item: {
  idempotencyKey: string;
  endpoint: '/api/contact' | '/api/quote';
  payload: Record<string, unknown>;
}): Promise<boolean> {
  // Safety invariant: strictly reject any payment endpoints
  if (item.endpoint !== '/api/contact' && item.endpoint !== '/api/quote') {
    throw new Error('Payments cannot be queued or confirmed offline.');
  }

  try {
    const db = await openOfflineDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_QUEUE, 'readwrite');
      const entry: QueuedEnquiryItem = {
        idempotencyKey: item.idempotencyKey,
        endpoint: item.endpoint,
        payload: {
          ...item.payload,
          idempotencyKey: item.idempotencyKey,
          source: 'offline_sync',
        },
        createdAt: new Date().toISOString(),
        attempts: 0,
      };
      tx.objectStore(STORE_QUEUE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    notifyQueueUpdated();
    return true;
  } catch {
    return false;
  }
}

export async function listQueuedEnquiries(): Promise<QueuedEnquiryItem[]> {
  try {
    const db = await openOfflineDb();
    const items = await new Promise<QueuedEnquiryItem[]>((resolve, reject) => {
      const tx = db.transaction(STORE_QUEUE, 'readonly');
      const req = tx.objectStore(STORE_QUEUE).getAll();
      req.onsuccess = () => resolve((req.result as QueuedEnquiryItem[]) || []);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return items;
  } catch {
    return [];
  }
}

async function removeQueuedEnquiry(idempotencyKey: string): Promise<void> {
  try {
    const db = await openOfflineDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_QUEUE, 'readwrite');
      tx.objectStore(STORE_QUEUE).delete(idempotencyKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Ignore
  }
}

async function updateQueuedEnquiryAttempt(item: QueuedEnquiryItem): Promise<void> {
  try {
    const db = await openOfflineDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_QUEUE, 'readwrite');
      tx.objectStore(STORE_QUEUE).put(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Ignore
  }
}

let isSyncingQueue = false;

export async function flushOfflineEnquiryQueue(): Promise<{
  syncedCount: number;
  remainingCount: number;
}> {
  if (isSyncingQueue || (typeof navigator !== 'undefined' && !navigator.onLine)) {
    const items = await listQueuedEnquiries();
    return { syncedCount: 0, remainingCount: items.length };
  }

  isSyncingQueue = true;
  let syncedCount = 0;

  try {
    const items = await listQueuedEnquiries();
    for (const item of items) {
      const res = await postJsonSafely<{
        success?: boolean;
        emailSent?: boolean;
        savedLocally?: boolean;
        error?: string;
        message?: string;
      }>(item.endpoint, item.payload, {
        'x-idempotency-key': item.idempotencyKey,
      });

      if ((res.ok && res.data?.success) || res.data?.savedLocally) {
        await removeQueuedEnquiry(item.idempotencyKey);
        syncedCount += 1;
      } else if (res.status === 400) {
        // Validation error will not pass on retry; remove stale malformed entry
        await removeQueuedEnquiry(item.idempotencyKey);
      } else {
        await updateQueuedEnquiryAttempt({
          ...item,
          attempts: item.attempts + 1,
          lastError: res.data?.message || res.message || res.error || 'Sync pending',
        });
      }
    }

    const remaining = await listQueuedEnquiries();
    notifyQueueUpdated({ syncedCount });
    return { syncedCount, remainingCount: remaining.length };
  } finally {
    isSyncingQueue = false;
  }
}

export function savePageState(state: Partial<PersistedPageState>): void {
  try {
    const currentRaw = sessionStorage.getItem(PAGE_STATE_KEY);
    const current: PersistedPageState = currentRaw
      ? JSON.parse(currentRaw)
      : { scrollY: 0, updatedAt: new Date().toISOString() };
    const next: PersistedPageState = {
      ...current,
      ...state,
      updatedAt: new Date().toISOString(),
    };
    sessionStorage.setItem(PAGE_STATE_KEY, JSON.stringify(next));
  } catch {
    // Ignore
  }
}

export function loadPageState(): PersistedPageState | null {
  try {
    const raw = sessionStorage.getItem(PAGE_STATE_KEY);
    return raw ? (JSON.parse(raw) as PersistedPageState) : null;
  } catch {
    return null;
  }
}
