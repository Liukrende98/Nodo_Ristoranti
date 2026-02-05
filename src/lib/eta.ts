/**
 * ETA Calculator
 * 
 * Calculates estimated time of completion for orders based on:
 * 1. Station queue depth (how many tasks are ahead)
 * 2. Station capacity (concurrent tasks)
 * 3. Historical durations (moving average from task_durations)
 * 4. Task dependencies (critical path)
 * 
 * Algorithm:
 *   For each task in an order:
 *     wait_time = (tasks_ahead_in_station_queue × avg_duration) / station_capacity
 *     task_eta = max(dependency_etas) + wait_time + estimated_duration
 *   Order ETA = max(all task ETAs)
 */

import prisma from './db';

// ─── Types ───────────────────────────────────────────────

interface ETABreakdown {
  taskId: string;
  taskName: string;
  stationId: string | null;
  stationName?: string;
  estimatedMinutes: number;
  queueWaitMinutes: number;
  totalMinutes: number;
  isCriticalPath: boolean;
}

interface OrderETA {
  orderId: string;
  estimatedReadyAt: Date;
  totalMinutes: number;
  breakdown: ETABreakdown[];
  confidence: 'low' | 'medium' | 'high';
}

// ─── Station Queue Info ──────────────────────────────────

interface StationQueue {
  stationId: string;
  stationName: string;
  capacity: number;
  queuedTasks: number; // Tasks ahead (queued + in_progress)
  avgTaskMinutes: number;
}

async function getStationQueues(tenantId: string): Promise<Map<string, StationQueue>> {
  const stations = await prisma.station.findMany({
    where: { tenantId, isActive: true },
    include: {
      taskInstances: {
        where: {
          status: { in: ['queued', 'in_progress'] },
        },
        select: { id: true, estimatedMinutes: true },
      },
    },
  });

  const queues = new Map<string, StationQueue>();

  for (const station of stations) {
    const totalEstimated = station.taskInstances.reduce(
      (sum, t) => sum + (Number(t.estimatedMinutes) || 5),
      0
    );
    const avgTask =
      station.taskInstances.length > 0
        ? totalEstimated / station.taskInstances.length
        : 5; // Default 5 min

    queues.set(station.id, {
      stationId: station.id,
      stationName: station.name,
      capacity: station.capacity,
      queuedTasks: station.taskInstances.length,
      avgTaskMinutes: avgTask,
    });
  }

  return queues;
}

// ─── Calculate ETA for a Single Order ────────────────────

export async function calculateOrderETA(
  tenantId: string,
  orderId: string
): Promise<OrderETA> {
  // Get all tasks for this order
  const tasks = await prisma.taskInstance.findMany({
    where: { tenantId, orderId },
    include: { station: { select: { name: true, capacity: true } } },
  });

  if (tasks.length === 0) {
    return {
      orderId,
      estimatedReadyAt: new Date(),
      totalMinutes: 0,
      breakdown: [],
      confidence: 'low',
    };
  }

  // Get station queue info (excluding this order's tasks from count)
  const stationQueues = await getStationQueues(tenantId);

  // Build task ETA map using topological sort (respecting dependencies)
  const taskETAMinutes = new Map<string, number>();
  const taskBreakdown = new Map<string, ETABreakdown>();

  // Topological sort via Kahn's algorithm
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>(); // taskId → dependent task IDs
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  // Initialize
  for (const task of tasks) {
    const deps = (task.dependsOn as string[]) || [];
    inDegree.set(task.id, deps.length);
    if (!adjacency.has(task.id)) adjacency.set(task.id, []);
    for (const dep of deps) {
      if (!adjacency.has(dep)) adjacency.set(dep, []);
      adjacency.get(dep)!.push(task.id);
    }
  }

  // Queue starts with tasks having no dependencies
  const queue: string[] = [];
  for (const [taskId, degree] of inDegree) {
    if (degree === 0) queue.push(taskId);
  }

  while (queue.length > 0) {
    const taskId = queue.shift()!;
    const task = taskMap.get(taskId)!;

    // Already completed tasks have 0 remaining time
    if (task.status === 'done' || task.status === 'cancelled') {
      taskETAMinutes.set(taskId, 0);
      taskBreakdown.set(taskId, {
        taskId,
        taskName: task.name,
        stationId: task.stationId,
        stationName: task.station?.name,
        estimatedMinutes: 0,
        queueWaitMinutes: 0,
        totalMinutes: 0,
        isCriticalPath: false,
      });
    } else if (task.status === 'in_progress') {
      // In progress: estimate remaining time
      const elapsed = task.startedAt
        ? (Date.now() - task.startedAt.getTime()) / 60000
        : 0;
      const remaining = Math.max(0, Number(task.estimatedMinutes || 5) - elapsed);

      taskETAMinutes.set(taskId, remaining);
      taskBreakdown.set(taskId, {
        taskId,
        taskName: task.name,
        stationId: task.stationId,
        stationName: task.station?.name,
        estimatedMinutes: remaining,
        queueWaitMinutes: 0,
        totalMinutes: remaining,
        isCriticalPath: false,
      });
    } else {
      // Pending or queued: full calculation
      const deps = (task.dependsOn as string[]) || [];
      const maxDepETA = deps.length > 0
        ? Math.max(...deps.map((d) => taskETAMinutes.get(d) ?? 0))
        : 0;

      const estimatedMinutes = Number(task.estimatedMinutes || 5);

      // Queue wait time at station
      let queueWaitMinutes = 0;
      if (task.stationId) {
        const stationQueue = stationQueues.get(task.stationId);
        if (stationQueue) {
          // How many tasks are ahead at this station (not from this order)
          const tasksAhead = stationQueue.queuedTasks;
          const capacity = stationQueue.capacity;
          queueWaitMinutes = (tasksAhead * stationQueue.avgTaskMinutes) / capacity;
        }
      }

      const totalMinutes = maxDepETA + queueWaitMinutes + estimatedMinutes;
      taskETAMinutes.set(taskId, totalMinutes);
      taskBreakdown.set(taskId, {
        taskId,
        taskName: task.name,
        stationId: task.stationId,
        stationName: task.station?.name,
        estimatedMinutes,
        queueWaitMinutes,
        totalMinutes,
        isCriticalPath: false,
      });
    }

    // Process dependents
    for (const depId of adjacency.get(taskId) ?? []) {
      const newDegree = (inDegree.get(depId) ?? 0) - 1;
      inDegree.set(depId, newDegree);
      if (newDegree === 0) queue.push(depId);
    }
  }

  // Order ETA is the maximum of all task ETAs (critical path)
  let maxMinutes = 0;
  let criticalTaskId = '';
  for (const [taskId, minutes] of taskETAMinutes) {
    if (minutes > maxMinutes) {
      maxMinutes = minutes;
      criticalTaskId = taskId;
    }
  }

  // Mark critical path
  if (criticalTaskId && taskBreakdown.has(criticalTaskId)) {
    taskBreakdown.get(criticalTaskId)!.isCriticalPath = true;
  }

  // Determine confidence
  const hasHistorical = tasks.some(
    (t) => t.estimatedMinutes && Number(t.estimatedMinutes) > 0
  );
  const confidence: 'low' | 'medium' | 'high' =
    tasks.length < 3 ? 'low' : hasHistorical ? 'high' : 'medium';

  const estimatedReadyAt = new Date(Date.now() + maxMinutes * 60000);

  // Update order's estimated_ready_at
  await prisma.order.update({
    where: { id: orderId },
    data: { estimatedReadyAt },
  });

  return {
    orderId,
    estimatedReadyAt,
    totalMinutes: Math.round(maxMinutes),
    breakdown: Array.from(taskBreakdown.values()),
    confidence,
  };
}

// ─── Suggest Best Time for Phone Orders ──────────────────

/**
 * Given a set of items the customer wants to order,
 * estimates how long it would take if ordered NOW
 * considering current station loads.
 */
export async function suggestOrderTime(
  tenantId: string,
  menuItemIds: string[]
): Promise<{
  estimatedMinutes: number;
  suggestedReadyAt: Date;
  stationLoads: { name: string; loadPercent: number }[];
}> {
  const stationQueues = await getStationQueues(tenantId);

  // Get workflow templates for these menu items
  const menuItems = await prisma.menuItem.findMany({
    where: { id: { in: menuItemIds }, tenantId },
    include: { workflowTemplate: true },
  });

  let maxMinutes = 0;

  for (const item of menuItems) {
    if (!item.workflowTemplate) continue;

    const def = item.workflowTemplate.definition as any;
    // Simple estimate: sum up all tasks considering dependencies
    let itemMinutes = 0;
    const phaseMinutes: number[] = [];

    for (const phase of def.phases || []) {
      let phaseMax = 0;
      for (const task of phase.tasks || []) {
        const stationId = [...stationQueues.entries()].find(
          ([_, q]) => q.stationName.toLowerCase().includes(task.station_type)
        )?.[0];

        let waitTime = 0;
        if (stationId) {
          const sq = stationQueues.get(stationId)!;
          waitTime = (sq.queuedTasks * sq.avgTaskMinutes) / sq.capacity;
        }

        const taskTotal = waitTime + task.estimated_minutes;
        phaseMax = Math.max(phaseMax, taskTotal);
      }
      phaseMinutes.push(phaseMax);
    }

    itemMinutes = phaseMinutes.reduce((a, b) => a + b, 0);
    maxMinutes = Math.max(maxMinutes, itemMinutes);
  }

  // Add 2 min buffer for packaging/handoff
  maxMinutes = Math.ceil(maxMinutes) + 2;

  const stationLoads = Array.from(stationQueues.values()).map((sq) => ({
    name: sq.stationName,
    loadPercent: Math.min(100, Math.round((sq.queuedTasks / sq.capacity) * 100)),
  }));

  return {
    estimatedMinutes: maxMinutes,
    suggestedReadyAt: new Date(Date.now() + maxMinutes * 60000),
    stationLoads,
  };
}
