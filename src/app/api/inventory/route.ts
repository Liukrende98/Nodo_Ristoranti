import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { withAuth, AuthContext } from '@/lib/auth';
import { adjustStock, getReorderSuggestions } from '@/lib/inventory';

async function getInventory(req: NextRequest, auth: AuthContext) {
  const { searchParams } = new URL(req.url);
  const belowMin = searchParams.get('below_min') === 'true';
  const action = searchParams.get('action');

  // Reorder suggestions endpoint
  if (action === 'reorder-suggestions') {
    const suggestions = await getReorderSuggestions(auth.tenantId);
    return NextResponse.json({ suggestions });
  }

  const items = await prisma.inventoryItem.findMany({
    where: {
      tenantId: auth.tenantId,
      isActive: true,
      ...(belowMin ? {
        currentStock: { lte: prisma.inventoryItem.fields.minStock }
      } : {}),
    },
    orderBy: { name: 'asc' },
  });

  // If belowMin filter doesn't work with Prisma raw comparison, filter in JS
  const filtered = belowMin
    ? items.filter((i) => Number(i.currentStock) <= Number(i.minStock))
    : items;

  return NextResponse.json({ items: filtered });
}

async function createOrAdjustInventory(req: NextRequest, auth: AuthContext) {
  const body = await req.json();

  // Adjust existing item
  if (body.action === 'adjust' && body.itemId) {
    await adjustStock(
      auth.tenantId,
      body.itemId,
      body.quantity,
      body.type || 'adjustment',
      body.notes || null,
      auth.userId
    );
    return NextResponse.json({ ok: true });
  }

  // Create new item
  const item = await prisma.inventoryItem.create({
    data: {
      tenantId: auth.tenantId,
      name: body.name,
      unit: body.unit,
      currentStock: body.currentStock || 0,
      minStock: body.minStock || 0,
      costPerUnit: body.costPerUnit,
      supplier: body.supplier,
    },
  });

  return NextResponse.json({ item }, { status: 201 });
}

export const GET = withAuth(getInventory);
export const POST = withAuth(createOrAdjustInventory, ['owner', 'admin', 'manager']);
