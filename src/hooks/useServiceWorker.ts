/**
 * Service Worker Registration + PWA Install Hook
 * 
 * Registers the SW on app load, handles updates,
 * and provides install prompt for PWA.
 */

'use client';

import { useEffect, useState, useCallback } from 'react';
import { forcSync } from '@/lib/offline';

export function useServiceWorker() {
  const [isInstallable, setIsInstallable] = useState(false);
  const [isInstalled, setIsInstalled] = useState(false);
  const [swRegistration, setSwRegistration] = useState<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

    // Check if already installed as PWA
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
      || (navigator as any).standalone === true;
    setIsInstalled(isStandalone);

    // Register Service Worker
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => {
        setSwRegistration(reg);
        console.log('[PWA] Service Worker registered');

        // Check for updates periodically
        setInterval(() => reg.update(), 60 * 60 * 1000); // hourly

        // Handle SW messages
        navigator.serviceWorker.addEventListener('message', (event) => {
          if (event.data?.type === 'SYNC_REQUESTED') {
            forcSync();
          }
        });
      })
      .catch((err) => {
        console.warn('[PWA] SW registration failed:', err);
      });

    // Capture install prompt
    const handleInstallPrompt = (e: Event) => {
      e.preventDefault();
      (window as any).__pwaInstallPrompt = e;
      setIsInstallable(true);
    };

    window.addEventListener('beforeinstallprompt', handleInstallPrompt);
    return () => window.removeEventListener('beforeinstallprompt', handleInstallPrompt);
  }, []);

  const promptInstall = useCallback(async () => {
    const prompt = (window as any).__pwaInstallPrompt;
    if (!prompt) return false;
    prompt.prompt();
    const result = await prompt.userChoice;
    setIsInstallable(false);
    return result.outcome === 'accepted';
  }, []);

  // Register for background sync
  const registerBackgroundSync = useCallback(async () => {
    if (swRegistration && 'sync' in swRegistration) {
      try {
        await (swRegistration as any).sync.register('opsos-sync');
      } catch { /* background sync not supported */ }
    }
  }, [swRegistration]);

  return {
    isInstallable,
    isInstalled,
    promptInstall,
    registerBackgroundSync,
  };
}
