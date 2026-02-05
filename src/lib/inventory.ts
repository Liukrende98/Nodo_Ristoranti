/**
 * Inventory Module
 * 
 * Handles:
 * 1. Automatic stock deduction when order moves to "preparing"
 * 2. Manual adjustments (waste, receiving, corrections)
 * 3. Reorder suggestions based on stock levels and trends
 */

import prisma from './db';
import { emitToTenant } from './realtime';

// ─── Deduct Stock for Order ──────────────────────────────

/**
 * Deducts inventory for all items in an order based on recipes.
 * Called when order transitions to "preparing".
 */
export async function deductStockForOrder(
  tenantId: string,
  orderId: string
): Promise<void> {
  const orderItems = await prisma.orderItem.findMany({
    where: { orderId, tenantId },
    include: {
      menuItem: {
        include: {
          recipeIngredients: {
            include: { inventoryItem: true },
          },
        },
      },
    },
  });

  for (const item of orderItems) {
    for (const recipe of item.menuItem.recipeIngredients) {
      const deduction = Number(recipe.quantity) * item.quantity;

      // Atomic decrement
      await prisma.inventoryItem.update({
        where: { id: recipe.inventoryItemId },
        data: {
          currentStock: { decrement: deduction },
        },
      });

      // Record movement
      await prisma.inventoryMovement.create({
        data: {
          tenantId,
          inventoryItemId: recipe.inventoryItemId,
          quantity: -deduction,
          movementType: 'order_deduction',
          referenceId: orderId,
          notes: `Ordine ${orderId} - ${item.menuItem.name} x${item.quantity}`,
        },
      });

      // Check if below minimum → emit alert
      const updated = await prisma.inventoryItem.findUnique({
        where: { id: recipe.inventoryItemId },
      });

      if (updated && Number(updated.currentStock) <= Number(updated.minStock)) {
        emitToTenant(tenantId, 'inventory:alert', {
          itemId: updated.id,
          name: updated.name,
          currentStock: Number(updated.currentStock),
          minStock: Number(updated.minStock),
          unit: updated.unit,
        });
      }
    }
  }
}

// ─── Manual Adjustment ───────────────────────────────────

export async function adjustStock(
  tenantId: string,
  inventoryItemId: string,
  quantity: number,
  type: 'manual_add' | 'waste' | 'adjustment' | 'receiving',
  notes: string | null,
  userId: string
): Promise<void> {
  await prisma.inventoryItem.update({
    where: { id: inventoryItemId },
    data: {
      currentStock: { increment: quantity },
    },
  });

  await prisma.inventoryMovement.create({
    data: {
      tenantId,
      inventoryItemId,
      quantity,
      movementType: type,
      notes,
      createdBy: userId,
    },
  });
}

// ─── Reorder Suggestions ─────────────────────────────────

interface ReorderSuggestion {
  itemId: string;
  name: string;
  unit: string;
  currentStock: number;
  minStock: number;
  avgDailyUsage: number;
  daysUntilEmpty: number;
  suggestedOrder: number;
  supplier: string | null;
  urgency: 'critical' | 'warning' | 'info';
}

export async function getReorderSuggestions(
  tenantId: string
): Promise<ReorderSuggestion[]> {
  // Get items near or below minimum stock
  const items = await prisma.inventoryItem.findMany({
    where: {
      tenantId,
      isActive: true,
    },
  });

  // Get usage data from last 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const suggestions: ReorderSuggestion[] = [];

  for (const item of items) {
    // Calculate average daily usage
    const movements = await prisma.inventoryMovement.aggregate({
      where: {
        inventoryItemId: item.id,
        quantity: { lt: 0 }, // Only outgoing
        createdAt: { gte: sevenDaysAgo },
      },
      _sum: { quantity: true },
    });

    const totalUsed = Math.abs(Number(movements._sum.quantity) || 0);
    const avgDailyUsage = totalUsed / 7;
    const currentStock = Number(item.currentStock);
    const minStock = Number(item.minStock);

    const daysUntilEmpty =
      avgDailyUsage > 0 ? currentStock / avgDailyUsage : 999;

    // Determine urgency
    let urgency: 'critical' | 'warning' | 'info';
    if (currentStock <= 0) {
      urgency = 'critical';
    } else if (currentStock <= minStock) {
      urgency = 'critical';
    } else if (daysUntilEmpty <= 3) {
      urgency = 'warning';
    } else if (currentStock <= minStock * 1.5) {
      urgency = 'info';
    } else {
      continue; // No suggestion needed
    }

    // Suggest ordering enough for ~7 days
    const suggestedOrder = Math.max(
      minStock * 2 - currentStock,
      avgDailyUsage * 7
    );

    suggestions.push({
      itemId: item.id,
      name: item.name,
      unit: item.unit,
      currentStock,
      minStock,
      avgDailyUsage: Math.round(avgDailyUsage * 100) / 100,
      daysUntilEmpty: Math.round(daysUntilEmpty * 10) / 10,
      suggestedOrder: Math.ceil(suggestedOrder * 10) / 10,
      supplier: item.supplier,
      urgency,
    });
  }

  // Sort by urgency (critical first)
  const urgencyOrder = { critical: 0, warning: 1, info: 2 };
  suggestions.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency]);

  return suggestions;
}
