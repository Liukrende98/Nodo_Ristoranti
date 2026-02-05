import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { withAuth, AuthContext } from '@/lib/auth';
import { startTask, completeTask, completeSubtask } from '@/lib/workflow-engine';
import { calculateOrderETA } from '@/lib/eta';

// ─── GET /api/tasks ──────────────────────────────────────

async function getTasks(req: NextRequest, auth: AuthContext) {
  const { searchParams } = new URL(req.url);
  const stationId = searchParams.get('station_id');
  const status = searchParams.get('status');
  const orderId = searchParams.get('order_id');

  const where: any = { tenantId: auth.tenantId };

  if (stationId) where.stationId = stationId;
  if (status) {
    if (status.includes(',')) {
      where.status = { in: status.split(',') };
    } else {
      where.status = status;
    }
  }
  if (orderId) where.orderId = orderId;

  const tasks = await prisma.taskInstance.findMany({
    where,
    include: {
      subtasks: true,
      station: { select: { name: true, settings: true } },
      order: {
        select: {
          orderNumber: true,
          customerName: true,
          priority: true,
          status: true,
        },
      },
      orderItem: {
        include: {
          menuItem: { select: { name: true, category: true } },
        },
      },
      assignedTo: { select: { name: true } },
    },
    orderBy: [
      { order: { priority: 'desc' } },
      { createdAt: 'asc' },
    ],
  });

  return NextResponse.json({ tasks });
}

export const GET = withAuth(getTasks);

// ─── POST /api/tasks (actions) ───────────────────────────

async function taskAction(req: NextRequest, auth: AuthContext) {
  try {
    const body = await req.json();
    const { action, taskId, subtaskId } = body;

    if (!taskId || !action) {
      return NextResponse.json(
        { error: 'taskId e action richiesti' },
        { status: 400 }
      );
    }

    switch (action) {
      case 'start': {
        await startTask(taskId, auth.userId, auth.tenantId);

        // Get task to find orderId for ETA recalc
        const task = await prisma.taskInstance.findUnique({
          where: { id: taskId },
          select: { orderId: true },
        });
        if (task) {
          const eta = await calculateOrderETA(auth.tenantId, task.orderId);
        }

        return NextResponse.json({ ok: true });
      }

      case 'complete': {
        const result = await completeTask(taskId, auth.userId, auth.tenantId);

        // Recalculate ETA
        const task = await prisma.taskInstance.findUnique({
          where: { id: taskId },
          select: { orderId: true },
        });
        if (task) {
          await calculateOrderETA(auth.tenantId, task.orderId);
        }

        return NextResponse.json({ ok: true, ...result });
      }

      case 'complete_subtask': {
        if (!subtaskId) {
          return NextResponse.json({ error: 'subtaskId richiesto' }, { status: 400 });
        }
        await completeSubtask(taskId, subtaskId, auth.userId, auth.tenantId);
        return NextResponse.json({ ok: true });
      }

      default:
        return NextResponse.json({ error: `Azione sconosciuta: ${action}` }, { status: 400 });
    }
  } catch (error: any) {
    console.error('Task action error:', error);
    return NextResponse.json(
      { error: error.message || 'Errore operazione task' },
      { status: 400 }
    );
  }
}

export const POST = withAuth(taskAction);
