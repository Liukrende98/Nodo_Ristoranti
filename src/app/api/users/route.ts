import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { withAuth, AuthContext, hashPassword } from '@/lib/auth';

async function getUsers(req: NextRequest, auth: AuthContext) {
  const { searchParams } = new URL(req.url);
  const role = searchParams.get('role');

  const where: any = { tenantId: auth.tenantId, isActive: true };
  if (role) where.role = role;

  const users = await prisma.user.findMany({
    where,
    select: { id: true, name: true, email: true, role: true, lastLoginAt: true },
    orderBy: { name: 'asc' },
  });

  return NextResponse.json({ users });
}

async function createUser(req: NextRequest, auth: AuthContext) {
  const body = await req.json();
  const passwordHash = await hashPassword(body.password || 'changeme123');

  const user = await prisma.user.create({
    data: {
      tenantId: auth.tenantId,
      email: body.email.toLowerCase(),
      passwordHash,
      name: body.name,
      role: body.role,
    },
    select: { id: true, name: true, email: true, role: true },
  });

  return NextResponse.json({ user }, { status: 201 });
}

export const GET = withAuth(getUsers);
export const POST = withAuth(createUser, ['owner', 'admin']);
