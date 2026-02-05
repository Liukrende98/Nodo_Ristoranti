/**
 * LOCAL DATABASE — IndexedDB via Dexie
 * 
 * This is the SINGLE SOURCE OF TRUTH for the UI.
 * The server is a sync target, not a dependency.
 * 
 * Architecture:
 *   UI ←→ LocalDB (IndexedDB) ←→ SyncEngine → Server
 *   
 * Every read comes from here. Every write goes here FIRST,
 * then gets queued for server sync.
 * 
 * Why Dexie over raw IndexedDB:
 *   - Promise-based API (no callback hell)
 *   - Schema versioning with auto-migration
 *   - Compound indexes, multi-entry indexes
 *   - Live queries (observable)
 *   - 30KB gzipped, zero dependencies
 */

import Dexie, { type Table } from 'dexie';

// ─── Local Entity Types ──────────────────────────────────
// Mirror server entities but with offline metadata

export interface LocalOrder {
  id: string;               // UUID - generated client-side for new orders
  tenantId: string;
  orderNumber?: number;     // Assigned by server on sync
  channel: string;
  status: string;
  customerName?: string;
  customerPhone?: string;
  customerAddress?: string;
  notes?: string;
  priority: number;
  requestedAt?: string;
  estimatedReadyAt?: string;
  actualReadyAt?: string;
  totalAmount?: number;
  createdById?: string;
  createdAt: string;
  updatedAt: string;
  // Offline metadata
  _syncStatus: 'local' | 'synced' | 'modified' | 'conflict';
  _serverId?: string;       // Server-assigned ID if different
  _serverOrderNumber?: number;
  _lastSyncedAt?: string;
}

export interface LocalOrderItem {
  id: string;
  orderId: string;
  menuItemId: string;
  tenantId: string;
  quantity: number;
  unitPrice: number;
  modifications?: string;
  notes?: string;
  status: string;
  // Cached menu item info for offline display
  _menuItemName: string;
  _menuItemCategory?: string;
  _syncStatus: 'local' | 'synced' | 'modified';
}

export interface LocalTask {
  id: string;
  tenantId: string;
  orderId: string;
  orderItemId: string;
  taskDefId: string;
  phaseDefId: string;
  name: string;
  stationId?: string;
  assignedToId?: string;
  status: string;           // pending | queued | in_progress | done | cancelled
  dependsOn: string[];
  estimatedMinutes?: number;
  startedAt?: string;
  completedAt?: string;
  completedById?: string;
  // Cached info
  _stationName?: string;
  _stationColor?: string;
  _orderNumber?: number;
  _menuItemName?: string;
  _assignedToName?: string;
  _syncStatus: 'local' | 'synced' | 'modified';
}

export interface LocalSubtask {
  id: string;
  taskInstanceId: string;
  tenantId: string;
  subtaskDefId: string;
  name: string;
  isCompleted: boolean;
  completedAt?: string;
  completedById?: string;
  _syncStatus: 'local' | 'synced' | 'modified';
}

export interface LocalStation {
  id: string;
  tenantId: string;
  name: string;
  capacity: number;
  taskTypes: string[];
  isActive: boolean;
  displayOrder: number;
  settings: any;
  _syncStatus: 'synced';
}

export interface LocalMenuItem {
  id: string;
  tenantId: string;
  name: string;
  category?: string;
  price: number;
  workflowTemplateId?: string;
  isAvailable: boolean;
  displayOrder: number;
  _syncStatus: 'synced';
}

export interface LocalWorkflowTemplate {
  id: string;
  tenantId: string;
  name: string;
  category?: string;
  definition: any;
  estimatedTotalMinutes?: number;
  _syncStatus: 'synced';
}

export interface LocalInventoryItem {
  id: string;
  tenantId: string;
  name: string;
  unit: string;
  currentStock: number;
  minStock: number;
  costPerUnit?: number;
  supplier?: string;
  _syncStatus: 'synced' | 'modified';
}

export interface LocalDelivery {
  id: string;
  tenantId: string;
  orderId: string;
  riderId?: string;
  status: string;
  assignedAt?: string;
  pickedUpAt?: string;
  deliveredAt?: string;
  notes?: string;
  // Cached
  _orderNumber?: number;
  _customerName?: string;
  _customerPhone?: string;
  _customerAddress?: string;
  _riderName?: string;
  _syncStatus: 'local' | 'synced' | 'modified';
}

export interface LocalUser {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: string;
  _syncStatus: 'synced';
}

/**
 * SyncEvent — Every mutation is captured as an event.
 * These are queued and replayed to the server in order.
 */
export interface SyncEvent {
  id: string;               // UUID
  tenantId: string;
  userId: string;
  timestamp: string;         // ISO string, client time
  type: string;             // e.g. "order.create", "task.complete"
  entityType: string;       // "order" | "task" | "subtask" | etc.
  entityId: string;         // ID of the affected entity
  payload: any;             // Full data needed to replay this event on server
  status: 'pending' | 'syncing' | 'synced' | 'failed' | 'conflict';
  retryCount: number;
  lastError?: string;
  syncedAt?: string;
  // For ordering guarantee
  sequence: number;          // Auto-increment per session
}

/**
 * SyncMeta — Tracks sync state per entity type
 */
export interface SyncMeta {
  key: string;              // "orders_last_sync", "tasks_last_sync", etc.
  value: string;            // ISO timestamp or cursor
}

// ─── Database Definition ─────────────────────────────────

class OpsOSDatabase extends Dexie {
  orders!: Table<LocalOrder, string>;
  orderItems!: Table<LocalOrderItem, string>;
  tasks!: Table<LocalTask, string>;
  subtasks!: Table<LocalSubtask, string>;
  stations!: Table<LocalStation, string>;
  menuItems!: Table<LocalMenuItem, string>;
  workflowTemplates!: Table<LocalWorkflowTemplate, string>;
  inventoryItems!: Table<LocalInventoryItem, string>;
  deliveries!: Table<LocalDelivery, string>;
  users!: Table<LocalUser, string>;
  syncEvents!: Table<SyncEvent, string>;
  syncMeta!: Table<SyncMeta, string>;

  constructor() {
    super('opsos');

    this.version(1).stores({
      orders: 'id, tenantId, status, createdAt, _syncStatus, [tenantId+status], [tenantId+createdAt]',
      orderItems: 'id, orderId, tenantId, _syncStatus, [orderId+tenantId]',
      tasks: 'id, tenantId, orderId, stationId, status, _syncStatus, [tenantId+status], [stationId+status], [orderId+tenantId]',
      subtasks: 'id, taskInstanceId, tenantId, _syncStatus',
      stations: 'id, tenantId, [tenantId+isActive]',
      menuItems: 'id, tenantId, category, [tenantId+isAvailable]',
      workflowTemplates: 'id, tenantId',
      inventoryItems: 'id, tenantId, [tenantId+isActive]',
      deliveries: 'id, tenantId, orderId, status, _syncStatus, [tenantId+status]',
      users: 'id, tenantId, role, [tenantId+role]',
      syncEvents: 'id, tenantId, status, timestamp, sequence, [status+timestamp]',
      syncMeta: 'key',
    });
  }
}

// ─── Singleton ───────────────────────────────────────────

let dbInstance: OpsOSDatabase | null = null;

export function getLocalDB(): OpsOSDatabase {
  if (!dbInstance) {
    dbInstance = new OpsOSDatabase();
  }
  return dbInstance;
}

/**
 * Clear all local data (for logout or tenant switch)
 */
export async function clearLocalDB(): Promise<void> {
  const db = getLocalDB();
  await Promise.all([
    db.orders.clear(),
    db.orderItems.clear(),
    db.tasks.clear(),
    db.subtasks.clear(),
    db.stations.clear(),
    db.menuItems.clear(),
    db.workflowTemplates.clear(),
    db.inventoryItems.clear(),
    db.deliveries.clear(),
    db.users.clear(),
    db.syncEvents.clear(),
    db.syncMeta.clear(),
  ]);
}

/**
 * Generate a UUID client-side (crypto.randomUUID with fallback)
 */
export function generateLocalId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older browsers
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export default OpsOSDatabase;
