/**
 * Workflow Engine
 * 
 * Responsible for:
 * 1. Instantiating workflow templates into task instances for an order item
 * 2. Resolving task dependencies and determining which tasks are ready
 * 3. Completing tasks and propagating state changes
 * 4. Checking order completion
 */

import prisma from './db';
import { emitToTenant } from './realtime';

// ─── Types ───────────────────────────────────────────────

interface SubtaskDef {
  id: string;
  name: string;
  optional: boolean;
}

interface TaskDef {
  id: string;
  name: string;
  station_type: string;
  estimated_minutes: number;
  depends_on: string[];
  subtasks: SubtaskDef[];
}

interface PhaseDef {
  id: string;
  name: string;
  order: number;
  tasks: TaskDef[];
}

interface WorkflowDefinition {
  phases: PhaseDef[];
}

// ─── Instantiate Workflow ────────────────────────────────

/**
 * Creates task and subtask instances for an order item based on its workflow template.
 * Resolves station assignments from station_type → actual station ID.
 * Returns created task instance IDs for dependency resolution.
 */
export async function instantiateWorkflow(
  tenantId: string,
  orderId: string,
  orderItemId: string,
  workflowTemplateId: string
): Promise<string[]> {
  // Get workflow template
  const template = await prisma.workflowTemplate.findUnique({
    where: { id: workflowTemplateId },
  });

  if (!template) {
    throw new Error(`Workflow template ${workflowTemplateId} not found`);
  }

  const definition = template.definition as unknown as WorkflowDefinition;

  // Get all stations for this tenant to resolve station_type → station_id
  const stations = await prisma.station.findMany({
    where: { tenantId, isActive: true },
  });

  const stationByType = new Map<string, string>();
  for (const s of stations) {
    for (const type of s.taskTypes) {
      stationByType.set(type, s.id);
    }
  }

  // First pass: create all task instances and map defId → instanceId
  const defToInstanceId = new Map<string, string>();
  const createdTaskIds: string[] = [];

  // Get historical duration estimates
  const historicalDurations = await getHistoricalDurations(tenantId, workflowTemplateId);

  for (const phase of definition.phases) {
    for (const task of phase.tasks) {
      const stationId = stationByType.get(task.station_type) || null;

      // Use historical average if available, otherwise use definition estimate
      const estimatedMinutes =
        historicalDurations.get(task.id) ?? task.estimated_minutes;

      const instance = await prisma.taskInstance.create({
        data: {
          tenantId,
          orderId,
          orderItemId,
          taskDefId: task.id,
          phaseDefId: phase.id,
          name: task.name,
          stationId,
          status: 'pending',
          dependsOn: [], // Will update after all tasks created
          estimatedMinutes,
        },
      });

      defToInstanceId.set(task.id, instance.id);
      createdTaskIds.push(instance.id);

      // Create subtask instances
      if (task.subtasks.length > 0) {
        await prisma.subtaskInstance.createMany({
          data: task.subtasks.map((sub) => ({
            taskInstanceId: instance.id,
            tenantId,
            subtaskDefId: sub.id,
            name: sub.name,
            isCompleted: false,
          })),
        });
      }
    }
  }

  // Second pass: resolve dependencies (def IDs → instance IDs)
  for (const phase of definition.phases) {
    for (const task of phase.tasks) {
      if (task.depends_on.length > 0) {
        const instanceId = defToInstanceId.get(task.id)!;
        const depInstanceIds = task.depends_on
          .map((depId) => defToInstanceId.get(depId))
          .filter(Boolean) as string[];

        await prisma.taskInstance.update({
          where: { id: instanceId },
          data: { dependsOn: depInstanceIds },
        });
      }
    }
  }

  // Activate tasks with no dependencies (they can start immediately)
  await activateReadyTasks(tenantId, orderId);

  return createdTaskIds;
}

// ─── Activate Ready Tasks ────────────────────────────────

/**
 * Finds tasks that are "pending" but whose dependencies are all "done",
 * and transitions them to "queued" (ready to be worked on).
 */
export async function activateReadyTasks(
  tenantId: string,
  orderId: string
): Promise<number> {
  const pendingTasks = await prisma.taskInstance.findMany({
    where: { tenantId, orderId, status: 'pending' },
  });

  let activatedCount = 0;

  for (const task of pendingTasks) {
    const deps = task.dependsOn as string[];

    if (deps.length === 0) {
      // No dependencies → ready immediately
      await prisma.taskInstance.update({
        where: { id: task.id },
        data: { status: 'queued' },
      });
      activatedCount++;
    } else {
      // Check if all dependencies are done
      const completedDeps = await prisma.taskInstance.count({
        where: {
          id: { in: deps },
          status: 'done',
        },
      });

      if (completedDeps === deps.length) {
        await prisma.taskInstance.update({
          where: { id: task.id },
          data: { status: 'queued' },
        });
        activatedCount++;
      }
    }
  }

  return activatedCount;
}

// ─── Start Task ──────────────────────────────────────────

export async function startTask(
  taskId: string,
  userId: string,
  tenantId: string
): Promise<void> {
  const task = await prisma.taskInstance.findFirst({
    where: { id: taskId, tenantId },
  });

  if (!task) throw new Error('Task non trovato');
  if (task.status !== 'queued') throw new Error(`Task non avviabile (stato: ${task.status})`);

  await prisma.taskInstance.update({
    where: { id: taskId },
    data: {
      status: 'in_progress',
      assignedToId: userId,
      startedAt: new Date(),
    },
  });

  emitToTenant(tenantId, 'task:updated', {
    taskId,
    status: 'in_progress',
    orderId: task.orderId,
    stationId: task.stationId,
  });
}

// ─── Complete Task ───────────────────────────────────────

export async function completeTask(
  taskId: string,
  userId: string,
  tenantId: string
): Promise<{ orderComplete: boolean; orderReady: boolean }> {
  const task = await prisma.taskInstance.findFirst({
    where: { id: taskId, tenantId },
    include: { subtasks: true },
  });

  if (!task) throw new Error('Task non trovato');
  if (!['queued', 'in_progress'].includes(task.status)) {
    throw new Error(`Task non completabile (stato: ${task.status})`);
  }

  // Check all required subtasks are completed
  const requiredSubtasks = task.subtasks.filter((s) => true); // All subtasks checked
  const incompleteRequired = requiredSubtasks.filter((s) => !s.isCompleted);
  // Auto-complete subtasks when parent task is completed
  if (incompleteRequired.length > 0) {
    await prisma.subtaskInstance.updateMany({
      where: {
        taskInstanceId: taskId,
        isCompleted: false,
      },
      data: {
        isCompleted: true,
        completedAt: new Date(),
        completedById: userId,
      },
    });
  }

  const now = new Date();

  // Record duration for historical tracking
  if (task.startedAt) {
    const durationSeconds = Math.round((now.getTime() - task.startedAt.getTime()) / 1000);
    // Find workflow template through order item
    const orderItem = await prisma.orderItem.findUnique({
      where: { id: task.orderItemId },
      include: { menuItem: true },
    });
    if (orderItem?.menuItem?.workflowTemplateId) {
      await prisma.taskDuration.create({
        data: {
          tenantId,
          workflowTemplateId: orderItem.menuItem.workflowTemplateId,
          taskDefId: task.taskDefId,
          stationId: task.stationId,
          durationSeconds,
        },
      });
    }
  }

  // Complete the task
  await prisma.taskInstance.update({
    where: { id: taskId },
    data: {
      status: 'done',
      completedAt: now,
      completedById: userId,
      startedAt: task.startedAt ?? now, // If started and completed in one action
    },
  });

  // Activate dependent tasks
  await activateReadyTasks(tenantId, task.orderId);

  // Emit real-time event
  emitToTenant(tenantId, 'task:completed', {
    taskId,
    orderId: task.orderId,
    stationId: task.stationId,
    completedBy: userId,
  });

  // Check if all tasks for this order are done
  const result = await checkOrderCompletion(tenantId, task.orderId);

  return result;
}

// ─── Complete Subtask ────────────────────────────────────

export async function completeSubtask(
  taskId: string,
  subtaskId: string,
  userId: string,
  tenantId: string
): Promise<void> {
  const subtask = await prisma.subtaskInstance.findFirst({
    where: { id: subtaskId, taskInstanceId: taskId, tenantId },
  });

  if (!subtask) throw new Error('Subtask non trovato');
  if (subtask.isCompleted) return; // Idempotent

  await prisma.subtaskInstance.update({
    where: { id: subtaskId },
    data: {
      isCompleted: true,
      completedAt: new Date(),
      completedById: userId,
    },
  });

  emitToTenant(tenantId, 'subtask:completed', {
    subtaskId,
    taskId,
    tenantId,
  });
}

// ─── Check Order Completion ──────────────────────────────

async function checkOrderCompletion(
  tenantId: string,
  orderId: string
): Promise<{ orderComplete: boolean; orderReady: boolean }> {
  const allTasks = await prisma.taskInstance.findMany({
    where: { tenantId, orderId },
    select: { status: true },
  });

  const allDone = allTasks.every((t) => t.status === 'done' || t.status === 'cancelled');

  if (allDone) {
    // Update order status to "ready"
    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'ready',
        actualReadyAt: new Date(),
      },
    });

    // Update all order items to done
    await prisma.orderItem.updateMany({
      where: { orderId, status: { not: 'cancelled' } },
      data: { status: 'done' },
    });

    emitToTenant(tenantId, 'order:updated', {
      orderId,
      status: 'ready',
    });

    return { orderComplete: true, orderReady: true };
  }

  // Check if at least some items are progressing
  const inProgress = allTasks.some((t) => t.status === 'in_progress');
  if (inProgress) {
    // Ensure order is in "preparing" status
    await prisma.order.update({
      where: { id: orderId },
      data: { status: 'preparing' },
    });
  }

  return { orderComplete: false, orderReady: false };
}

// ─── Historical Duration Averages ────────────────────────

async function getHistoricalDurations(
  tenantId: string,
  workflowTemplateId: string
): Promise<Map<string, number>> {
  const durations = await prisma.taskDuration.groupBy({
    by: ['taskDefId'],
    where: {
      tenantId,
      workflowTemplateId,
      // Last 100 records per task (approximation via recent time window)
      recordedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    },
    _avg: { durationSeconds: true },
    _count: true,
  });

  const result = new Map<string, number>();
  for (const d of durations) {
    if (d._count >= 5 && d._avg.durationSeconds) {
      // Only use historical data if we have enough samples
      result.set(d.taskDefId, d._avg.durationSeconds / 60); // Convert to minutes
    }
  }

  return result;
}
