# OpsOS — Offline-First Architecture

## Design Philosophy

**Internet = bonus. Senza internet = operatività piena.**

L'app è progettata come se il server non esistesse. Ogni azione dell'utente scrive prima su IndexedDB locale, poi sincronizza in background quando c'è connessione.

L'operatore NON deve mai sapere o preoccuparsi dello stato della rete.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER INTERFACE                           │
│                                                                  │
│  "Tocca per completare"  →  INSTANT  ←  "Nuovo ordine"          │
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐     │
│  │              Dexie Live Queries                         │     │
│  │   (Reactive — UI si aggiorna quando IndexedDB cambia)  │     │
│  └──────────┬─────────────────────────────────┬───────────┘     │
└─────────────┼─────────────────────────────────┼─────────────────┘
              │ READ                             │ WRITE
              ▼                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                      IndexedDB (Dexie)                           │
│                                                                  │
│  ┌──────────┐ ┌────────┐ ┌───────┐ ┌──────────┐ ┌───────────┐ │
│  │  Orders  │ │ Tasks  │ │ Menu  │ │ Stations │ │ Inventory │ │
│  └──────────┘ └────────┘ └───────┘ └──────────┘ └───────────┘ │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    Sync Events Queue                      │    │
│  │  [pending] → [syncing] → [synced]                        │    │
│  │                        → [failed] → retry                 │    │
│  │                        → [conflict] → server wins         │    │
│  └─────────────────────────────────────────────────────────┘    │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                    SYNC ENGINE
                    (background)
                           │
              ┌────────────┼────────────┐
              │ PUSH       │            │ PULL
              │ (events →  │            │ (server →
              │  server)   │            │  local)
              ▼            │            ▼
┌─────────────────────────────────────────────────────────────────┐
│                         SERVER (Next.js)                         │
│                                                                  │
│  ┌────────────┐  ┌──────────────┐  ┌────────────────────┐      │
│  │  API Routes │  │  PostgreSQL  │  │  Socket.io Events  │      │
│  └────────────┘  └──────────────┘  └────────────────────┘      │
└─────────────────────────────────────────────────────────────────┘
              ▲
              │
      ┌───────────────┐
      │ Service Worker │
      │                │
      │ • Cache app    │
      │ • Offline load │
      │ • BG sync      │
      └───────────────┘
```

## Data Flow Per Action

### Esempio: Staff tocca "Completato" su task (KDS)

```
1. [0ms]   UI handler chiama completeTaskOffline()
2. [1ms]   IndexedDB: task.status = 'done' ← ISTANTANEO
3. [1ms]   IndexedDB: dependent tasks → status = 'queued'
4. [1ms]   IndexedDB: check order completion
5. [2ms]   SyncEvent creato: { type: 'task.complete', status: 'pending' }
6. [2ms]   Dexie Live Query rileva cambio → UI si aggiorna
7. [2ms]   ✅ L'utente vede il task come completato

8. [100ms] Sync Engine notificato → prende evento dalla coda
9. [100ms] POST /api/tasks { action: 'complete', taskId: '...' }
10. [300ms] Server risponde 200 → markEventSynced()
11.         (oppure offline → evento resta 'pending', retry in 5s)
```

**Tempo percepito dall'utente: ~2ms** (non i ~300ms di un round-trip server).

---

## Conflict Resolution

### Strategia: Server-Authoritative + Last-Write-Wins

| Scenario | Risoluzione |
|----------|-------------|
| Stesso task completato da 2 persone | Server accetta il primo, secondo riceve 200 (idempotente) |
| Ordine modificato offline + online | Server vince, pull sovrascrive locale |
| Nuovo ordine creato offline | Server assegna orderNumber, locale si aggiorna al sync |
| Inventario aggiustato da 2 parti | Additive: entrambe le modifiche applicate |

### Perché funziona per un ristorante:
- Le azioni sono quasi sempre **unidirezionali** (pending → done)
- Due cuochi non completano lo stesso task
- I conflitti reali sono rari in un singolo locale
- Il server è authoritative: se c'è dubbio, il pull del server corregge

---

## Service Worker Strategy

| Risorsa | Strategia | Perché |
|---------|-----------|--------|
| HTML Pages | Network-first, cache fallback | Serve sempre l'ultima versione, ma funziona offline |
| /_next/static/* | Cache-first | JS/CSS con hash non cambiano mai |
| /api/* GET | Network-first, cache fallback | Dati freschi quando possibile, cache altrimenti |
| /api/* POST | Non cached (gestito da Sync Engine) | Le mutazioni passano dalla coda eventi |

---

## IndexedDB Schema

```
Database: "opsos" (Dexie v1)

Tables:
  orders          — Ordini (pk: id, idx: tenantId+status, tenantId+createdAt)
  orderItems      — Righe ordine (pk: id, idx: orderId)
  tasks           — Task instances (pk: id, idx: tenantId+status, stationId+status)
  subtasks        — Subtask instances (pk: id, idx: taskInstanceId)
  stations        — Postazioni (pk: id, idx: tenantId)
  menuItems       — Menu (pk: id, idx: tenantId+isAvailable)
  workflowTemplates — Templates (pk: id, idx: tenantId)
  inventoryItems  — Inventario (pk: id, idx: tenantId)
  deliveries      — Consegne (pk: id, idx: tenantId+status)
  users           — Staff (pk: id, idx: tenantId+role)
  syncEvents      — Coda sync (pk: id, idx: status+timestamp, sequence)
  syncMeta        — Metadata sync (pk: key)
```

Ogni record ha `_syncStatus`: `'local' | 'synced' | 'modified' | 'conflict'`

---

## Sync Engine Lifecycle

```
App Boot
  │
  ├── Register Service Worker
  ├── Start Sync Engine
  │     ├── Listen: online/offline events
  │     ├── Listen: new sync events (from queue)
  │     ├── Interval: push events every 5s
  │     ├── Interval: pull server state every 15s
  │     └── Interval: cleanup synced events every 5min
  │
  └── Initial Sync (if online)
        ├── Push: all pending events
        └── Pull: stations, menu, workflows, users, active orders/tasks
```

## Key Dependencies

| Library | Purpose | Size |
|---------|---------|------|
| **Dexie** | IndexedDB wrapper | 30KB gz |
| **dexie-react-hooks** | Live queries (reactive) | 2KB gz |

**Zero** server dependencies per il funzionamento offline.
La PWA funziona completamente dopo il primo caricamento.

---

## Guarantees

1. **Ogni azione è istantanea** — scrive su IndexedDB, mai awaita il server
2. **Ogni azione sopravvive a refresh** — IndexedDB è persistente
3. **Ogni azione viene sincronizzata** — la coda retry con backoff
4. **L'ordine è garantito** — sequence number monotono per sessione
5. **Nessun blocco funzionale offline** — tutto il core opera su dati locali
6. **Nessun messaggio allarmante** — l'indicatore sync è discreto e positivo
