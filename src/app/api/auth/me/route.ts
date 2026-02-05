import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthFromRequest } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const auth = await getAuthFromRequest(req);
  if (!auth) {
    return NextResponse.json({ error: 'Non autenticato' }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      tenantId: true,
      tenant: {
        select: { id: true, name: true, slug: true, settings: true },
      },
    },
  });

  if (!user) {
    return NextResponse.json({ error: 'Utente non trovato' }, { status: 404 });
  }

  return NextResponse.json({ user });
}
