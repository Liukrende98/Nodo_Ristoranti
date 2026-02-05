import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { withAuth, AuthContext } from '@/lib/auth';

async function getWorkflows(req: NextRequest, auth: AuthContext) {
  const templates = await prisma.workflowTemplate.findMany({
    where: { tenantId: auth.tenantId, isActive: true },
    orderBy: { name: 'asc' },
  });
  return NextResponse.json({ templates });
}

async function createWorkflow(req: NextRequest, auth: AuthContext) {
  const body = await req.json();
  const template = await prisma.workflowTemplate.create({
    data: {
      tenantId: auth.tenantId,
      name: body.name,
      category: body.category,
      definition: body.definition,
      estimatedTotalMinutes: body.estimatedTotalMinutes,
    },
  });
  return NextResponse.json({ template }, { status: 201 });
}

export const GET = withAuth(getWorkflows);
export const POST = withAuth(createWorkflow, ['owner', 'admin']);
