/**
 * SYNC ENGINE — Background synchronization
 * 
 * Responsibilities:
 *   1. Push local events to server (in order)
 *   2. Pull server state into local DB
 *   3. Handle conflicts (server-authoritative)
 *   4. Retry failed events with exponential backoff
 *   5. Track online/offline status
 * 
 * Design principles:
 *   - Never blocks UI
 *   - Silent failures (retried later)
 *   - Server is authoritative for final state
 *   - Local events are authoritative for ordering
 *   - Idempotent sync operations (safe to retry)
 */

import { getLocalDB } from './db';
import {
  getPendingEvents,
  getFailedEvents,
  markEventSyncing,
  markEventSynced,
  markEventFailed,
  cleanupSyncedEvents,
  onSyncNeeded,
  EVENT_TYPES,
} from './event-queue';

// ─── Types ───────────────────────────────────────────────

export type ConnectionStatus = 'online' | 'offline' | 'syncing';

export interface SyncState {
  status: ConnectionStatus;
  pendingCount: number;
  failedCount: number;
  lastSyncAt: string | null;
  lastError: string | null;
}

type SyncStateListener = (state: SyncState) => void;

// ─── State ───────────────────────────────────────────────

let currentState: SyncState = {
  status: typeof navigator !== 'undefined' && navigator.onLine ? 'online' : 'offline',
  pendingCount: 0,
  failedCount: 0,
  lastSyncAt: null,
  lastError: null,
};

const stateListeners: Set<SyncStateListener> = new Set();
let syncInterval: ReturnType<typeof setInterval> | null = null;
let isSyncing = false;
let pullInterval: ReturnType<typeof setInterval> | null = null;

// ─── Public API ──────────────────────────────────────────

/**
 * Subscribe to sync state changes
 */
export function onSyncStateChange(listener: SyncStateListener): () => void {
  stateListeners.add(listener);
  listener(currentState); // Immediate current state
  return () => stateListeners.delete(listener);
}

/**
 * Get current sync state
 */
export function getSyncState(): SyncState {
  return { ...currentState };
}

/**
 * Start the sync engine. Call once on app boot.
 */
export function startSyncEngine(getAuthHeaders: () => Record<string, string>): void {
  if (typeof window === 'undefined') return; // SSR guard

  authHeadersFn = getAuthHeaders;

  // Listen for online/offline
  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);

  // Listen for new events from the queue
  onSyncNeeded(() => {
    updatePendingCount();
    if (navigator.onLine && !isSyncing) {
      schedulePush();
    }
  });

  // Periodic push (every 5s when online)
  syncInterval = setInterval(() => {
    if (navigator.onLine && !isSyncing) {
      pushEvents();
    }
  }, 5000);

  // Periodic pull (every 15s when online) — sync server state
  pullInterval = setInterval(() => {
    if (navigator.onLine && !isSyncing) {
      pullServerState();
    }
  }, 15000);

  // Periodic cleanup (every 5 min)
  setInterval(() => {
    cleanupSyncedEvents(24).catch(() => {});
  }, 5 * 60 * 1000);

  // Initial state
  updatePendingCount();

  // If online, do initial sync
  if (navigator.onLine) {
    setTimeout(() => {
      pushEvents();
      pullServerState();
    }, 1000);
  }
}

/**
 * Stop the sync engine (for cleanup)
 */
export function stopSyncEngine(): void {
  if (typeof window === 'undefined') return;
  window.removeEventListener('online', handleOnline);
  window.removeEventListener('offline', handleOffline);
  if (syncInterval) clearInterval(syncInterval);
  if (pullInterval) clearInterval(pullInterval);
}

/**
 * Force an immediate sync attempt
 */
export function forcSync(): void {
  if (navigator.onLine) {
    pushEvents();
    pullServerState();
  }
}

// ─── Internal ────────────────────────────────────────────

let authHeadersFn: () => Record<string, string> = () => ({});
let pushTimeout: ReturnType<typeof setTimeout> | null = null;

function schedulePush(delayMs = 100): void {
  if (pushTimeout) clearTimeout(pushTimeout);
  pushTimeout = setTimeout(() => pushEvents(), delayMs);
}

function setState(partial: Partial<SyncState>): void {
  currentState = { ...currentState, ...partial };
  for (const listener of stateListeners) {
    try { listener(currentState); } catch { /* safe */ }
  }
}

async function updatePendingCount(): Promise<void> {
  try {
    const db = getLocalDB();
    const pending = await db.syncEvents.where('status').equals('pending').count();
    const failed = await db.syncEvents.where('status').equals('failed').count();
    setState({ pendingCount: pending, failedCount: failed });
  } catch { /* ignore */ }
}

function handleOnline(): void {
  setState({ status: 'online' });
  // Immediate sync attempt
  pushEvents();
  pullServerState();
}

function handleOffline(): void {
  setState({ status: 'offline', lastError: null });
}

// ─── Push: Local Events → Server ─────────────────────────

async function pushEvents(): Promise<void> {
  if (isSyncing || !navigator.onLine) return;
  isSyncing = true;
  setState({ status: 'syncing' });

  try {
    // First retry failed events
    const failed = await getFailedEvents(10);
    for (const event of failed) {
      await pushSingleEvent(event.id);
    }

    // Then push pending events (in order)
    const pending = await getPendingEvents(50);
    for (const event of pending) {
      if (!navigator.onLine) break; // Abort if went offline
      await pushSingleEvent(event.id);
    }

    setState({
      status: navigator.onLine ? 'online' : 'offline',
      lastSyncAt: new Date().toISOString(),
      lastError: null,
    });
  } catch (err: any) {
    setState({
      status: navigator.onLine ? 'online' : 'offline',
      lastError: err.message,
    });
  } finally {
    isSyncing = false;
    await updatePendingCount();
  }
}

async function pushSingleEvent(eventId: string): Promise<void> {
  const db = getLocalDB();
  const event = await db.syncEvents.get(eventId);
  if (!event || event.status === 'synced') return;

  await markEventSyncing(eventId);

  try {
    const response = await fetchWithTimeout(
      mapEventToEndpoint(event.type),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeadersFn(),
        },
        body: JSON.stringify(mapEventToPayload(event)),
        credentials: 'include',
      },
      10000 // 10s timeout
    );

    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      await markEventSynced(eventId);

      // If server returned an ID or updated data, update local entity
      if (data.order?.id || data.ok) {
        await reconcileEntity(event, data);
      }
    } else if (response.status === 409) {
      // Conflict — server has a different state
      // Server-authoritative: accept server state
      await markEventSynced(eventId);
      // Pull fresh state for this entity
      await pullEntityState(event.entityType, event.entityId);
    } else if (response.status >= 400 && response.status < 500) {
      // Client error — don't retry (bad data)
      const errData = await response.json().catch(() => ({ error: 'Unknown' }));
      await markEventFailed(eventId, `${response.status}: ${errData.error}`);
    } else {
      // Server error — retry later
      await markEventFailed(eventId, `HTTP ${response.status}`);
    }
  } catch (err: any) {
    // Network error — retry later
    await markEventFailed(eventId, err.message || 'Network error');
  }
}

// ─── Event → API Mapping ─────────────────────────────────

function mapEventToEndpoint(type: string): string {
  const base = '/api';
  switch (type) {
    case EVENT_TYPES.ORDER_CREATE:
      return `${base}/orders`;
    case EVENT_TYPES.ORDER_UPDATE:
    case EVENT_TYPES.ORDER_CANCEL:
      return `${base}/orders`;
    case EVENT_TYPES.TASK_START:
    case EVENT_TYPES.TASK_COMPLETE:
    case EVENT_TYPES.SUBTASK_COMPLETE:
      return `${base}/tasks`;
    case EVENT_TYPES.DELIVERY_ASSIGN:
    case EVENT_TYPES.DELIVERY_PICKUP:
    case EVENT_TYPES.DELIVERY_DELIVER:
      return `${base}/deliveries`;
    case EVENT_TYPES.INVENTORY_ADJUST:
      return `${base}/inventory`;
    default:
      return `${base}/sync/events`;
  }
}

function mapEventToPayload(event: any): any {
  switch (event.type) {
    case EVENT_TYPES.ORDER_CREATE:
      return event.payload; // Already in API format
    case EVENT_TYPES.TASK_START:
      return { taskId: event.entityId, action: 'start' };
    case EVENT_TYPES.TASK_COMPLETE:
      return { taskId: event.entityId, action: 'complete' };
    case EVENT_TYPES.SUBTASK_COMPLETE:
      return {
        taskId: event.payload.taskId,
        action: 'complete_subtask',
        subtaskId: event.entityId,
      };
    case EVENT_TYPES.DELIVERY_ASSIGN:
      return {
        deliveryId: event.entityId,
        action: 'assign',
        riderId: event.payload.riderId,
      };
    case EVENT_TYPES.DELIVERY_PICKUP:
      return { deliveryId: event.entityId, action: 'pickup' };
    case EVENT_TYPES.DELIVERY_DELIVER:
      return { deliveryId: event.entityId, action: 'deliver' };
    case EVENT_TYPES.INVENTORY_ADJUST:
      return {
        action: 'adjust',
        itemId: event.entityId,
        ...event.payload,
      };
    default:
      return event.payload;
  }
}

// ─── Pull: Server State → Local DB ───────────────────────

async function pullServerState(): Promise<void> {
  if (!navigator.onLine) return;

  try {
    // Pull reference data (stations, menu, workflows, users, inventory)
    // These are server-authoritative — overwrite local
    await Promise.allSettled([
      pullCollection('/api/stations', 'stations', (d: any) => d.stations),
      pullCollection('/api/menu', 'menuItems', (d: any) => d.items),
      pullCollection('/api/workflows', 'workflowTemplates', (d: any) => d.templates),
      pullCollection('/api/users', 'users', (d: any) => d.users),
      pullCollection('/api/inventory', 'inventoryItems', (d: any) => d.items),
    ]);

    // Pull active orders + tasks (operational data)
    // Only overwrite items that are fully synced (don't overwrite local changes)
    await pullActiveOrders();
    await pullActiveTasks();
    await pullActiveDeliveries();

  } catch (err) {
    console.warn('[Sync] Pull failed:', err);
  }
}

async function pullCollection(
  endpoint: string,
  tableName: string,
  extractItems: (data: any) => any[]
): Promise<void> {
  try {
    const res = await fetchWithTimeout(endpoint, {
      credentials: 'include',
      headers: authHeadersFn(),
    }, 8000);

    if (!res.ok) return;
    const data = await res.json();
    const items = extractItems(data);
    if (!items?.length) return;

    const db = getLocalDB();
    const table = (db as any)[tableName] as any;

    // Upsert all items with _syncStatus = 'synced'
    const mapped = items.map((item: any) => ({
      ...normalizeItem(item, tableName),
      _syncStatus: 'synced',
    }));

    await table.bulkPut(mapped);
  } catch { /* silent fail — offline or error */ }
}

async function pullActiveOrders(): Promise<void> {
  try {
    const res = await fetchWithTimeout('/api/orders?status=new,preparing,ready,delivering', {
      credentials: 'include',
      headers: authHeadersFn(),
    }, 8000);

    if (!res.ok) return;
    const data = await res.json();
    const db = getLocalDB();

    for (const order of data.orders || []) {
      const existing = await db.orders.get(order.id);

      // Don't overwrite local modifications
      if (existing && existing._syncStatus === 'local') continue;

      await db.orders.put({
        id: order.id,
        tenantId: order.tenantId,
        orderNumber: order.orderNumber,
        channel: order.channel,
        status: order.status,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        customerAddress: order.customerAddress,
        notes: order.notes,
        priority: order.priority,
        requestedAt: order.requestedAt,
        estimatedReadyAt: order.estimatedReadyAt,
        actualReadyAt: order.actualReadyAt,
        totalAmount: order.totalAmount ? Number(order.totalAmount) : undefined,
        createdById: order.createdById,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        _syncStatus: 'synced',
        _serverOrderNumber: order.orderNumber,
      });

      // Upsert order items
      for (const item of order.items || []) {
        await db.orderItems.put({
          id: item.id,
          orderId: item.orderId,
          menuItemId: item.menuItemId,
          tenantId: item.tenantId,
          quantity: item.quantity,
          unitPrice: Number(item.unitPrice),
          modifications: item.modifications,
          notes: item.notes,
          status: item.status,
          _menuItemName: item.menuItem?.name || '',
          _menuItemCategory: item.menuItem?.category,
          _syncStatus: 'synced',
        });
      }
    }
  } catch { /* silent */ }
}

async function pullActiveTasks(): Promise<void> {
  try {
    const res = await fetchWithTimeout('/api/tasks?status=queued,in_progress,pending', {
      credentials: 'include',
      headers: authHeadersFn(),
    }, 8000);

    if (!res.ok) return;
    const data = await res.json();
    const db = getLocalDB();

    for (const task of data.tasks || []) {
      const existing = await db.tasks.get(task.id);
      if (existing && existing._syncStatus !== 'synced') continue;

      await db.tasks.put({
        id: task.id,
        tenantId: task.tenantId,
        orderId: task.orderId,
        orderItemId: task.orderItemId,
        taskDefId: task.taskDefId,
        phaseDefId: task.phaseDefId,
        name: task.name,
        stationId: task.stationId,
        assignedToId: task.assignedToId,
        status: task.status,
        dependsOn: task.dependsOn || [],
        estimatedMinutes: task.estimatedMinutes ? Number(task.estimatedMinutes) : undefined,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        completedById: task.completedById,
        _stationName: task.station?.name,
        _stationColor: (task.station?.settings as any)?.color,
        _orderNumber: task.order?.orderNumber,
        _menuItemName: task.orderItem?.menuItem?.name,
        _assignedToName: task.assignedTo?.name,
        _syncStatus: 'synced',
      });

      // Upsert subtasks
      for (const sub of task.subtasks || []) {
        await db.subtasks.put({
          id: sub.id,
          taskInstanceId: sub.taskInstanceId,
          tenantId: sub.tenantId,
          subtaskDefId: sub.subtaskDefId,
          name: sub.name,
          isCompleted: sub.isCompleted,
          completedAt: sub.completedAt,
          completedById: sub.completedById,
          _syncStatus: 'synced',
        });
      }
    }
  } catch { /* silent */ }
}

async function pullActiveDeliveries(): Promise<void> {
  try {
    const res = await fetchWithTimeout('/api/deliveries', {
      credentials: 'include',
      headers: authHeadersFn(),
    }, 8000);

    if (!res.ok) return;
    const data = await res.json();
    const db = getLocalDB();

    for (const del of data.deliveries || []) {
      const existing = await db.deliveries.get(del.id);
      if (existing && existing._syncStatus !== 'synced') continue;

      await db.deliveries.put({
        id: del.id,
        tenantId: del.tenantId,
        orderId: del.orderId,
        riderId: del.riderId,
        status: del.status,
        assignedAt: del.assignedAt,
        pickedUpAt: del.pickedUpAt,
        deliveredAt: del.deliveredAt,
        notes: del.notes,
        _orderNumber: del.order?.orderNumber,
        _customerName: del.order?.customerName,
        _customerPhone: del.order?.customerPhone,
        _customerAddress: del.order?.customerAddress,
        _riderName: del.rider?.name,
        _syncStatus: 'synced',
      });
    }
  } catch { /* silent */ }
}

// ─── Entity Reconciliation ───────────────────────────────

async function reconcileEntity(event: any, serverData: any): Promise<void> {
  const db = getLocalDB();

  switch (event.entityType) {
    case 'order': {
      if (serverData.order) {
        await db.orders.update(event.entityId, {
          _syncStatus: 'synced',
          _serverId: serverData.order.id,
          _serverOrderNumber: serverData.order.orderNumber,
          orderNumber: serverData.order.orderNumber,
          status: serverData.order.status,
          estimatedReadyAt: serverData.eta?.estimatedReadyAt,
        });
      }
      break;
    }
    case 'task':
    case 'subtask':
      // Task updates are simple — just mark synced
      break;
  }
}

async function pullEntityState(entityType: string, entityId: string): Promise<void> {
  // For conflicts, re-pull the specific entity from server
  // This is a simplified version — in production you'd have per-entity endpoints
  try {
    switch (entityType) {
      case 'order':
        await pullActiveOrders();
        break;
      case 'task':
        await pullActiveTasks();
        break;
      case 'delivery':
        await pullActiveDeliveries();
        break;
    }
  } catch { /* silent */ }
}

// ─── Helpers ─────────────────────────────────────────────

function normalizeItem(item: any, tableName: string): any {
  // Convert Prisma Decimal types to numbers and map field names
  const normalized: any = { ...item };

  // Convert common Decimal fields
  for (const key of ['price', 'currentStock', 'minStock', 'costPerUnit', 'unitPrice', 'totalAmount', 'estimatedMinutes', 'estimatedTotalMinutes']) {
    if (normalized[key] != null) {
      normalized[key] = Number(normalized[key]);
    }
  }

  // Ensure _syncStatus
  if (!normalized._syncStatus) {
    normalized._syncStatus = 'synced';
  }

  return normalized;
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = 10000
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
