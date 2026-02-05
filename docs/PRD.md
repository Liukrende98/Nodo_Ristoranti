# OpsOS — Product Requirements Document

## 1. Vision & Positioning

**OpsOS** è un "Operations OS" SaaS multi-tenant per piccole/medie aziende che trasforma processi operativi caotici in workflow misurabili, prevedibili e ottimizzabili. MVP verticale: ristorazione (cucina + delivery + telefono). Generalizzabile a qualsiasi processo con fasi, task, postazioni e persone.

**Analogia**: "Il McDonald's della gestione operativa" — non nel cibo, ma nella prevedibilità e affidabilità del processo.

---

## 2. MVP Scope (Fase 1) vs Fase 2+

### ✅ MVP (Fase 1) — 4 settimane

| Modulo | Incluso | Note |
|--------|---------|------|
| Multi-tenant + Auth | ✅ | Email/password, RBAC 5 ruoli, tenant isolation |
| Order Management | ✅ | Creazione manuale (telefono/banco), stati configurabili |
| Workflow Engine | ✅ | Template JSON, fasi/task/subtask, dipendenze, assegnazione postazione |
| KDS (Kitchen Display) | ✅ | Schermo touch, completamento task, timer |
| Delivery Board | ✅ | Assegnazione rider, stato consegna |
| ETA Calculator | ✅ | Basato su coda + durate storiche + capacità |
| Dashboard Base | ✅ | Ordini oggi, tempi medi, ritardi, throughput |
| Inventory Base | ✅ | Anagrafica, scarico automatico, soglie riordino |
| Real-time | ✅ | WebSocket per KDS/board/dashboard |
| Preset Ristorante | ✅ | Workflow pizza, wok, packaging, grill + seed data |
| Audit Log | ✅ | Azioni admin tracciate |
| Docker Deploy | ✅ | docker-compose per dev + prod |

### 🔜 Fase 2

| Modulo | Note |
|--------|------|
| Workflow Designer UI | Editor visuale drag-and-drop |
| SQL Connector | Mapping sorgenti esterne → entità interne |
| Licensing/Billing | Stripe integration, grace period, soft degradation |
| Analytics Avanzata | Trend, forecasting, suggerimenti ML |
| Integrazioni Delivery | Glovo, Deliveroo, JustEat API |
| Import CSV/API | Ordini bulk |
| MFA | TOTP/SMS second factor |
| i18n completa | Multi-lingua |

### 🔮 Fase 3

- Multi-location per tenant
- API pubblica + webhook
- Plugin system
- Mobile app nativa (React Native)
- AI assistant (suggerimenti, anomaly detection)

---

## 3. Success Metrics

| Metrica | Target MVP | Come misurare |
|---------|-----------|---------------|
| Tempo medio preparazione ordine | -20% dopo 2 settimane | Confronto pre/post con timestamp task |
| Ordini in ritardo | <10% | (ordini consegnati dopo ETA) / totale |
| Errori ordine (dimenticanze) | -50% | Task non completati / annullati |
| Tempo risposta telefono (ETA) | <5 secondi per suggerire orario | UX test |
| Uptime sistema | >99.5% | Monitoring |
| Adoption rate staff | >80% in 1 settimana | Login attivi / staff totale |

---

## 4. User Personas & Ruoli

### Owner/Admin
- Configura workflow, postazioni, menu, inventory
- Vede dashboard analytics, KPI
- Gestisce staff e turni
- Accesso completo

### Manager
- Gestisce ordini, assegna priorità
- Monitora KDS e delivery board
- Vede analytics (no config sistema)

### Staff (Cucina)
- Vede KDS filtrato per propria postazione
- Tocca per completare task/subtask
- UI minimale, touch-friendly, zero distrazioni

### Delivery (Rider)
- Vede ordini pronti assegnati a sé
- Marca "ritirato" e "consegnato"
- Vede indirizzo + contatto cliente

### Operatore Telefono
- Crea ordini manuali
- Vede ETA suggerito in tempo reale
- Cerca clienti, aggiunge note

---

## 5. Decisioni Tecniche Chiave

### Stack: Next.js Full-Stack Monolith

**Scelta**: Next.js 14 (App Router) + TypeScript + Tailwind + Prisma + PostgreSQL

**Perché monolith e non microservizi**:
- MVP speed: un deploy, un repo, shared types
- Complessità ridotta: no service mesh, no API gateway
- Scala verticalmente fino a ~10K ordini/giorno senza problemi
- Estraibile: i moduli sono organizzati per poter diventare servizi separati

**Perché Next.js e non NestJS separato**:
- Server Components → SSR gratis per dashboard
- API Routes → backend integrato, zero CORS issues
- Un unico processo Node → meno overhead operativo
- TypeScript end-to-end → type safety dal DB alla UI

**Tradeoff accettato**: meno separazione backend/frontend. Mitigato da architettura modulare interna.

### Database: PostgreSQL + Prisma

**Perché Postgres**: 
- Row Level Security nativo per tenant isolation
- JSONB per workflow definitions (flessibile senza schema migration per ogni variante)
- Excellent performance per query analitiche
- Maturo, battle-tested, free

**Perché Prisma**:
- Type-safe queries
- Migration system robusto
- Ottimo DX con TypeScript

**Tradeoff**: Prisma non supporta RLS nativamente → implementiamo tenant isolation a livello applicativo con middleware + RLS come defense-in-depth.

### Real-time: Socket.io

**Perché**: fallback automatico (WebSocket → polling), room-based (per tenant), ben supportato, reconnection built-in.

**Alternativa scartata**: SSE — più semplice ma unidirezionale, meno flessibile per KDS interattivo.

### Queue: BullMQ + Redis

**Perché**: ETA recalculation, inventory deduction, analytics aggregation sono async. BullMQ è maturo, ha retry, dead letter queue, dashboard (Bull Board).

### Auth: Custom JWT + Refresh Token

**Perché non NextAuth**: NextAuth è ottimo per auth social, ma per multi-tenant RBAC con tenant isolation serve più controllo. Custom auth con:
- bcrypt per password hashing (Argon2 richiede binding nativi, bcrypt è più portable)
- JWT access token (15min) + refresh token (7d) in httpOnly cookie
- Middleware che inietta tenant_id + user_id + role in ogni request

### Tenant Isolation: Row-Level (tenant_id FK)

**Perché non schema-per-tenant**: 
- Più semplice da gestire (una migration, non N)
- Scala meglio (100 tenant = 100 righe, non 100 schema)
- Prisma non supporta bene multi-schema

**Mitigazione**: ogni query passa per middleware che filtra per tenant_id. RLS PostgreSQL come secondo livello di difesa.

---

## 6. ETA Algorithm

### Approccio: Queue-Based Weighted Estimation

```
ETA_ordine = max(ETA_task) per tutti i task dell'ordine (considerando dipendenze)

ETA_task = tempo_attesa_coda + durata_stimata

tempo_attesa_coda = Σ(durate_task_in_coda_prima) / capacità_postazione

durata_stimata = media_mobile_pesata(ultimi_N_completamenti) 
                 con fallback su durata_manuale se <5 campioni
```

### Dettaglio

1. **Per ogni postazione**: manteniamo una coda virtuale dei task pendenti
2. **Capacità**: se una postazione ha capacità 3 (es. 3 fuochi), 3 task procedono in parallelo
3. **Dipendenze**: task B che dipende da task A non entra in coda finché A non è completato
4. **Critical path**: l'ETA dell'ordine è il path più lungo attraverso il grafo delle dipendenze
5. **Aggiornamento**: ricalcolo ogni volta che un task cambia stato (evento)

### Miglioramenti Fase 2
- P50/P90 instead of average
- Fattore orario (pranzo più lento)
- ML regression su features (giorno, ora, n_ordini, n_staff)
