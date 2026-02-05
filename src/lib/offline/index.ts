/**
 * OFFLINE MODULE — Public API
 * 
 * Import everything from here:
 *   import { getLocalDB, createOrderOffline, startSyncEngine, ... } from '@/lib/offline';
 */

// Database
export { getLocalDB, clearLocalDB, generateLocalId } from './db';
export type {
  LocalOrder,
  LocalOrderItem,
  LocalTask,
  LocalSubtask,
  LocalStation,
  LocalMenuItem,
  LocalWorkflowTemplate,
  LocalInventoryItem,
  LocalDelivery,
  LocalUser,
  SyncEvent,
} from './db';

// Event Queue
export {
  enqueueEvent,
  getPendingEvents,
  getFailedEvents,
  getEventCounts,
  cleanupSyncedEvents,
  EVENT_TYPES,
} from './event-queue';

// Sync Engine
export {
  startSyncEngine,
  stopSyncEngine,
  onSyncStateChange,
  getSyncState,
  forcSync,
} from './sync-engine';
export type { ConnectionStatus, SyncState } from './sync-engine';

// Offline Actions (Optimistic UI)
export {
  createOrderOffline,
  startTaskOffline,
  completeTaskOffline,
  completeSubtaskOffline,
  assignDeliveryOffline,
  pickupDeliveryOffline,
  deliverDeliveryOffline,
  adjustInventoryOffline,
} from './actions';
export type { CreateOrderInput } from './actions';
