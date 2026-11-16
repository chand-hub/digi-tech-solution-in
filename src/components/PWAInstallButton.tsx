import React, { useState } from 'react';
import { Download, Smartphone, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  compact?: boolean;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({ compact = false }) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className={`inline-flex items-center justify-center gap-1.5 rounded-lg border border-[#3185FF]/40 bg-[#3185FF]/10 text-[#93C5FD] hover:bg-[#3185FF]/20 hover:text-white transition-colors cursor-pointer whitespace-nowrap ${
          compact ? 'px-2.5 py-1.5 text-[11px] font-semibold' : 'w-full py-2.5 px-4 text-xs font-semibold'
        }`}
        title="Install DIGI TECH SOLUTION App"
      >
        <Download className="w-3.5 h-3.5 shrink-0" />
        <span>Install App</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className={`inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/60 text-slate-200 hover:text-white hover:border-slate-600 transition-colors cursor-pointer whitespace-nowrap ${
            compact ? 'px-2.5 py-1.5 text-[11px] font-medium' : 'w-full py-2.5 px-4 text-xs font-medium'
          }`}
        >
          <Smartphone className="w-3.5 h-3.5 shrink-0" />
          <span>Install on iOS</span>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
            <div className="w-full max-w-sm rounded-2xl bg-[#0E1626] border border-slate-700 p-6 shadow-2xl space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-display font-bold text-lg text-white">Install on iPhone / iPad</h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
                  aria-label="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <p className="text-xs sm:text-sm text-[#B7C0CE] leading-relaxed">
                1. Tap the <strong className="text-white">Share</strong> button in your Safari toolbar.
                <br />
                2. Scroll down and tap <strong className="text-[#D6B46A]">Add to Home Screen</strong>.
              </p>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="w-full rounded-xl bg-[#D6B46A] text-[#080B12] py-2.5 text-xs font-bold uppercase tracking-wider cursor-pointer"
              >
                Got It
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
