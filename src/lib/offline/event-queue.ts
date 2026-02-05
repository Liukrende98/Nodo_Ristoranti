/**
 * EVENT QUEUE — Local-first event sourcing
 * 
 * Every user action becomes an event stored in IndexedDB BEFORE
 * touching the server. This guarantees:
 * 
 *   1. Actions are instant (no network wait)
 *   2. Actions survive page refresh / browser restart
 *   3. Actions sync in order when connection returns
 *   4. Failed syncs retry with exponential backoff
 * 
 * Event lifecycle:
 *   pending → syncing → synced
 *                     → failed (retried)
 *                     → conflict (manual resolution or server-wins)
 */

import { getLocalDB, generateLocalId, type SyncEvent } from './db';

// ─── Sequence Counter ────────────────────────────────────
// Monotonically increasing per session, persisted in sessionStorage

let sequenceCounter = 0;

function getNextSequence(): number {
  sequenceCounter++;
  try {
    sessionStorage.setItem('opsos_seq', String(sequenceCounter));
  } catch { /* SSR or private browsing */ }
  return sequenceCounter;
}

// Restore on load
if (typeof sessionStorage !== 'undefined') {
  try {
    sequenceCounter = parseInt(sessionStorage.getItem('opsos_seq') || '0', 10);
  } catch { /* ignore */ }
}

// ─── Event Types ─────────────────────────────────────────

export const EVENT_TYPES = {
  // Orders
  ORDER_CREATE: 'order.create',
  ORDER_UPDATE: 'order.update',
  ORDER_CANCEL: 'order.cancel',
  // Tasks
  TASK_START: 'task.start',
  TASK_COMPLETE: 'task.complete',
  SUBTASK_COMPLETE: 'subtask.complete',
  // Delivery
  DELIVERY_ASSIGN: 'delivery.assign',
  DELIVERY_PICKUP: 'delivery.pickup',
  DELIVERY_DELIVER: 'delivery.deliver',
  // Inventory
  INVENTORY_ADJUST: 'inventory.adjust',
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

// ─── Enqueue Event ───────────────────────────────────────

/**
 * Add an event to the local queue.
 * This is the ONLY way mutations should enter the system.
 * 
 * @returns The created SyncEvent
 */
export async function enqueueEvent(
  tenantId: string,
  userId: string,
  type: EventType,
  entityType: string,
  entityId: string,
  payload: any
): Promise<SyncEvent> {
  const db = getLocalDB();

  const event: SyncEvent = {
    id: generateLocalId(),
    tenantId,
    userId,
    timestamp: new Date().toISOString(),
    type,
    entityType,
    entityId,
    payload,
    status: 'pending',
    retryCount: 0,
    sequence: getNextSequence(),
  };

  await db.syncEvents.add(event);

  // Notify sync engine that there's work to do
  notifySyncEngine();

  return event;
}

// ─── Query Events ────────────────────────────────────────

/**
 * Get all pending events in order
 */
export async function getPendingEvents(limit = 50): Promise<SyncEvent[]> {
  const db = getLocalDB();
  return db.syncEvents
    .where('status')
    .equals('pending')
    .sortBy('sequence');
}

/**
 * Get failed events for retry
 */
export async function getFailedEvents(limit = 20): Promise<SyncEvent[]> {
  const db = getLocalDB();
  return db.syncEvents
    .where('status')
    .equals('failed')
    .sortBy('sequence');
}

/**
 * Get total counts by status
 */
export async function getEventCounts(): Promise<Record<string, number>> {
  const db = getLocalDB();
  const all = await db.syncEvents.toArray();

  const counts: Record<string, number> = {
    pending: 0,
    syncing: 0,
    synced: 0,
    failed: 0,
    conflict: 0,
  };

  for (const e of all) {
    counts[e.status] = (counts[e.status] || 0) + 1;
  }

  return counts;
}

// ─── Update Event Status ─────────────────────────────────

export async function markEventSyncing(eventId: string): Promise<void> {
  const db = getLocalDB();
  await db.syncEvents.update(eventId, { status: 'syncing' });
}

export async function markEventSynced(eventId: string): Promise<void> {
  const db = getLocalDB();
  await db.syncEvents.update(eventId, {
    status: 'synced',
    syncedAt: new Date().toISOString(),
  });
}

export async function markEventFailed(
  eventId: string,
  error: string
): Promise<void> {
  const db = getLocalDB();
  const event = await db.syncEvents.get(eventId);
  if (!event) return;

  await db.syncEvents.update(eventId, {
    status: event.retryCount >= 5 ? 'conflict' : 'failed',
    lastError: error,
    retryCount: event.retryCount + 1,
  });
}

// ─── Cleanup ─────────────────────────────────────────────

/**
 * Remove synced events older than N hours (keep DB lean)
 */
export async function cleanupSyncedEvents(hoursOld = 24): Promise<number> {
  const db = getLocalDB();
  const cutoff = new Date(Date.now() - hoursOld * 60 * 60 * 1000).toISOString();

  const old = await db.syncEvents
    .where('status')
    .equals('synced')
    .filter((e) => e.syncedAt != null && e.syncedAt < cutoff)
    .toArray();

  await db.syncEvents.bulkDelete(old.map((e) => e.id));
  return old.length;
}

// ─── Sync Engine Notification ────────────────────────────
// Simple pub/sub for notifying the sync engine

type SyncListener = () => void;
const listeners: Set<SyncListener> = new Set();

export function onSyncNeeded(listener: SyncListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifySyncEngine(): void {
  for (const listener of listeners) {
    try { listener(); } catch { /* don't break on listener errors */ }
  }
}
