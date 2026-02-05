# OpsOS — Architecture & Data Model

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      CLIENTS                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │ Admin UI │  │   KDS    │  │ Delivery │  │Phone Op │ │
│  │(Desktop) │  │(Tablet)  │  │ (Mobile) │  │(Desktop)│ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬────┘ │
└───────┼──────────────┼────────────┼──────────────┼──────┘
        │              │            │              │
        ▼              ▼            ▼              ▼
┌─────────────────────────────────────────────────────────┐
│                   NEXT.JS APPLICATION                    │
│  ┌─────────────────────────────────────────────────────┐│
│  │              Server Components (SSR)                ││
│  │   Dashboard │ Admin Pages │ Reports │ Config        ││
│  └─────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────┐│
│  │              API Routes (/api/*)                     ││
│  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────────┐ ││
│  │  │  Auth  │ │ Orders │ │Workflow│ │  Inventory   │ ││
│  │  │Module  │ │ Module │ │ Engine │ │   Module     │ ││
│  │  └────────┘ └────────┘ └────────┘ └──────────────┘ ││
│  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────────┐ ││
│  │  │Station │ │  ETA   │ │Delivery│ │  Analytics   │ ││
│  │  │Module  │ │ Calc.  │ │ Module │ │   Module     │ ││
│  │  └────────┘ └────────┘ └────────┘ └──────────────┘ ││
│  └─────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────┐│
│  │           Middleware Layer                           ││
│  │  Auth │ Tenant Isolation │ Rate Limit │ Audit Log   ││
│  └─────────────────────────────────────────────────────┘│
└──────────┬──────────────┬───────────────┬───────────────┘
           │              │               │
           ▼              ▼               ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  PostgreSQL  │  │    Redis     │  │  Socket.io   │
│              │  │              │  │   Server     │
│ • Tables     │  │ • BullMQ     │  │              │
│ • RLS        │  │ • Cache      │  │ • Rooms per  │
│ • Indexes    │  │ • Sessions   │  │   tenant     │
│ • Audit      │  │              │  │ • Events     │
└──────────────┘  └──────────────┘  └──────────────┘
```

## 2. Module Dependency Graph

```
Auth ──────────────────────────────────────────┐
  │                                             │
  ▼                                             ▼
Tenant ──► Station ──► Workflow Engine ──► ETA Calculator
  │            │              │                  │
  ▼            ▼              ▼                  ▼
Users    Staff/Shifts    Order Module ◄──── Real-time
  │                          │                  │
  ▼                          ▼                  ▼
RBAC                    Inventory          KDS / Board
                             │
                             ▼
                        Analytics
```

## 3. Request Flow

```
Client Request
     │
     ▼
[Rate Limiter] → 429 if exceeded
     │
     ▼
[Auth Middleware] → 401 if no valid token
     │
     ▼
[Tenant Middleware] → Injects tenant_id from JWT
     │
     ▼
[RBAC Middleware] → 403 if insufficient permissions
     │
     ▼
[API Handler] → Business Logic
     │
     ├──► [Prisma + tenant_id filter] → PostgreSQL
     ├──► [Redis Cache] → Cache hit/miss
     ├──► [BullMQ] → Async jobs (ETA, inventory, analytics)
     └──► [Socket.io] → Real-time broadcast to tenant room
     │
     ▼
[Audit Logger] → Logs action
     │
     ▼
Response (JSON)
```

## 4. Real-time Event Flow

```
Task Completed (Staff touches KDS)
     │
     ▼
POST /api/tasks/:id/complete
     │
     ├──► DB: Update task status + timestamp
     ├──► BullMQ: Enqueue ETA recalculation job
     ├──► BullMQ: Enqueue inventory deduction (if phase = "preparazione")
     └──► Socket.io: Emit to tenant room
              │
              ├──► "task:updated" → KDS refreshes
              ├──► "order:updated" → Dashboard refreshes
              └──► "eta:updated" → Phone operator sees new ETA
```

---

## 5. Data Model

### Entity Relationship (Simplified)

```
tenants ─┬── users ──── user_sessions
         ├── stations ── station_capabilities
         ├── menu_items ── recipe_ingredients ── inventory_items
         ├── workflow_templates ── wf_phases ── wf_tasks
         ├── orders ── order_items ── task_instances ── subtask_instances
         ├── delivery_assignments
         ├── shifts
         └── audit_logs
```

### Tables Detail

#### tenants
```sql
id              UUID PK DEFAULT gen_random_uuid()
name            VARCHAR(255) NOT NULL
slug            VARCHAR(100) UNIQUE NOT NULL  -- subdomain/identifier
settings        JSONB DEFAULT '{}'            -- timezone, currency, locale, etc.
plan            VARCHAR(50) DEFAULT 'trial'   -- trial/basic/pro/enterprise
plan_expires_at TIMESTAMPTZ
is_active       BOOLEAN DEFAULT true
created_at      TIMESTAMPTZ DEFAULT now()
updated_at      TIMESTAMPTZ DEFAULT now()

INDEX: idx_tenants_slug ON (slug)
```

#### users
```sql
id              UUID PK DEFAULT gen_random_uuid()
tenant_id       UUID FK → tenants(id) NOT NULL
email           VARCHAR(255) NOT NULL
password_hash   VARCHAR(255) NOT NULL         -- bcrypt
name            VARCHAR(255) NOT NULL
role            ENUM('owner','admin','manager','staff','delivery') NOT NULL
is_active       BOOLEAN DEFAULT true
last_login_at   TIMESTAMPTZ
created_at      TIMESTAMPTZ DEFAULT now()
updated_at      TIMESTAMPTZ DEFAULT now()

UNIQUE: uq_users_tenant_email ON (tenant_id, email)
INDEX: idx_users_tenant ON (tenant_id)
```

#### stations
```sql
id              UUID PK DEFAULT gen_random_uuid()
tenant_id       UUID FK → tenants(id) NOT NULL
name            VARCHAR(255) NOT NULL         -- "Forno", "Wok", "Packaging"
capacity        INT DEFAULT 1                 -- max concurrent tasks
task_types      TEXT[] DEFAULT '{}'            -- types of tasks this station handles
is_active       BOOLEAN DEFAULT true
display_order   INT DEFAULT 0
settings        JSONB DEFAULT '{}'            -- color, icon, etc.
created_at      TIMESTAMPTZ DEFAULT now()

UNIQUE: uq_stations_tenant_name ON (tenant_id, name)
INDEX: idx_stations_tenant ON (tenant_id)
```

#### workflow_templates
```sql
id              UUID PK DEFAULT gen_random_uuid()
tenant_id       UUID FK → tenants(id) NOT NULL
name            VARCHAR(255) NOT NULL         -- "Pizza Margherita", "Wok Noodles"
category        VARCHAR(100)                  -- "pizza", "wok", "bevanda"
definition      JSONB NOT NULL                -- Full workflow definition (see schema below)
estimated_total_minutes  DECIMAL(6,1)         -- Cached total estimate
is_active       BOOLEAN DEFAULT true
created_at      TIMESTAMPTZ DEFAULT now()
updated_at      TIMESTAMPTZ DEFAULT now()

INDEX: idx_wf_templates_tenant ON (tenant_id)
INDEX: idx_wf_templates_category ON (tenant_id, category)
```

**Workflow Definition JSON Schema:**
```json
{
  "phases": [
    {
      "id": "phase_prep",
      "name": "Preparazione",
      "order": 1,
      "tasks": [
        {
          "id": "task_dough",
          "name": "Stendi impasto",
          "station_type": "forno",
          "estimated_minutes": 3,
          "depends_on": [],
          "subtasks": [
            { "id": "sub_1", "name": "Prendi pallina impasto", "optional": false },
            { "id": "sub_2", "name": "Stendi e forma", "optional": false }
          ]
        },
        {
          "id": "task_topping",
          "name": "Condimento",
          "station_type": "forno",
          "estimated_minutes": 2,
          "depends_on": ["task_dough"],
          "subtasks": []
        }
      ]
    },
    {
      "id": "phase_cook",
      "name": "Cottura",
      "order": 2,
      "tasks": [
        {
          "id": "task_bake",
          "name": "Inforna",
          "station_type": "forno",
          "estimated_minutes": 8,
          "depends_on": ["task_topping"],
          "subtasks": []
        }
      ]
    }
  ]
}
```

#### menu_items
```sql
id              UUID PK DEFAULT gen_random_uuid()
tenant_id       UUID FK → tenants(id) NOT NULL
name            VARCHAR(255) NOT NULL
category        VARCHAR(100)
price           DECIMAL(10,2) NOT NULL
workflow_template_id  UUID FK → workflow_templates(id)  -- linked workflow
is_available    BOOLEAN DEFAULT true
display_order   INT DEFAULT 0
created_at      TIMESTAMPTZ DEFAULT now()

INDEX: idx_menu_items_tenant ON (tenant_id)
```

#### inventory_items
```sql
id              UUID PK DEFAULT gen_random_uuid()
tenant_id       UUID FK → tenants(id) NOT NULL
name            VARCHAR(255) NOT NULL
unit            VARCHAR(50) NOT NULL          -- "kg", "litri", "pezzi"
current_stock   DECIMAL(10,3) DEFAULT 0
min_stock       DECIMAL(10,3) DEFAULT 0       -- reorder threshold
cost_per_unit   DECIMAL(10,4)
supplier        VARCHAR(255)
is_active       BOOLEAN DEFAULT true
created_at      TIMESTAMPTZ DEFAULT now()
updated_at      TIMESTAMPTZ DEFAULT now()

UNIQUE: uq_inventory_tenant_name ON (tenant_id, name)
INDEX: idx_inventory_tenant ON (tenant_id)
INDEX: idx_inventory_low_stock ON (tenant_id, current_stock, min_stock)
```

#### recipe_ingredients
```sql
id              UUID PK DEFAULT gen_random_uuid()
menu_item_id    UUID FK → menu_items(id) NOT NULL
inventory_item_id UUID FK → inventory_items(id) NOT NULL
quantity        DECIMAL(10,3) NOT NULL        -- amount per 1 unit of menu item
tenant_id       UUID FK → tenants(id) NOT NULL

INDEX: idx_recipe_menu_item ON (menu_item_id)
```

#### orders
```sql
id              UUID PK DEFAULT gen_random_uuid()
tenant_id       UUID FK → tenants(id) NOT NULL
order_number    SERIAL                        -- human-readable, per tenant
channel         ENUM('phone','in_store','online','import') NOT NULL
status          VARCHAR(50) DEFAULT 'new'     -- new/preparing/ready/delivering/delivered/cancelled
customer_name   VARCHAR(255)
customer_phone  VARCHAR(50)
customer_address TEXT                         -- for delivery
notes           TEXT
priority        INT DEFAULT 0                 -- 0=normal, 1=high, 2=urgent
requested_at    TIMESTAMPTZ                   -- customer requested time
estimated_ready_at TIMESTAMPTZ               -- calculated ETA
actual_ready_at TIMESTAMPTZ
total_amount    DECIMAL(10,2)
created_by      UUID FK → users(id)
created_at      TIMESTAMPTZ DEFAULT now()
updated_at      TIMESTAMPTZ DEFAULT now()

INDEX: idx_orders_tenant_status ON (tenant_id, status)
INDEX: idx_orders_tenant_date ON (tenant_id, created_at DESC)
INDEX: idx_orders_number ON (tenant_id, order_number)
```

#### order_items
```sql
id              UUID PK DEFAULT gen_random_uuid()
order_id        UUID FK → orders(id) NOT NULL
menu_item_id    UUID FK → menu_items(id) NOT NULL
tenant_id       UUID FK → tenants(id) NOT NULL
quantity        INT NOT NULL DEFAULT 1
unit_price      DECIMAL(10,2) NOT NULL
modifications   TEXT                          -- "senza cipolla, extra mozzarella"
notes           TEXT
status          VARCHAR(50) DEFAULT 'pending' -- pending/in_progress/done/cancelled

INDEX: idx_order_items_order ON (order_id)
```

#### task_instances (runtime workflow execution)
```sql
id              UUID PK DEFAULT gen_random_uuid()
tenant_id       UUID FK → tenants(id) NOT NULL
order_id        UUID FK → orders(id) NOT NULL
order_item_id   UUID FK → order_items(id) NOT NULL
task_def_id     VARCHAR(100) NOT NULL         -- references workflow JSON task.id
phase_def_id    VARCHAR(100) NOT NULL         -- references workflow JSON phase.id
name            VARCHAR(255) NOT NULL
station_id      UUID FK → stations(id)
assigned_to     UUID FK → users(id)
status          VARCHAR(50) DEFAULT 'pending' -- pending/queued/in_progress/done/blocked/cancelled
depends_on      UUID[]                        -- task_instance IDs
estimated_minutes DECIMAL(6,1)
started_at      TIMESTAMPTZ
completed_at    TIMESTAMPTZ
completed_by    UUID FK → users(id)
queue_position  INT                           -- position in station queue
created_at      TIMESTAMPTZ DEFAULT now()

INDEX: idx_tasks_tenant_status ON (tenant_id, status)
INDEX: idx_tasks_station ON (station_id, status)
INDEX: idx_tasks_order ON (order_id)
INDEX: idx_tasks_order_item ON (order_item_id)
```

#### subtask_instances
```sql
id              UUID PK DEFAULT gen_random_uuid()
task_instance_id UUID FK → task_instances(id) NOT NULL
tenant_id       UUID FK → tenants(id) NOT NULL
subtask_def_id  VARCHAR(100) NOT NULL
name            VARCHAR(255) NOT NULL
is_completed    BOOLEAN DEFAULT false
completed_at    TIMESTAMPTZ
completed_by    UUID FK → users(id)

INDEX: idx_subtasks_task ON (task_instance_id)
```

#### delivery_assignments
```sql
id              UUID PK DEFAULT gen_random_uuid()
tenant_id       UUID FK → tenants(id) NOT NULL
order_id        UUID FK → orders(id) NOT NULL
rider_id        UUID FK → users(id)           -- user with role=delivery
status          VARCHAR(50) DEFAULT 'pending' -- pending/assigned/picked_up/delivered/failed
assigned_at     TIMESTAMPTZ
picked_up_at    TIMESTAMPTZ
delivered_at    TIMESTAMPTZ
notes           TEXT
created_at      TIMESTAMPTZ DEFAULT now()

INDEX: idx_delivery_tenant_status ON (tenant_id, status)
INDEX: idx_delivery_rider ON (rider_id, status)
```

#### shifts
```sql
id              UUID PK DEFAULT gen_random_uuid()
tenant_id       UUID FK → tenants(id) NOT NULL
user_id         UUID FK → users(id) NOT NULL
station_id      UUID FK → stations(id)        -- assigned station
starts_at       TIMESTAMPTZ NOT NULL
ends_at         TIMESTAMPTZ NOT NULL
is_active       BOOLEAN DEFAULT true
created_at      TIMESTAMPTZ DEFAULT now()

INDEX: idx_shifts_tenant_date ON (tenant_id, starts_at, ends_at)
INDEX: idx_shifts_user ON (user_id, starts_at)
```

#### task_durations (historical for ETA)
```sql
id              UUID PK DEFAULT gen_random_uuid()
tenant_id       UUID FK → tenants(id) NOT NULL
workflow_template_id UUID FK → workflow_templates(id)
task_def_id     VARCHAR(100) NOT NULL
station_id      UUID FK → stations(id)
duration_seconds INT NOT NULL
recorded_at     TIMESTAMPTZ DEFAULT now()

INDEX: idx_durations_lookup ON (tenant_id, workflow_template_id, task_def_id)
-- Keep last 100 per combination for moving average
```

#### audit_logs
```sql
id              UUID PK DEFAULT gen_random_uuid()
tenant_id       UUID FK → tenants(id) NOT NULL
user_id         UUID FK → users(id)
action          VARCHAR(100) NOT NULL         -- "order.create", "task.complete", "user.login"
entity_type     VARCHAR(100)
entity_id       UUID
details         JSONB
ip_address      INET
created_at      TIMESTAMPTZ DEFAULT now()

INDEX: idx_audit_tenant_date ON (tenant_id, created_at DESC)
INDEX: idx_audit_user ON (user_id, created_at DESC)
```

#### inventory_movements
```sql
id              UUID PK DEFAULT gen_random_uuid()
tenant_id       UUID FK → tenants(id) NOT NULL
inventory_item_id UUID FK → inventory_items(id) NOT NULL
quantity        DECIMAL(10,3) NOT NULL        -- positive=in, negative=out
movement_type   VARCHAR(50) NOT NULL          -- "order_deduction", "manual_add", "waste", "adjustment"
reference_id    UUID                          -- order_id or null
notes           TEXT
created_by      UUID FK → users(id)
created_at      TIMESTAMPTZ DEFAULT now()

INDEX: idx_inv_movements_item ON (inventory_item_id, created_at DESC)
INDEX: idx_inv_movements_tenant ON (tenant_id, created_at DESC)
```

---

## 6. API Specification

### Auth
```
POST   /api/auth/login          { email, password } → { accessToken, user }
POST   /api/auth/refresh        (httpOnly cookie)   → { accessToken }
POST   /api/auth/logout         → 200
GET    /api/auth/me             → { user, tenant }
```

### Orders
```
GET    /api/orders              ?status=&date=&page=&limit=  → { orders[], total }
GET    /api/orders/:id          → { order, items, tasks }
POST   /api/orders              { channel, customer*, items[], notes, requested_at }
PATCH  /api/orders/:id          { status, priority, notes }
DELETE /api/orders/:id          (soft cancel)
GET    /api/orders/:id/eta      → { estimated_ready_at, breakdown[] }
```

### Tasks
```
GET    /api/tasks               ?station_id=&status=&order_id=  → { tasks[] }
POST   /api/tasks/:id/start     → { task }
POST   /api/tasks/:id/complete  → { task }
POST   /api/tasks/:id/subtasks/:subId/complete  → { subtask }
POST   /api/tasks/:id/assign    { user_id, station_id }
```

### Stations
```
GET    /api/stations            → { stations[] }
POST   /api/stations            { name, capacity, task_types }
PATCH  /api/stations/:id        { name, capacity, ... }
GET    /api/stations/:id/queue  → { tasks[], load_percent }
```

### Menu Items
```
GET    /api/menu                ?category=  → { items[] }
POST   /api/menu                { name, price, category, workflow_template_id, recipe[] }
PATCH  /api/menu/:id            { ... }
DELETE /api/menu/:id            (soft delete)
```

### Workflow Templates
```
GET    /api/workflows           → { templates[] }
GET    /api/workflows/:id       → { template, definition }
POST   /api/workflows           { name, category, definition }
PATCH  /api/workflows/:id       { definition }
```

### Inventory
```
GET    /api/inventory           ?below_min=true  → { items[] }
POST   /api/inventory           { name, unit, current_stock, min_stock }
PATCH  /api/inventory/:id       { current_stock, min_stock }
POST   /api/inventory/:id/adjust  { quantity, type, notes }
GET    /api/inventory/reorder-suggestions  → { items[], reason }
GET    /api/inventory/movements ?item_id=&from=&to=  → { movements[] }
```

### Delivery
```
GET    /api/deliveries          ?status=  → { deliveries[] }
POST   /api/deliveries/:id/assign    { rider_id }
POST   /api/deliveries/:id/pickup    → { delivery }
POST   /api/deliveries/:id/deliver   → { delivery }
```

### Dashboard / Analytics
```
GET    /api/analytics/today     → { orders_count, avg_prep_time, delays, revenue, top_items }
GET    /api/analytics/stations  → { station_loads[], bottlenecks[] }
GET    /api/analytics/eta-accuracy → { predicted_vs_actual[] }
```

### Users / Staff
```
GET    /api/users               → { users[] }
POST   /api/users               { email, name, role, password }
PATCH  /api/users/:id           { name, role, is_active }
GET    /api/shifts/today        → { shifts[] }
POST   /api/shifts              { user_id, station_id, starts_at, ends_at }
```

### Audit
```
GET    /api/audit               ?action=&user_id=&from=&to=  → { logs[], total }
```

---

## 7. Real-time Events (Socket.io)

### Client → Server
```
join_tenant     { tenant_id }       -- Join tenant room
join_station    { station_id }      -- Join station-specific room
```

### Server → Client (broadcast to tenant room)
```
order:created       { order }
order:updated       { order_id, changes }
task:updated        { task_id, status, order_id }
task:completed      { task_id, order_id, station_id, completed_by }
eta:recalculated    { order_id, new_eta, breakdown }
delivery:updated    { delivery_id, status }
station:load        { station_id, queue_length, load_percent }
inventory:alert     { item_id, name, current_stock, min_stock }
```
