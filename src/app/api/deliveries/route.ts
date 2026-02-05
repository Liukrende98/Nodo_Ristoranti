import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { withAuth, AuthContext, auditLog } from '@/lib/auth';
import { emitToTenant } from '@/lib/realtime';

async function getDeliveries(req: NextRequest, auth: AuthContext) {
  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status');

  const where: any = { tenantId: auth.tenantId };
  if (status) where.status = status;

  // Delivery riders only see their own assignments
  if (auth.role === 'delivery') {
    where.riderId = auth.userId;
  }

  const deliveries = await prisma.deliveryAssignment.findMany({
    where,
    include: {
      order: {
        select: {
          orderNumber: true,
          customerName: true,
          customerPhone: true,
          customerAddress: true,
          status: true,
          totalAmount: true,
          items: {
            include: { menuItem: { select: { name: true } } },
          },
        },
      },
      rider: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json({ deliveries });
}

async function deliveryAction(req: NextRequest, auth: AuthContext) {
  const body = await req.json();
  const { deliveryId, action, riderId } = body;

  if (!deliveryId || !action) {
    return NextResponse.json({ error: 'deliveryId e action richiesti' }, { status: 400 });
  }

  const delivery = await prisma.deliveryAssignment.findFirst({
    where: { id: deliveryId, tenantId: auth.tenantId },
  });

  if (!delivery) {
    return NextResponse.json({ error: 'Consegna non trovata' }, { status: 404 });
  }

  switch (action) {
    case 'assign': {
      await prisma.deliveryAssignment.update({
        where: { id: deliveryId },
        data: { riderId: riderId || auth.userId, status: 'assigned', assignedAt: new Date() },
      });
      break;
    }
    case 'pickup': {
      await prisma.deliveryAssignment.update({
        where: { id: deliveryId },
        data: { status: 'picked_up', pickedUpAt: new Date() },
      });
      await prisma.order.update({
        where: { id: delivery.orderId },
        data: { status: 'delivering' },
      });
      break;
    }
    case 'deliver': {
      await prisma.deliveryAssignment.update({
        where: { id: deliveryId },
        data: { status: 'delivered', deliveredAt: new Date() },
      });
      await prisma.order.update({
        where: { id: delivery.orderId },
        data: { status: 'delivered' },
      });
      break;
    }
    default:
      return NextResponse.json({ error: `Azione sconosciuta: ${action}` }, { status: 400 });
  }

  emitToTenant(auth.tenantId, 'delivery:updated', {
    deliveryId,
    orderId: delivery.orderId,
    status: action === 'deliver' ? 'delivered' : action === 'pickup' ? 'picked_up' : 'assigned',
  });

  await auditLog(auth.tenantId, auth.userId, `delivery.${action}`, 'delivery', deliveryId);

  return NextResponse.json({ ok: true });
}

export const GET = withAuth(getDeliveries);
export const POST = withAuth(deliveryAction);
