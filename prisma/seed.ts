import { PrismaClient, UserRole, OrderChannel } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// ─── WORKFLOW DEFINITIONS ────────────────────────────────

const WORKFLOW_PIZZA_MARGHERITA = {
  phases: [
    {
      id: 'phase_prep',
      name: 'Preparazione',
      order: 1,
      tasks: [
        {
          id: 'task_dough',
          name: 'Stendi impasto',
          station_type: 'forno',
          estimated_minutes: 3,
          depends_on: [],
          subtasks: [
            { id: 'sub_take_dough', name: 'Prendi pallina impasto', optional: false },
            { id: 'sub_stretch', name: 'Stendi e forma', optional: false },
          ],
        },
        {
          id: 'task_topping',
          name: 'Condimento',
          station_type: 'forno',
          estimated_minutes: 2,
          depends_on: ['task_dough'],
          subtasks: [
            { id: 'sub_sauce', name: 'Stendi salsa pomodoro', optional: false },
            { id: 'sub_mozzarella', name: 'Aggiungi mozzarella', optional: false },
            { id: 'sub_basil', name: 'Aggiungi basilico', optional: true },
          ],
        },
      ],
    },
    {
      id: 'phase_cook',
      name: 'Cottura',
      order: 2,
      tasks: [
        {
          id: 'task_bake',
          name: 'Cottura forno',
          station_type: 'forno',
          estimated_minutes: 8,
          depends_on: ['task_topping'],
          subtasks: [],
        },
      ],
    },
    {
      id: 'phase_finish',
      name: 'Finitura',
      order: 3,
      tasks: [
        {
          id: 'task_finish',
          name: 'Taglio e impiattamento',
          station_type: 'packaging',
          estimated_minutes: 1,
          depends_on: ['task_bake'],
          subtasks: [],
        },
      ],
    },
  ],
};

const WORKFLOW_WOK_NOODLES = {
  phases: [
    {
      id: 'phase_prep',
      name: 'Preparazione ingredienti',
      order: 1,
      tasks: [
        {
          id: 'task_cut_veggies',
          name: 'Taglia verdure',
          station_type: 'preparazione',
          estimated_minutes: 4,
          depends_on: [],
          subtasks: [
            { id: 'sub_wash', name: 'Lava verdure', optional: false },
            { id: 'sub_cut', name: 'Taglia a julienne', optional: false },
          ],
        },
        {
          id: 'task_prep_protein',
          name: 'Prepara proteina',
          station_type: 'preparazione',
          estimated_minutes: 3,
          depends_on: [],
          subtasks: [
            { id: 'sub_slice_protein', name: 'Taglia a strisce', optional: false },
            { id: 'sub_marinate', name: 'Marina con salsa', optional: false },
          ],
        },
      ],
    },
    {
      id: 'phase_cook',
      name: 'Cottura wok',
      order: 2,
      tasks: [
        {
          id: 'task_wok',
          name: 'Saltatura in wok',
          station_type: 'wok',
          estimated_minutes: 5,
          depends_on: ['task_cut_veggies', 'task_prep_protein'],
          subtasks: [
            { id: 'sub_heat_wok', name: 'Scalda wok', optional: false },
            { id: 'sub_cook_protein', name: 'Cuoci proteina', optional: false },
            { id: 'sub_add_veggies', name: 'Aggiungi verdure', optional: false },
            { id: 'sub_add_noodles', name: 'Aggiungi noodles + salsa', optional: false },
          ],
        },
      ],
    },
    {
      id: 'phase_plate',
      name: 'Impiattamento',
      order: 3,
      tasks: [
        {
          id: 'task_plate',
          name: 'Impiatta e guarnisci',
          station_type: 'packaging',
          estimated_minutes: 1,
          depends_on: ['task_wok'],
          subtasks: [],
        },
      ],
    },
  ],
};

const WORKFLOW_BURGER = {
  phases: [
    {
      id: 'phase_grill',
      name: 'Griglia',
      order: 1,
      tasks: [
        {
          id: 'task_grill_patty',
          name: 'Griglia hamburger',
          station_type: 'griglia',
          estimated_minutes: 6,
          depends_on: [],
          subtasks: [
            { id: 'sub_season', name: 'Condisci patty', optional: false },
            { id: 'sub_grill', name: 'Griglia (3 min per lato)', optional: false },
            { id: 'sub_cheese', name: 'Aggiungi formaggio', optional: true },
          ],
        },
        {
          id: 'task_toast_bun',
          name: 'Tosta panino',
          station_type: 'griglia',
          estimated_minutes: 2,
          depends_on: [],
          subtasks: [],
        },
      ],
    },
    {
      id: 'phase_assemble',
      name: 'Assemblaggio',
      order: 2,
      tasks: [
        {
          id: 'task_assemble',
          name: 'Assembla burger',
          station_type: 'packaging',
          estimated_minutes: 2,
          depends_on: ['task_grill_patty', 'task_toast_bun'],
          subtasks: [
            { id: 'sub_base', name: 'Salsa + insalata su bun', optional: false },
            { id: 'sub_patty_on', name: 'Posiziona patty', optional: false },
            { id: 'sub_toppings', name: 'Aggiungi toppings', optional: false },
            { id: 'sub_close', name: 'Chiudi e incarta', optional: false },
          ],
        },
      ],
    },
  ],
};

const WORKFLOW_BEVANDA = {
  phases: [
    {
      id: 'phase_prep',
      name: 'Preparazione',
      order: 1,
      tasks: [
        {
          id: 'task_bevanda',
          name: 'Prepara bevanda',
          station_type: 'bar',
          estimated_minutes: 1,
          depends_on: [],
          subtasks: [],
        },
      ],
    },
  ],
};

async function main() {
  console.log('🌱 Seeding database...');

  // ─── TENANT ──────────────────────────────
  const tenant = await prisma.tenant.create({
    data: {
      name: 'Ristorante Demo La Bella Cucina',
      slug: 'bella-cucina',
      settings: {
        timezone: 'Europe/Rome',
        currency: 'EUR',
        locale: 'it-IT',
        orderPrefix: 'BC',
      },
      plan: 'pro',
      planExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    },
  });

  console.log(`  ✅ Tenant: ${tenant.name} (${tenant.slug})`);

  // ─── USERS ───────────────────────────────
  const passwordHash = await bcrypt.hash('demo1234', 12);

  const users = await Promise.all([
    prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: 'owner@bellacucina.it',
        passwordHash,
        name: 'Marco Rossi',
        role: 'owner',
      },
    }),
    prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: 'manager@bellacucina.it',
        passwordHash,
        name: 'Laura Bianchi',
        role: 'manager',
      },
    }),
    prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: 'chef@bellacucina.it',
        passwordHash,
        name: 'Giuseppe Verdi',
        role: 'staff',
      },
    }),
    prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: 'pizzaiolo@bellacucina.it',
        passwordHash,
        name: 'Antonio Esposito',
        role: 'staff',
      },
    }),
    prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: 'wok@bellacucina.it',
        passwordHash,
        name: 'Chen Wei',
        role: 'staff',
      },
    }),
    prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: 'rider1@bellacucina.it',
        passwordHash,
        name: 'Luca Neri',
        role: 'delivery',
      },
    }),
    prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: 'rider2@bellacucina.it',
        passwordHash,
        name: 'Sara Gialli',
        role: 'delivery',
      },
    }),
  ]);

  console.log(`  ✅ Users: ${users.length} created`);

  // ─── STATIONS ────────────────────────────
  const stations = await Promise.all([
    prisma.station.create({
      data: {
        tenantId: tenant.id,
        name: 'Forno',
        capacity: 3,
        taskTypes: ['forno'],
        displayOrder: 1,
        settings: { color: '#ef4444', icon: 'flame' },
      },
    }),
    prisma.station.create({
      data: {
        tenantId: tenant.id,
        name: 'Wok',
        capacity: 2,
        taskTypes: ['wok'],
        displayOrder: 2,
        settings: { color: '#f59e0b', icon: 'chef-hat' },
      },
    }),
    prisma.station.create({
      data: {
        tenantId: tenant.id,
        name: 'Griglia',
        capacity: 2,
        taskTypes: ['griglia'],
        displayOrder: 3,
        settings: { color: '#8b5cf6', icon: 'beef' },
      },
    }),
    prisma.station.create({
      data: {
        tenantId: tenant.id,
        name: 'Preparazione',
        capacity: 3,
        taskTypes: ['preparazione'],
        displayOrder: 4,
        settings: { color: '#06b6d4', icon: 'scissors' },
      },
    }),
    prisma.station.create({
      data: {
        tenantId: tenant.id,
        name: 'Bar',
        capacity: 2,
        taskTypes: ['bar'],
        displayOrder: 5,
        settings: { color: '#10b981', icon: 'glass-water' },
      },
    }),
    prisma.station.create({
      data: {
        tenantId: tenant.id,
        name: 'Packaging',
        capacity: 2,
        taskTypes: ['packaging'],
        displayOrder: 6,
        settings: { color: '#6366f1', icon: 'package' },
      },
    }),
  ]);

  const stationMap = Object.fromEntries(stations.map((s) => [s.name.toLowerCase(), s]));
  console.log(`  ✅ Stations: ${stations.length} created`);

  // ─── WORKFLOW TEMPLATES ──────────────────
  const workflows = await Promise.all([
    prisma.workflowTemplate.create({
      data: {
        tenantId: tenant.id,
        name: 'Pizza Margherita',
        category: 'pizza',
        definition: WORKFLOW_PIZZA_MARGHERITA,
        estimatedTotalMinutes: 14,
      },
    }),
    prisma.workflowTemplate.create({
      data: {
        tenantId: tenant.id,
        name: 'Wok Noodles',
        category: 'wok',
        definition: WORKFLOW_WOK_NOODLES,
        estimatedTotalMinutes: 13,
      },
    }),
    prisma.workflowTemplate.create({
      data: {
        tenantId: tenant.id,
        name: 'Classic Burger',
        category: 'grill',
        definition: WORKFLOW_BURGER,
        estimatedTotalMinutes: 10,
      },
    }),
    prisma.workflowTemplate.create({
      data: {
        tenantId: tenant.id,
        name: 'Bevanda',
        category: 'bevande',
        definition: WORKFLOW_BEVANDA,
        estimatedTotalMinutes: 1,
      },
    }),
  ]);

  console.log(`  ✅ Workflows: ${workflows.length} created`);

  // ─── INVENTORY ───────────────────────────
  const inventoryItems = await Promise.all([
    prisma.inventoryItem.create({ data: { tenantId: tenant.id, name: 'Farina 00', unit: 'kg', currentStock: 50, minStock: 10, costPerUnit: 1.2, supplier: 'Molino Grassi' } }),
    prisma.inventoryItem.create({ data: { tenantId: tenant.id, name: 'Mozzarella', unit: 'kg', currentStock: 20, minStock: 5, costPerUnit: 8.0, supplier: 'Latteria Sorrentina' } }),
    prisma.inventoryItem.create({ data: { tenantId: tenant.id, name: 'Pomodoro pelati', unit: 'kg', currentStock: 30, minStock: 8, costPerUnit: 2.5, supplier: 'Mutti' } }),
    prisma.inventoryItem.create({ data: { tenantId: tenant.id, name: 'Basilico fresco', unit: 'mazzo', currentStock: 15, minStock: 3, costPerUnit: 0.5, supplier: 'Orto locale' } }),
    prisma.inventoryItem.create({ data: { tenantId: tenant.id, name: 'Olio EVO', unit: 'litri', currentStock: 10, minStock: 3, costPerUnit: 12.0, supplier: 'Frantoi Ferrara' } }),
    prisma.inventoryItem.create({ data: { tenantId: tenant.id, name: 'Noodles', unit: 'kg', currentStock: 15, minStock: 4, costPerUnit: 3.0, supplier: 'Asia Market' } }),
    prisma.inventoryItem.create({ data: { tenantId: tenant.id, name: 'Verdure miste', unit: 'kg', currentStock: 12, minStock: 3, costPerUnit: 4.0, supplier: 'Mercato ortofrutticolo' } }),
    prisma.inventoryItem.create({ data: { tenantId: tenant.id, name: 'Pollo', unit: 'kg', currentStock: 10, minStock: 3, costPerUnit: 7.0, supplier: 'Macelleria Bini' } }),
    prisma.inventoryItem.create({ data: { tenantId: tenant.id, name: 'Salsa soia', unit: 'litri', currentStock: 5, minStock: 1, costPerUnit: 5.0, supplier: 'Asia Market' } }),
    prisma.inventoryItem.create({ data: { tenantId: tenant.id, name: 'Hamburger patty', unit: 'pezzi', currentStock: 40, minStock: 10, costPerUnit: 2.5, supplier: 'Macelleria Bini' } }),
    prisma.inventoryItem.create({ data: { tenantId: tenant.id, name: 'Panini burger', unit: 'pezzi', currentStock: 40, minStock: 10, costPerUnit: 0.8, supplier: 'Panificio Roma' } }),
    prisma.inventoryItem.create({ data: { tenantId: tenant.id, name: 'Cheddar', unit: 'kg', currentStock: 5, minStock: 1, costPerUnit: 12.0, supplier: 'Latteria Sorrentina' } }),
    prisma.inventoryItem.create({ data: { tenantId: tenant.id, name: 'Coca Cola 33cl', unit: 'pezzi', currentStock: 48, minStock: 12, costPerUnit: 0.6, supplier: 'Beverage Italia' } }),
    prisma.inventoryItem.create({ data: { tenantId: tenant.id, name: 'Acqua 50cl', unit: 'pezzi', currentStock: 60, minStock: 12, costPerUnit: 0.2, supplier: 'Beverage Italia' } }),
  ]);

  const invMap = Object.fromEntries(inventoryItems.map((i) => [i.name, i]));
  console.log(`  ✅ Inventory: ${inventoryItems.length} items created`);

  // ─── MENU ITEMS ──────────────────────────
  const menuItems = await Promise.all([
    prisma.menuItem.create({
      data: {
        tenantId: tenant.id,
        name: 'Pizza Margherita',
        category: 'Pizze',
        price: 8.50,
        workflowTemplateId: workflows[0].id,
        displayOrder: 1,
        recipeIngredients: {
          createMany: {
            data: [
              { tenantId: tenant.id, inventoryItemId: invMap['Farina 00'].id, quantity: 0.25 },
              { tenantId: tenant.id, inventoryItemId: invMap['Mozzarella'].id, quantity: 0.15 },
              { tenantId: tenant.id, inventoryItemId: invMap['Pomodoro pelati'].id, quantity: 0.1 },
              { tenantId: tenant.id, inventoryItemId: invMap['Basilico fresco'].id, quantity: 0.1 },
              { tenantId: tenant.id, inventoryItemId: invMap['Olio EVO'].id, quantity: 0.02 },
            ],
          },
        },
      },
    }),
    prisma.menuItem.create({
      data: {
        tenantId: tenant.id,
        name: 'Wok Noodles Pollo',
        category: 'Wok',
        price: 11.00,
        workflowTemplateId: workflows[1].id,
        displayOrder: 2,
        recipeIngredients: {
          createMany: {
            data: [
              { tenantId: tenant.id, inventoryItemId: invMap['Noodles'].id, quantity: 0.2 },
              { tenantId: tenant.id, inventoryItemId: invMap['Verdure miste'].id, quantity: 0.15 },
              { tenantId: tenant.id, inventoryItemId: invMap['Pollo'].id, quantity: 0.15 },
              { tenantId: tenant.id, inventoryItemId: invMap['Salsa soia'].id, quantity: 0.03 },
              { tenantId: tenant.id, inventoryItemId: invMap['Olio EVO'].id, quantity: 0.02 },
            ],
          },
        },
      },
    }),
    prisma.menuItem.create({
      data: {
        tenantId: tenant.id,
        name: 'Classic Cheeseburger',
        category: 'Burger',
        price: 10.50,
        workflowTemplateId: workflows[2].id,
        displayOrder: 3,
        recipeIngredients: {
          createMany: {
            data: [
              { tenantId: tenant.id, inventoryItemId: invMap['Hamburger patty'].id, quantity: 1 },
              { tenantId: tenant.id, inventoryItemId: invMap['Panini burger'].id, quantity: 1 },
              { tenantId: tenant.id, inventoryItemId: invMap['Cheddar'].id, quantity: 0.04 },
              { tenantId: tenant.id, inventoryItemId: invMap['Verdure miste'].id, quantity: 0.05 },
            ],
          },
        },
      },
    }),
    prisma.menuItem.create({
      data: {
        tenantId: tenant.id,
        name: 'Coca Cola 33cl',
        category: 'Bevande',
        price: 3.00,
        workflowTemplateId: workflows[3].id,
        displayOrder: 10,
        recipeIngredients: {
          createMany: {
            data: [
              { tenantId: tenant.id, inventoryItemId: invMap['Coca Cola 33cl'].id, quantity: 1 },
            ],
          },
        },
      },
    }),
    prisma.menuItem.create({
      data: {
        tenantId: tenant.id,
        name: 'Acqua 50cl',
        category: 'Bevande',
        price: 1.50,
        workflowTemplateId: workflows[3].id,
        displayOrder: 11,
        recipeIngredients: {
          createMany: {
            data: [
              { tenantId: tenant.id, inventoryItemId: invMap['Acqua 50cl'].id, quantity: 1 },
            ],
          },
        },
      },
    }),
  ]);

  console.log(`  ✅ Menu Items: ${menuItems.length} created`);

  // ─── SHIFTS (today) ──────────────────────
  const today = new Date();
  today.setHours(10, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 0, 0, 0);

  await Promise.all([
    prisma.shift.create({ data: { tenantId: tenant.id, userId: users[3].id, stationId: stationMap['forno'].id, startsAt: today, endsAt: endOfDay } }),
    prisma.shift.create({ data: { tenantId: tenant.id, userId: users[4].id, stationId: stationMap['wok'].id, startsAt: today, endsAt: endOfDay } }),
    prisma.shift.create({ data: { tenantId: tenant.id, userId: users[2].id, stationId: stationMap['griglia'].id, startsAt: today, endsAt: endOfDay } }),
  ]);

  console.log(`  ✅ Shifts: 3 created for today`);

  console.log('\n🎉 Seed complete!');
  console.log('\n📋 Demo accounts:');
  console.log('   Owner:   owner@bellacucina.it / demo1234');
  console.log('   Manager: manager@bellacucina.it / demo1234');
  console.log('   Chef:    chef@bellacucina.it / demo1234');
  console.log('   Rider:   rider1@bellacucina.it / demo1234');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
