# OpsOS — Operations Management System

Sistema di gestione operativa multi-tenant per ristoranti e aziende.

## Quick Start (Docker)

```bash
# 1. Clona e entra nella directory
cd ops-os

# 2. Copia environment
cp .env.example .env

# 3. Avvia tutto con Docker
docker-compose up -d

# 4. Apri il browser
open http://localhost:3000
```

## Quick Start (Locale, senza Docker)

### Prerequisiti
- Node.js 20+
- PostgreSQL 15+ (locale o remoto)
- Redis 7+ (opzionale, per queue)

```bash
# 1. Installa dipendenze
npm install

# 2. Configura .env
cp .env.example .env
# Modifica DATABASE_URL con il tuo Postgres

# 3. Setup database
npx prisma db push
npm run db:seed

# 4. Avvia app + socket server
npm run dev        # → http://localhost:3000
npm run socket     # → ws://localhost:3001 (in un altro terminale)
```

## Demo Accounts

| Ruolo | Email | Password |
|-------|-------|----------|
| Owner | owner@bellacucina.it | demo1234 |
| Manager | manager@bellacucina.it | demo1234 |
| Chef | chef@bellacucina.it | demo1234 |
| Pizzaiolo | pizzaiolo@bellacucina.it | demo1234 |
| Wok | wok@bellacucina.it | demo1234 |
| Rider | rider1@bellacucina.it | demo1234 |

## Pages

| URL | Descrizione | Ruoli |
|-----|-------------|-------|
| `/` | Dashboard analytics | Owner, Admin, Manager |
| `/login` | Login page | Tutti |
| `/kds` | Kitchen Display System | Staff, Manager+ |
| `/delivery-board` | Board consegne | Delivery, Manager+ |
| `/admin/orders/new` | Nuovo ordine | Staff+ |
| `/admin/menu` | Gestione menu | Owner, Admin |
| `/admin/inventory` | Gestione inventario | Manager+ |

## Architecture

```
Next.js 14 (App Router) — Full-stack monolith
├── Frontend: React + TypeScript + Tailwind CSS
├── Backend: API Routes + Server Components
├── Database: PostgreSQL + Prisma ORM
├── Real-time: Socket.io (porta 3001)
├── Queue: BullMQ + Redis (opzionale)
└── Auth: Custom JWT + httpOnly cookies
```

## Key Features (MVP)

- ✅ Multi-tenant con isolamento per tenant_id
- ✅ RBAC a 5 livelli (owner/admin/manager/staff/delivery)
- ✅ Workflow engine configurabile (fasi → task → subtask)
- ✅ KDS touch-friendly con timer real-time
- ✅ Calcolo ETA basato su coda e durate storiche
- ✅ Delivery board con assegnazione rider
- ✅ Inventario con scarico automatico e suggerimenti riordino
- ✅ Dashboard analytics real-time
- ✅ Audit log delle azioni

## Workflow Examples (Seed Data)

### Pizza Margherita (14 min)
```
Fase 1: Preparazione
  └─ Stendi impasto (forno, 3min) → Condimento (forno, 2min, dipende da impasto)
Fase 2: Cottura
  └─ Cottura forno (forno, 8min, dipende da condimento)
Fase 3: Finitura
  └─ Taglio e impiattamento (packaging, 1min)
```

### Wok Noodles (13 min)
```
Fase 1: Preparazione
  ├─ Taglia verdure (preparazione, 4min)
  └─ Prepara proteina (preparazione, 3min)    [parallelo]
Fase 2: Cottura
  └─ Saltatura in wok (wok, 5min, dipende da ENTRAMBI)
Fase 3: Impiattamento
  └─ Impiatta e guarnisci (packaging, 1min)
```

### Classic Burger (10 min)
```
Fase 1: Griglia
  ├─ Griglia hamburger (griglia, 6min)
  └─ Tosta panino (griglia, 2min)             [parallelo]
Fase 2: Assemblaggio
  └─ Assembla burger (packaging, 2min, dipende da ENTRAMBI)
```

## Hardening Checklist (Pre-Production)

### Sicurezza
- [ ] Cambiare JWT_SECRET e JWT_REFRESH_SECRET con valori random 64+ chars
- [ ] Abilitare HTTPS (certificato SSL)
- [ ] Configurare CORS restrittivo per dominio produzione
- [ ] Abilitare rate limiting su Redis (non in-memory)
- [ ] Configurare CSP headers
- [ ] Verificare protezione CSRF su form
- [ ] Rimuovere demo accounts / cambiare password
- [ ] Abilitare RLS PostgreSQL come difesa aggiuntiva
- [ ] Configurare backup automatici DB (pg_dump cron)
- [ ] Verificare che secrets non siano in codice sorgente

### Performance
- [ ] Aggiungere indici DB per query lente (EXPLAIN ANALYZE)
- [ ] Configurare connection pooling (PgBouncer o Prisma pool)
- [ ] Abilitare caching Redis per query frequenti
- [ ] Configurare CDN per static assets
- [ ] Ottimizzare immagini e bundle size

### Monitoring
- [ ] Configurare error tracking (Sentry)
- [ ] Abilitare structured logging (JSON)
- [ ] Configurare health check endpoint
- [ ] Monitoring uptime (UptimeRobot/Better Uptime)
- [ ] Alerting su errori critici

### Testing
- [ ] Test unitari per workflow engine
- [ ] Test unitari per ETA calculator
- [ ] Test integrazione per API endpoints
- [ ] Test E2E per happy path ordine completo
- [ ] Load test per simulare 100+ ordini/ora
