// ─── /api/stations/route.ts ──────────────────────────────
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { withAuth, AuthContext } from '@/lib/auth';

async function getStations(req: NextRequest, auth: AuthContext) {
  const stations = await prisma.station.findMany({
    where: { tenantId: auth.tenantId, isActive: true },
    include: {
      taskInstances: {
        where: { status: { in: ['queued', 'in_progress'] } },
        select: { id: true, status: true, estimatedMinutes: true },
      },
      _count: {
        select: {
          taskInstances: { where: { status: { in: ['queued', 'in_progress'] } } },
        },
      },
    },
    orderBy: { displayOrder: 'asc' },
  });

  const result = stations.map((s) => ({
    ...s,
    queueLength: s._count.taskInstances,
    loadPercent: Math.min(100, Math.round((s._count.taskInstances / s.capacity) * 100)),
  }));

  return NextResponse.json({ stations: result });
}

async function createStation(req: NextRequest, auth: AuthContext) {
  const body = await req.json();
  const station = await prisma.station.create({
    data: {
      tenantId: auth.tenantId,
      name: body.name,
      capacity: body.capacity || 1,
      taskTypes: body.taskTypes || [],
      displayOrder: body.displayOrder || 0,
      settings: body.settings || {},
    },
  });
  return NextResponse.json({ station }, { status: 201 });
}

export const GET = withAuth(getStations);
export const POST = withAuth(createStation, ['owner', 'admin']);
