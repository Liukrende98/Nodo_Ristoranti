import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { withAuth, auditLog, AuthContext } from '@/lib/auth';
import { instantiateWorkflow } from '@/lib/workflow-engine';
import { calculateOrderETA } from '@/lib/eta';
import { deductStockForOrder } from '@/lib/inventory';
import { emitToTenant } from '@/lib/realtime';
import { z } from 'zod';

// ─── GET /api/orders ─────────────────────────────────────

async function getOrders(req: NextRequest, auth: AuthContext) {
  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status');
  const page = parseInt(searchParams.get('page') || '1', 10);
  const limit = parseInt(searchParams.get('limit') || '50', 10);
  const date = searchParams.get('date'); // YYYY-MM-DD

  const where: any = { tenantId: auth.tenantId };

  if (status && status !== 'all') {
    where.status = status;
  }

  if (date) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);
    where.createdAt = { gte: start, lte: end };
  }

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: {
        items: {
          include: {
            menuItem: { select: { name: true, category: true } },
          },
        },
        createdBy: { select: { name: true } },
        deliveryAssignment: {
          include: { rider: { select: { name: true } } },
        },
      },
      orderBy: [
        { priority: 'desc' },
        { createdAt: 'desc' },
      ],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.order.count({ where }),
  ]);

  return NextResponse.json({ orders, total, page, limit });
}

export const GET = withAuth(getOrders);

// ─── POST /api/orders ────────────────────────────────────

const createOrderSchema = z.object({
  channel: z.enum(['phone', 'in_store', 'online', 'import']),
  customerName: z.string().optional(),
  customerPhone: z.string().optional(),
  customerAddress: z.string().optional(),
  notes: z.string().optional(),
  priority: z.number().min(0).max(2).default(0),
  requestedAt: z.string().datetime().optional(),
  items: z.array(z.object({
    menuItemId: z.string().uuid(),
    quantity: z.number().min(1).default(1),
    modifications: z.string().optional(),
    notes: z.string().optional(),
  })).min(1),
});

async function createOrder(req: NextRequest, auth: AuthContext) {
  try {
    const body = await req.json();
    const parsed = createOrderSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Dati ordine non validi', details: parsed.error.issues },
        { status: 400 }
      );
    }

    const data = parsed.data;

    // Fetch menu items for prices and workflow templates
    const menuItemIds = data.items.map((i) => i.menuItemId);
    const menuItems = await prisma.menuItem.findMany({
      where: { id: { in: menuItemIds }, tenantId: auth.tenantId, isAvailable: true },
    });

    if (menuItems.length !== menuItemIds.length) {
      return NextResponse.json(
        { error: 'Uno o più articoli non disponibili' },
        { status: 400 }
      );
    }

    const menuItemMap = new Map(menuItems.map((m) => [m.id, m]));

    // Calculate total
    let totalAmount = 0;
    for (const item of data.items) {
      const menuItem = menuItemMap.get(item.menuItemId)!;
      totalAmount += Number(menuItem.price) * item.quantity;
    }

    // Create order with items in a transaction
    const order = await prisma.$transaction(async (tx) => {
      const newOrder = await tx.order.create({
        data: {
          tenantId: auth.tenantId,
          channel: data.channel,
          status: 'new',
          customerName: data.customerName,
          customerPhone: data.customerPhone,
          customerAddress: data.customerAddress,
          notes: data.notes,
          priority: data.priority,
          requestedAt: data.requestedAt ? new Date(data.requestedAt) : null,
          totalAmount,
          createdById: auth.userId,
          items: {
            create: data.items.map((item) => ({
              tenantId: auth.tenantId,
              menuItemId: item.menuItemId,
              quantity: item.quantity,
              unitPrice: menuItemMap.get(item.menuItemId)!.price,
              modifications: item.modifications,
              notes: item.notes,
              status: 'pending',
            })),
          },
        },
        include: {
          items: true,
        },
      });

      return newOrder;
    });

    // Instantiate workflows for each order item (outside transaction for performance)
    for (const item of order.items) {
      const menuItem = menuItemMap.get(item.menuItemId);
      if (menuItem?.workflowTemplateId) {
        await instantiateWorkflow(
          auth.tenantId,
          order.id,
          item.id,
          menuItem.workflowTemplateId
        );
      }
    }

    // Update order status to "preparing" and deduct stock
    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'preparing' },
    });

    // Deduct inventory
    await deductStockForOrder(auth.tenantId, order.id);

    // Calculate initial ETA
    const eta = await calculateOrderETA(auth.tenantId, order.id);

    // If delivery, create delivery assignment
    if (data.customerAddress) {
      await prisma.deliveryAssignment.create({
        data: {
          tenantId: auth.tenantId,
          orderId: order.id,
          status: 'pending',
        },
      });
    }

    // Audit log
    await auditLog(
      auth.tenantId,
      auth.userId,
      'order.create',
      'order',
      order.id,
      { channel: data.channel, itemCount: data.items.length, total: totalAmount }
    );

    // Real-time notification
    emitToTenant(auth.tenantId, 'order:created', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: 'preparing',
      itemCount: data.items.length,
      estimatedReadyAt: eta.estimatedReadyAt,
    });

    // Fetch complete order for response
    const fullOrder = await prisma.order.findUnique({
      where: { id: order.id },
      include: {
        items: {
          include: { menuItem: { select: { name: true, category: true } } },
        },
        taskInstances: {
          include: { subtasks: true, station: { select: { name: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    return NextResponse.json({ order: fullOrder, eta }, { status: 201 });
  } catch (error) {
    console.error('Create order error:', error);
    return NextResponse.json(
      { error: 'Errore nella creazione ordine' },
      { status: 500 }
    );
  }
}

export const POST = withAuth(createOrder, ['owner', 'admin', 'manager', 'staff']);
