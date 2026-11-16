import React, { useEffect, useState } from 'react';
import { WifiOff, RefreshCw, CheckCircle2 } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { flushOfflineEnquiryQueue, listQueuedEnquiries } from '../utils/offlineSync';

export const OfflineStatusBanner: React.FC = () => {
  const isOnline = useOnlineStatus();
  const [queuedCount, setQueuedCount] = useState(0);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  const refreshQueueCount = async () => {
    const items = await listQueuedEnquiries();
    setQueuedCount(items.length);
  };

  useEffect(() => {
    refreshQueueCount();

    const handleQueueEvent = (ev: Event) => {
      const detail = (ev as CustomEvent<{ syncedCount?: number }>).detail;
      refreshQueueCount();
      if (detail?.syncedCount && detail.syncedCount > 0) {
        setSyncNotice(
          `Connection restored — synced ${detail.syncedCount} queued ${
            detail.syncedCount === 1 ? 'enquiry' : 'enquiries'
          } safely.`
        );
        setTimeout(() => setSyncNotice(null), 6000);
      }
    };

    window.addEventListener('dts-offline-queue-updated', handleQueueEvent);
    return () => {
      window.removeEventListener('dts-offline-queue-updated', handleQueueEvent);
    };
  }, []);

  useEffect(() => {
    if (isOnline && queuedCount > 0) {
      setIsSyncing(true);
      flushOfflineEnquiryQueue().finally(() => {
        setIsSyncing(false);
        refreshQueueCount();
      });
    }
  }, [isOnline, queuedCount]);

  if (!isOnline) {
    return (
      <div
        role="status"
        className="fixed bottom-5 left-4 right-20 sm:right-auto sm:max-w-md z-40 flex items-start gap-2.5 rounded-xl bg-amber-950/95 border border-amber-500/50 px-3.5 py-2.5 text-xs text-amber-100 shadow-2xl backdrop-blur-md"
      >
        <WifiOff className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
        <div className="space-y-0.5">
          <div className="font-semibold text-amber-300">Offline Mode Active</div>
          <div className="text-[11px] text-amber-100/90 leading-snug">
            Cached pages & saved form drafts remain safe. Online payments require internet;{' '}
            {queuedCount > 0
              ? `${queuedCount} non-payment ${queuedCount === 1 ? 'enquiry is' : 'enquiries are'} queued for auto-sync.`
              : 'enquiries will sync when back online.'}
          </div>
        </div>
      </div>
    );
  }

  if (isSyncing) {
    return (
      <div
        role="status"
        className="fixed bottom-5 left-4 z-40 flex items-center gap-2 rounded-xl bg-[#0E1626] border border-[#3185FF]/50 px-3.5 py-2 text-xs text-blue-200 shadow-xl"
      >
        <RefreshCw className="w-3.5 h-3.5 animate-spin text-[#3185FF]" />
        <span>Syncing pending enquiries...</span>
      </div>
    );
  }

  if (syncNotice) {
    return (
      <div
        role="status"
        className="fixed bottom-5 left-4 z-40 flex items-center gap-2 rounded-xl bg-emerald-950/95 border border-emerald-500/50 px-3.5 py-2 text-xs text-emerald-200 shadow-xl"
      >
        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
        <span>{syncNotice}</span>
      </div>
    );
  }

  return null;
};
