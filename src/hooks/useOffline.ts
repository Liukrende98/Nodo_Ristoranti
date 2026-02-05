/**
 * useOffline — Main hook for offline-first data access
 * 
 * Provides:
 *   1. Reactive local data (re-renders when IndexedDB changes)
 *   2. Sync status (online/offline/syncing + pending count)
 *   3. Optimistic actions (instant, queue in background)
 * 
 * Usage:
 *   const { tasks, syncState, actions } = useOffline();
 *   // tasks comes from IndexedDB — instant, works offline
 *   // actions.completeTask() updates local + queues sync
 *   // syncState shows connection & pending events
 */

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  getLocalDB,
  startSyncEngine,
  stopSyncEngine,
  onSyncStateChange,
  type SyncState,
  type LocalOrder,
  type LocalTask,
  type LocalSubtask,
  type LocalStation,
  type LocalMenuItem,
  type LocalDelivery,
  type LocalInventoryItem,
  type LocalUser,
  // Actions
  createOrderOffline,
  startTaskOffline,
  completeTaskOffline,
  completeSubtaskOffline,
  assignDeliveryOffline,
  pickupDeliveryOffline,
  deliverDeliveryOffline,
  adjustInventoryOffline,
  type CreateOrderInput,
} from '@/lib/offline';
import { useAuth } from './useAuth';

// ─── Sync Status Hook ────────────────────────────────────

export function useSyncState(): SyncState {
  const [state, setState] = useState<SyncState>({
    status: 'online',
    pendingCount: 0,
    failedCount: 0,
    lastSyncAt: null,
    lastError: null,
  });

  useEffect(() => {
    const unsub = onSyncStateChange(setState);
    return unsub;
  }, []);

  return state;
}

// ─── Sync Engine Lifecycle ───────────────────────────────

export function useSyncEngine(): void {
  const { user } = useAuth();
  const started = useRef(false);

  useEffect(() => {
    if (!user || started.current) return;
    started.current = true;

    startSyncEngine(() => ({
      // Auth headers for sync requests
      // Cookies handle auth, but add tenant context
    }));

    return () => {
      stopSyncEngine();
      started.current = false;
    };
  }, [user]);
}

// ─── Data Queries (Reactive via Dexie Live Query) ────────

export function useLocalOrders(status?: string | string[]) {
  const { user } = useAuth();
  const tenantId = user?.tenantId;

  return useLiveQuery(async () => {
    if (!tenantId) return [];
    const db = getLocalDB();

    let query = db.orders.where('tenantId').equals(tenantId);

    let orders = await query.reverse().sortBy('createdAt');

    if (status) {
      const statuses = Array.isArray(status) ? status : [status];
      orders = orders.filter((o) => statuses.includes(o.status));
    }

    // Sort: priority desc, then createdAt desc
    orders.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return b.createdAt.localeCompare(a.createdAt);
    });

    // Attach items
    const enriched = await Promise.all(
      orders.map(async (order) => {
        const items = await db.orderItems
          .where('orderId')
          .equals(order.id)
          .toArray();
        return { ...order, items };
      })
    );

    return enriched;
  }, [tenantId, status]) ?? [];
}

export function useLocalTasks(filters?: {
  stationId?: string;
  status?: string | string[];
  orderId?: string;
}) {
  const { user } = useAuth();
  const tenantId = user?.tenantId;
  const stationId = filters?.stationId;
  const status = filters?.status;
  const orderId = filters?.orderId;

  return useLiveQuery(async () => {
    if (!tenantId) return [];
    const db = getLocalDB();

    let tasks: LocalTask[];

    if (stationId && stationId !== 'all') {
      tasks = await db.tasks
        .where('[stationId+status]')
        .between([stationId, ''], [stationId, '\uffff'])
        .toArray();
      tasks = tasks.filter((t) => t.tenantId === tenantId);
    } else if (orderId) {
      tasks = await db.tasks
        .where('[orderId+tenantId]')
        .equals([orderId, tenantId])
        .toArray();
    } else {
      tasks = await db.tasks.where('tenantId').equals(tenantId).toArray();
    }

    // Filter by status
    if (status) {
      const statuses = Array.isArray(status) ? status : status.split(',');
      tasks = tasks.filter((t) => statuses.includes(t.status));
    }

    // Attach subtasks
    const enriched = await Promise.all(
      tasks.map(async (task) => {
        const subtasks = await db.subtasks
          .where('taskInstanceId')
          .equals(task.id)
          .toArray();
        return { ...task, subtasks };
      })
    );

    // Sort: order priority desc, then createdAt asc
    enriched.sort((a, b) => {
      // Station grouping
      const priority = (b._orderNumber || 0) - (a._orderNumber || 0);
      if (priority !== 0) return 0; // Keep original order within same priority
      return 0;
    });

    return enriched;
  }, [tenantId, stationId, status, orderId]) ?? [];
}

export function useLocalStations() {
  const { user } = useAuth();
  const tenantId = user?.tenantId;

  return useLiveQuery(async () => {
    if (!tenantId) return [];
    const db = getLocalDB();
    return db.stations
      .where('tenantId')
      .equals(tenantId)
      .filter((s) => s.isActive)
      .sortBy('displayOrder');
  }, [tenantId]) ?? [];
}

export function useLocalMenu() {
  const { user } = useAuth();
  const tenantId = user?.tenantId;

  return useLiveQuery(async () => {
    if (!tenantId) return { items: [] as LocalMenuItem[], categories: [] as string[] };
    const db = getLocalDB();
    const items = await db.menuItems
      .where('tenantId')
      .equals(tenantId)
      .filter((m) => m.isAvailable)
      .sortBy('displayOrder');

    const categories = [...new Set(items.map((i) => i.category || 'Altro'))];

    return { items, categories };
  }, [tenantId]) ?? { items: [], categories: [] };
}

export function useLocalDeliveries(status?: string) {
  const { user } = useAuth();
  const tenantId = user?.tenantId;

  return useLiveQuery(async () => {
    if (!tenantId) return [];
    const db = getLocalDB();
    let deliveries = await db.deliveries
      .where('tenantId')
      .equals(tenantId)
      .toArray();

    if (status) {
      deliveries = deliveries.filter((d) => d.status === status);
    }

    // For delivery role, filter to own assignments
    if (user?.role === 'delivery') {
      deliveries = deliveries.filter((d) => d.riderId === user.id || !d.riderId);
    }

    return deliveries;
  }, [tenantId, status, user?.role, user?.id]) ?? [];
}

export function useLocalInventory() {
  const { user } = useAuth();
  const tenantId = user?.tenantId;

  return useLiveQuery(async () => {
    if (!tenantId) return [];
    const db = getLocalDB();
    return db.inventoryItems
      .where('tenantId')
      .equals(tenantId)
      .sortBy('name');
  }, [tenantId]) ?? [];
}

export function useLocalUsers(role?: string) {
  const { user } = useAuth();
  const tenantId = user?.tenantId;

  return useLiveQuery(async () => {
    if (!tenantId) return [];
    const db = getLocalDB();
    let users = await db.users.where('tenantId').equals(tenantId).toArray();
    if (role) users = users.filter((u) => u.role === role);
    return users;
  }, [tenantId, role]) ?? [];
}

// ─── Actions Hook ────────────────────────────────────────

export function useOfflineActions() {
  const { user } = useAuth();

  const withAuth = useCallback(
    <T extends any[], R>(fn: (tenantId: string, userId: string, ...args: T) => Promise<R>) => {
      return async (...args: T): Promise<R> => {
        if (!user) throw new Error('Non autenticato');
        return fn(user.tenantId, user.id, ...args);
      };
    },
    [user]
  );

  return {
    createOrder: withAuth(createOrderOffline),
    startTask: withAuth(startTaskOffline),
    completeTask: withAuth(completeTaskOffline),
    completeSubtask: withAuth(completeSubtaskOffline),
    assignDelivery: withAuth(assignDeliveryOffline),
    pickupDelivery: withAuth(pickupDeliveryOffline),
    deliverDelivery: withAuth(deliverDeliveryOffline),
    adjustInventory: withAuth(adjustInventoryOffline),
  };
}
