import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { withAuth, AuthContext } from '@/lib/auth';

async function getMenu(req: NextRequest, auth: AuthContext) {
  const { searchParams } = new URL(req.url);
  const category = searchParams.get('category');

  const where: any = { tenantId: auth.tenantId, isAvailable: true };
  if (category) where.category = category;

  const items = await prisma.menuItem.findMany({
    where,
    include: {
      workflowTemplate: { select: { id: true, name: true, estimatedTotalMinutes: true } },
      recipeIngredients: {
        include: { inventoryItem: { select: { name: true, unit: true, currentStock: true } } },
      },
    },
    orderBy: [{ category: 'asc' }, { displayOrder: 'asc' }],
  });

  // Group by category
  const categories = [...new Set(items.map((i) => i.category || 'Altro'))];

  return NextResponse.json({ items, categories });
}

async function createMenuItem(req: NextRequest, auth: AuthContext) {
  const body = await req.json();
  const item = await prisma.menuItem.create({
    data: {
      tenantId: auth.tenantId,
      name: body.name,
      category: body.category,
      price: body.price,
      workflowTemplateId: body.workflowTemplateId,
      displayOrder: body.displayOrder || 0,
    },
  });
  return NextResponse.json({ item }, { status: 201 });
}

export const GET = withAuth(getMenu);
export const POST = withAuth(createMenuItem, ['owner', 'admin']);
