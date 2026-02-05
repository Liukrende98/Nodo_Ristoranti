/**
 * SyncStatus — Discrete sync indicator
 * 
 * Design principles:
 *   - NEVER alarming. Offline is NORMAL operation.
 *   - Small, unobtrusive, corner of screen
 *   - Green dot = synced, yellow = syncing, gray = offline
 *   - Expand on tap for details
 *   - Never blocks workflow
 */

'use client';

import { useState } from 'react';
import { useSyncState } from '@/hooks/useOffline';
import { forcSync } from '@/lib/offline';

export function SyncIndicator() {
  const syncState = useSyncState();
  const [expanded, setExpanded] = useState(false);

  const statusConfig = {
    online: { color: 'bg-emerald-500', label: 'Sincronizzato', icon: '●' },
    syncing: { color: 'bg-amber-500 animate-pulse', label: 'Sincronizzazione...', icon: '◌' },
    offline: { color: 'bg-gray-400', label: 'Offline — tutto funziona', icon: '●' },
  };

  const config = statusConfig[syncState.status];
  const hasPending = syncState.pendingCount > 0;
  const hasFailed = syncState.failedCount > 0;

  return (
    <div className="relative">
      {/* Compact indicator */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors"
        title={config.label}
      >
        <span className={`w-2 h-2 rounded-full ${config.color}`} />
        {syncState.status === 'offline' && (
          <span className="text-gray-400">Offline</span>
        )}
        {hasPending && syncState.status !== 'offline' && (
          <span className="text-amber-600">{syncState.pendingCount}</span>
        )}
      </button>

      {/* Expanded panel */}
      {expanded && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setExpanded(false)}
          />
          <div className="absolute right-0 top-full mt-2 z-50 w-72 bg-white rounded-xl shadow-lg border border-gray-200 p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className={`w-3 h-3 rounded-full ${config.color}`} />
              <span className="font-medium text-sm text-gray-900">
                {config.label}
              </span>
            </div>

            <div className="space-y-2 text-sm">
              {syncState.status === 'offline' && (
                <p className="text-gray-600">
                  L&apos;app funziona normalmente. Le modifiche verranno sincronizzate
                  automaticamente al ritorno della connessione.
                </p>
              )}

              {hasPending && (
                <div className="flex items-center justify-between text-gray-600">
                  <span>Modifiche in attesa</span>
                  <span className="font-mono bg-amber-50 text-amber-700 px-2 py-0.5 rounded">
                    {syncState.pendingCount}
                  </span>
                </div>
              )}

              {hasFailed && (
                <div className="flex items-center justify-between text-gray-600">
                  <span>Tentativi falliti</span>
                  <span className="font-mono bg-red-50 text-red-600 px-2 py-0.5 rounded">
                    {syncState.failedCount}
                  </span>
                </div>
              )}

              {syncState.lastSyncAt && (
                <div className="text-xs text-gray-400">
                  Ultimo sync: {new Date(syncState.lastSyncAt).toLocaleTimeString('it-IT')}
                </div>
              )}

              {syncState.lastError && (
                <div className="text-xs text-red-400 truncate" title={syncState.lastError}>
                  {syncState.lastError}
                </div>
              )}

              {syncState.status === 'online' && (hasPending || hasFailed) && (
                <button
                  onClick={() => forcSync()}
                  className="w-full btn-secondary btn-sm mt-2"
                >
                  Sincronizza ora
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Minimal inline sync dot — for headers/toolbars
 */
export function SyncDot() {
  const syncState = useSyncState();

  const colors = {
    online: 'bg-emerald-500',
    syncing: 'bg-amber-500 animate-pulse',
    offline: 'bg-gray-400',
  };

  return (
    <span
      className={`w-2 h-2 rounded-full inline-block ${colors[syncState.status]}`}
      title={syncState.status === 'offline' ? 'Offline — tutto funziona' : syncState.status}
    />
  );
}
