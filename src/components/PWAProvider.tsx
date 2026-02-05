/**
 * PWAProvider — Initializes offline infrastructure
 * 
 * Wraps the app and handles:
 *   1. Service Worker registration
 *   2. Sync Engine startup
 *   3. PWA install banner (optional)
 *   4. Background sync registration
 */

'use client';

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useServiceWorker } from '@/hooks/useServiceWorker';
import { useSyncEngine } from '@/hooks/useOffline';

export function PWAProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { isInstallable, promptInstall, registerBackgroundSync } = useServiceWorker();
  const [showInstallBanner, setShowInstallBanner] = useState(false);

  // Start sync engine when user is logged in
  useSyncEngine();

  // Register background sync when user is active
  useEffect(() => {
    if (user) {
      registerBackgroundSync();
    }
  }, [user, registerBackgroundSync]);

  // Show install banner after a delay (non-intrusive)
  useEffect(() => {
    if (!isInstallable) return;
    const timer = setTimeout(() => setShowInstallBanner(true), 30000); // 30s delay
    return () => clearTimeout(timer);
  }, [isInstallable]);

  return (
    <>
      {children}

      {/* PWA Install Banner — very discreet */}
      {showInstallBanner && (
        <div className="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:w-80 z-50 bg-white rounded-xl shadow-lg border p-4 flex items-center gap-3 animate-slide-up">
          <div className="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center flex-shrink-0">
            <span className="text-white text-lg">⚡</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-900">Installa OpsOS</p>
            <p className="text-xs text-gray-500">Per accesso rapido e funzionamento offline</p>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            <button
              onClick={() => setShowInstallBanner(false)}
              className="text-xs text-gray-400 hover:text-gray-600"
            >
              Dopo
            </button>
            <button
              onClick={async () => {
                await promptInstall();
                setShowInstallBanner(false);
              }}
              className="btn-primary btn-sm"
            >
              Installa
            </button>
          </div>
        </div>
      )}
    </>
  );
}
