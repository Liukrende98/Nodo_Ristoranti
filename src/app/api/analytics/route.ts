import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { withAuth, AuthContext } from '@/lib/auth';

async function getAnalytics(req: NextRequest, auth: AuthContext) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get('type') || 'today';

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  switch (type) {
    case 'today': {
      // Orders today
      const orders = await prisma.order.findMany({
        where: {
          tenantId: auth.tenantId,
          createdAt: { gte: today, lte: endOfDay },
        },
        include: {
          items: { include: { menuItem: { select: { name: true } } } },
        },
      });

      const totalOrders = orders.length;
      const completedOrders = orders.filter((o) => ['delivered', 'ready'].includes(o.status)).length;
      const cancelledOrders = orders.filter((o) => o.status === 'cancelled').length;
      const activeOrders = orders.filter((o) => ['new', 'preparing'].includes(o.status)).length;

      // Revenue
      const revenue = orders
        .filter((o) => o.status !== 'cancelled')
        .reduce((sum, o) => sum + Number(o.totalAmount || 0), 0);

      // Average prep time (orders that are ready or delivered)
      const completedWithTimes = orders.filter(
        (o) => o.actualReadyAt && o.createdAt
      );
      const avgPrepMinutes =
        completedWithTimes.length > 0
          ? completedWithTimes.reduce(
              (sum, o) =>
                sum + (o.actualReadyAt!.getTime() - o.createdAt.getTime()) / 60000,
              0
            ) / completedWithTimes.length
          : 0;

      // Late orders (actual > estimated)
      const lateOrders = completedWithTimes.filter(
        (o) =>
          o.estimatedReadyAt &&
          o.actualReadyAt &&
          o.actualReadyAt > o.estimatedReadyAt
      ).length;

      // Top items
      const itemCounts = new Map<string, number>();
      for (const order of orders) {
        for (const item of order.items) {
          const name = item.menuItem.name;
          itemCounts.set(name, (itemCounts.get(name) || 0) + item.quantity);
        }
      }
      const topItems = [...itemCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, count]) => ({ name, count }));

      // Orders by channel
      const byChannel = orders.reduce(
        (acc, o) => {
          acc[o.channel] = (acc[o.channel] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      );

      // Orders by hour
      const byHour: Record<number, number> = {};
      for (const o of orders) {
        const hour = o.createdAt.getHours();
        byHour[hour] = (byHour[hour] || 0) + 1;
      }

      return NextResponse.json({
        totalOrders,
        completedOrders,
        cancelledOrders,
        activeOrders,
        revenue: Math.round(revenue * 100) / 100,
        avgPrepMinutes: Math.round(avgPrepMinutes * 10) / 10,
        lateOrders,
        latePercent: totalOrders > 0 ? Math.round((lateOrders / totalOrders) * 100) : 0,
        topItems,
        byChannel,
        byHour,
      });
    }

    case 'stations': {
      const stations = await prisma.station.findMany({
        where: { tenantId: auth.tenantId, isActive: true },
        include: {
          taskInstances: {
            where: {
              createdAt: { gte: today },
            },
            select: {
              status: true,
              startedAt: true,
              completedAt: true,
              estimatedMinutes: true,
            },
          },
        },
      });

      const stationStats = stations.map((s) => {
        const completed = s.taskInstances.filter((t) => t.status === 'done');
        const active = s.taskInstances.filter((t) =>
          ['queued', 'in_progress'].includes(t.status)
        );

        const avgDuration =
          completed.length > 0
            ? completed
                .filter((t) => t.startedAt && t.completedAt)
                .reduce(
                  (sum, t) =>
                    sum + (t.completedAt!.getTime() - t.startedAt!.getTime()) / 60000,
                  0
                ) / completed.length
            : 0;

        return {
          id: s.id,
          name: s.name,
          capacity: s.capacity,
          settings: s.settings,
          completedToday: completed.length,
          activeNow: active.length,
          loadPercent: Math.min(100, Math.round((active.length / s.capacity) * 100)),
          avgDurationMinutes: Math.round(avgDuration * 10) / 10,
        };
      });

      return NextResponse.json({ stations: stationStats });
    }

    default:
      return NextResponse.json({ error: 'Tipo analytics non valido' }, { status: 400 });
  }
}

export const GET = withAuth(getAnalytics, ['owner', 'admin', 'manager']);
