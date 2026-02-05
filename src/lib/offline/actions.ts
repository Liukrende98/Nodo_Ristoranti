/**
 * OFFLINE ACTIONS — Optimistic Local Mutations
 * 
 * Each action:
 *   1. Writes to IndexedDB immediately (instant UI)
 *   2. Enqueues a sync event (background sync)
 *   3. Returns the local state (no await on server)
 * 
 * The UI calls THESE functions, never the API directly.
 * The sync engine handles server communication.
 */

import { getLocalDB, generateLocalId, type LocalOrder, type LocalTask, type LocalSubtask, type LocalDelivery } from './db';
import { enqueueEvent, EVENT_TYPES } from './event-queue';

// ─── Order Actions ───────────────────────────────────────

export interface CreateOrderInput {
  channel: string;
  customerName?: string;
  customerPhone?: string;
  customerAddress?: string;
  notes?: string;
  priority?: number;
  items: {
    menuItemId: string;
    quantity: number;
    modifications?: string;
    notes?: string;
  }[];
}

/**
 * Create a new order. Returns immediately with local data.
 * Server sync happens in background.
 */
export async function createOrderOffline(
  tenantId: string,
  userId: string,
  input: CreateOrderInput
): Promise<{ orderId: string; order: LocalOrder }> {
  const db = getLocalDB();
  const orderId = generateLocalId();
  const now = new Date().toISOString();

  // Resolve menu item details from local cache
  const menuItemIds = input.items.map((i) => i.menuItemId);
  const menuItems = await db.menuItems.where('id').anyOf(menuItemIds).toArray();
  const menuMap = new Map(menuItems.map((m) => [m.id, m]));

  // Calculate total
  let totalAmount = 0;
  for (const item of input.items) {
    const menu = menuMap.get(item.menuItemId);
    if (menu) totalAmount += menu.price * item.quantity;
  }

  // Create local order
  const order: LocalOrder = {
    id: orderId,
    tenantId,
    channel: input.channel,
    status: 'preparing',
    customerName: input.customerName,
    customerPhone: input.customerPhone,
    customerAddress: input.customerAddress,
    notes: input.notes,
    priority: input.priority || 0,
    totalAmount,
    createdById: userId,
    createdAt: now,
    updatedAt: now,
    _syncStatus: 'local',
  };

  await db.orders.add(order);

  // Create local order items
  for (const item of input.items) {
    const menu = menuMap.get(item.menuItemId);
    await db.orderItems.add({
      id: generateLocalId(),
      orderId,
      menuItemId: item.menuItemId,
      tenantId,
      quantity: item.quantity,
      unitPrice: menu?.price || 0,
      modifications: item.modifications,
      notes: item.notes,
      status: 'pending',
      _menuItemName: menu?.name || 'Sconosciuto',
      _menuItemCategory: menu?.category,
      _syncStatus: 'local',
    });
  }

  // Instantiate workflow tasks locally (from cached workflow templates)
  await instantiateWorkflowLocally(tenantId, orderId, input.items, menuMap);

  // If delivery, create local delivery
  if (input.customerAddress) {
    await db.deliveries.add({
      id: generateLocalId(),
      tenantId,
      orderId,
      status: 'pending',
      _orderNumber: undefined,
      _customerName: input.customerName,
      _customerPhone: input.customerPhone,
      _customerAddress: input.customerAddress,
      _syncStatus: 'local',
    });
  }

  // Queue sync event
  await enqueueEvent(tenantId, userId, EVENT_TYPES.ORDER_CREATE, 'order', orderId, {
    channel: input.channel,
    customerName: input.customerName,
    customerPhone: input.customerPhone,
    customerAddress: input.customerAddress,
    notes: input.notes,
    priority: input.priority || 0,
    items: input.items,
  });

  return { orderId, order };
}

// ─── Task Actions ────────────────────────────────────────

/**
 * Start a task. Updates local DB instantly.
 */
export async function startTaskOffline(
  tenantId: string,
  userId: string,
  taskId: string
): Promise<void> {
  const db = getLocalDB();
  const now = new Date().toISOString();

  await db.tasks.update(taskId, {
    status: 'in_progress',
    assignedToId: userId,
    startedAt: now,
    _syncStatus: 'modified',
  });

  await enqueueEvent(tenantId, userId, EVENT_TYPES.TASK_START, 'task', taskId, {});
}

/**
 * Complete a task. Updates local DB, activates dependent tasks.
 */
export async function completeTaskOffline(
  tenantId: string,
  userId: string,
  taskId: string
): Promise<{ orderComplete: boolean }> {
  const db = getLocalDB();
  const now = new Date().toISOString();

  const task = await db.tasks.get(taskId);
  if (!task) throw new Error('Task non trovato');

  // Complete the task
  await db.tasks.update(taskId, {
    status: 'done',
    completedAt: now,
    completedById: userId,
    startedAt: task.startedAt || now,
    _syncStatus: 'modified',
  });

  // Auto-complete all subtasks
  await db.subtasks
    .where('taskInstanceId')
    .equals(taskId)
    .modify({
      isCompleted: true,
      completedAt: now,
      completedById: userId,
      _syncStatus: 'modified',
    });

  // Activate dependent tasks (tasks that depend on this one)
  const allOrderTasks = await db.tasks
    .where('[orderId+tenantId]')
    .equals([task.orderId, tenantId])
    .toArray();

  for (const depTask of allOrderTasks) {
    if (depTask.status !== 'pending') continue;
    if (!depTask.dependsOn.includes(taskId)) continue;

    // Check if ALL dependencies are done
    const allDepsDone = depTask.dependsOn.every((depId) => {
      const dep = allOrderTasks.find((t) => t.id === depId);
      return dep?.status === 'done';
    });

    if (allDepsDone) {
      await db.tasks.update(depTask.id, {
        status: 'queued',
        _syncStatus: 'modified',
      });
    }
  }

  // Check if ALL tasks for this order are done
  const updatedTasks = await db.tasks
    .where('[orderId+tenantId]')
    .equals([task.orderId, tenantId])
    .toArray();

  const allDone = updatedTasks.every((t) => t.status === 'done' || t.status === 'cancelled');

  if (allDone) {
    await db.orders.update(task.orderId, {
      status: 'ready',
      actualReadyAt: now,
      _syncStatus: 'modified',
    });
  }

  // Queue sync
  await enqueueEvent(tenantId, userId, EVENT_TYPES.TASK_COMPLETE, 'task', taskId, {});

  return { orderComplete: allDone };
}

/**
 * Complete a subtask. Instant local update.
 */
export async function completeSubtaskOffline(
  tenantId: string,
  userId: string,
  taskId: string,
  subtaskId: string
): Promise<void> {
  const db = getLocalDB();
  const now = new Date().toISOString();

  await db.subtasks.update(subtaskId, {
    isCompleted: true,
    completedAt: now,
    completedById: userId,
    _syncStatus: 'modified',
  });

  await enqueueEvent(tenantId, userId, EVENT_TYPES.SUBTASK_COMPLETE, 'subtask', subtaskId, {
    taskId,
  });
}

// ─── Delivery Actions ────────────────────────────────────

export async function assignDeliveryOffline(
  tenantId: string,
  userId: string,
  deliveryId: string,
  riderId: string,
  riderName?: string
): Promise<void> {
  const db = getLocalDB();
  const now = new Date().toISOString();

  await db.deliveries.update(deliveryId, {
    riderId,
    status: 'assigned',
    assignedAt: now,
    _riderName: riderName,
    _syncStatus: 'modified',
  });

  await enqueueEvent(tenantId, userId, EVENT_TYPES.DELIVERY_ASSIGN, 'delivery', deliveryId, { riderId });
}

export async function pickupDeliveryOffline(
  tenantId: string,
  userId: string,
  deliveryId: string
): Promise<void> {
  const db = getLocalDB();
  const now = new Date().toISOString();

  const del = await db.deliveries.get(deliveryId);
  if (!del) return;

  await db.deliveries.update(deliveryId, {
    status: 'picked_up',
    pickedUpAt: now,
    _syncStatus: 'modified',
  });

  await db.orders.update(del.orderId, {
    status: 'delivering',
    _syncStatus: 'modified',
  });

  await enqueueEvent(tenantId, userId, EVENT_TYPES.DELIVERY_PICKUP, 'delivery', deliveryId, {});
}

export async function deliverDeliveryOffline(
  tenantId: string,
  userId: string,
  deliveryId: string
): Promise<void> {
  const db = getLocalDB();
  const now = new Date().toISOString();

  const del = await db.deliveries.get(deliveryId);
  if (!del) return;

  await db.deliveries.update(deliveryId, {
    status: 'delivered',
    deliveredAt: now,
    _syncStatus: 'modified',
  });

  await db.orders.update(del.orderId, {
    status: 'delivered',
    _syncStatus: 'modified',
  });

  await enqueueEvent(tenantId, userId, EVENT_TYPES.DELIVERY_DELIVER, 'delivery', deliveryId, {});
}

// ─── Inventory Actions ───────────────────────────────────

export async function adjustInventoryOffline(
  tenantId: string,
  userId: string,
  itemId: string,
  quantity: number,
  type: string,
  notes?: string
): Promise<void> {
  const db = getLocalDB();

  const item = await db.inventoryItems.get(itemId);
  if (!item) return;

  await db.inventoryItems.update(itemId, {
    currentStock: item.currentStock + quantity,
    _syncStatus: 'modified',
  });

  await enqueueEvent(tenantId, userId, EVENT_TYPES.INVENTORY_ADJUST, 'inventory', itemId, {
    quantity,
    type,
    notes,
  });
}

// ─── Local Workflow Instantiation ────────────────────────

async function instantiateWorkflowLocally(
  tenantId: string,
  orderId: string,
  items: CreateOrderInput['items'],
  menuMap: Map<string, any>
): Promise<void> {
  const db = getLocalDB();

  for (const item of items) {
    const menu = menuMap.get(item.menuItemId);
    if (!menu?.workflowTemplateId) continue;

    const template = await db.workflowTemplates.get(menu.workflowTemplateId);
    if (!template) continue;

    const def = template.definition as any;
    const orderItemId = generateLocalId();
    const taskIdMap = new Map<string, string>(); // defId → instanceId

    // Create task instances
    for (const phase of def.phases || []) {
      for (const taskDef of phase.tasks || []) {
        const taskId = generateLocalId();
        taskIdMap.set(taskDef.id, taskId);

        // Resolve station
        const station = await db.stations
          .where('tenantId')
          .equals(tenantId)
          .filter((s) => s.taskTypes.includes(taskDef.station_type) && s.isActive)
          .first();

        const task: LocalTask = {
          id: taskId,
          tenantId,
          orderId,
          orderItemId,
          taskDefId: taskDef.id,
          phaseDefId: phase.id,
          name: taskDef.name,
          stationId: station?.id,
          status: 'pending',
          dependsOn: [], // Will resolve after all tasks created
          estimatedMinutes: taskDef.estimated_minutes,
          _stationName: station?.name,
          _stationColor: (station?.settings as any)?.color,
          _menuItemName: menu.name,
          _syncStatus: 'local',
        };

        await db.tasks.add(task);

        // Create subtask instances
        for (const subDef of taskDef.subtasks || []) {
          await db.subtasks.add({
            id: generateLocalId(),
            taskInstanceId: taskId,
            tenantId,
            subtaskDefId: subDef.id,
            name: subDef.name,
            isCompleted: false,
            _syncStatus: 'local',
          });
        }
      }
    }

    // Second pass: resolve dependencies
    for (const phase of def.phases || []) {
      for (const taskDef of phase.tasks || []) {
        if (taskDef.depends_on?.length > 0) {
          const taskId = taskIdMap.get(taskDef.id)!;
          const depIds = taskDef.depends_on
            .map((depDefId: string) => taskIdMap.get(depDefId))
            .filter(Boolean) as string[];

          await db.tasks.update(taskId, { dependsOn: depIds });
        }
      }
    }

    // Activate tasks with no dependencies
    const allTasks = await db.tasks
      .where('[orderId+tenantId]')
      .equals([orderId, tenantId])
      .toArray();

    for (const task of allTasks) {
      if (task.dependsOn.length === 0 && task.status === 'pending') {
        await db.tasks.update(task.id, { status: 'queued' });
      }
    }
  }
}
