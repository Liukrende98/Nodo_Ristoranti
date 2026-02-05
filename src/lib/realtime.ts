/**
 * Real-time Event System
 * 
 * Uses a simple EventEmitter pattern for in-process communication.
 * In production with multiple processes, replace with Redis pub/sub.
 * 
 * Socket.io server runs as a separate process on port 3001.
 * API routes emit events via the shared emitter,
 * the socket server picks them up and broadcasts to clients.
 */

import { EventEmitter } from 'events';

// ─── In-Process Event Bus ────────────────────────────────

class RealtimeEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
  }
}

// Global singleton
const globalForEvents = globalThis as unknown as { eventBus: RealtimeEventBus };
export const eventBus = globalForEvents.eventBus ?? new RealtimeEventBus();
if (process.env.NODE_ENV !== 'production') globalForEvents.eventBus = eventBus;

// ─── Emit to Tenant Room ────────────────────────────────

export function emitToTenant(tenantId: string, event: string, data: any): void {
  eventBus.emit('tenant-event', { tenantId, event, data });
}

// ─── Event Types ─────────────────────────────────────────

export type RealtimeEvent =
  | 'order:created'
  | 'order:updated'
  | 'task:updated'
  | 'task:completed'
  | 'subtask:completed'
  | 'eta:recalculated'
  | 'delivery:updated'
  | 'station:load'
  | 'inventory:alert';
