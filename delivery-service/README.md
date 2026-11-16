# Delivery Service

Logistics coordination, geographic zone routing, provider wallet accounting, outbox-resilient fulfillment, and real-time shipment tracking for Aritii Market.

---

## 1. Overview & Architecture

The Delivery Service runs on Node.js and MongoDB (with GeoJSON `2dsphere` indexing for spatial zone containment and route calculations). It is isolated within the private network, receiving edge traffic only from the API Gateway with verified cluster credentials (`@packages/internal-auth`).

### Architecture Highlights

```text
delivery-service/src/
├── app/
│   ├── clients/                  # Centralized cross-service HTTP clients (@packages/service-client)
│   │   ├── commerce.client.js    # Notifies Commerce of delivery status & COD settlement
│   │   ├── identity.client.js    # Syncs provider roles and status with Identity
│   │   └── audit.client.js       # Logs critical logistical operations
│   ├── config/                   # Database, environment, and service discovery
│   ├── middleware/               # Gateway verification, request context, error handler
│   └── routes/app.js             # Core Express router mounts
└── modules/
    ├── delivery-fulfillment/     # Delivery orders, lifecycle state machine, Outbox dispatcher
    ├── locations-expansion/      # Regions, cities, sectors, GeoJSON zones, hubs, ports, routes
    ├── operations/               # Single/batch assignment engine, shipments, consolidation
    ├── provider-wallet/          # Delivery provider wallets, transactions, payout requests
    ├── providers/                # Provider onboarding, vehicle records, verification review
    └── tracking/                 # Milestone history, latest GPS coordinates, event streams
```

---

## 2. Core Resilient Systems

### A. Transactional Outbox Pattern (`modules/delivery-fulfillment/`)
To guarantee zero event loss between the Delivery and Commerce services during network disconnects or restarts:
1. When a delivery transitions status (e.g. `assigned`, `in_transit`, `delivered`), a `DeliveryOutboxEvent` document is persisted alongside the delivery update.
2. The background outbox worker (`outboxDispatcher.js`) periodically drains pending events, executing resilient HTTP dispatches via `commerce.client.js` with exponential backoff and jitter.
3. Events are marked `published` upon acknowledgment or scheduled for retry without blocking the primary request thread.

### B. Provider Wallet & Concurrency Protection (`modules/provider-wallet/`)
- Delivery driver/provider compensation is credited upon delivery confirmation.
- For Cash-on-Delivery (COD) orders, the exact collected amount is tracked, verified, and settled.
- Wallet mutations employ atomic increment operations (`$inc`) and condition guards to prevent double-spending and balance race conditions.

### C. Unified Cross-Service Clients (`app/clients/`)
All outbound inter-service calls use [`@packages/service-client`](file:///home/yihunebelay/Desktop/aritii-market/backend-services/packages/service-client):
- Automatic retries on idempotent calls
- Strict request timeout ceilings
- Mutual cluster authentication via [`@packages/internal-auth`](file:///home/yihunebelay/Desktop/aritii-market/backend-services/packages/internal-auth)
- Correlation tracking via [`@packages/request-context`](file:///home/yihunebelay/Desktop/aritii-market/backend-services/packages/request-context)

---

## 3. API Endpoints Reference

All public endpoints are reached through the API Gateway via `/api/*`:

### Delivery Fulfillment & Lifecycle
- `POST /api/delivery/request` — Create delivery request from commerce order.
- `GET /api/delivery/delivery` — List delivery orders (filterable by status, zone, provider).
- `GET /api/delivery/delivery/:id` — Delivery order detail, timeline, and assignment state.
- `PUT /api/delivery/delivery/:id/status` — Advance delivery lifecycle status (`pending` -> `assigned` -> `picked_up` -> `in_transit` -> `delivered` / `cancelled`).

### Geography & Zone Management
- `GET /api/delivery/location/hierarchy` — Full geographic tree (Regions -> Cities -> Sectors).
- `POST /api/delivery/zone` — Define delivery zone with GeoJSON Polygon coordinates.
- `GET /api/delivery/zone/lookup` — Identify serving zone from buyer GPS coordinate (`[longitude, latitude]`).
- `GET /api/delivery/route/all` — Active hub-to-hub and transit routes.
- `GET /api/delivery/service/all` — Delivery catalog offerings (Standard, Express, Scheduled).

### Provider Management & Applications
- `POST /api/provider-application/apply` — Apply to become delivery provider/courier.
- `GET /api/delivery/provider/all` — List active providers.
- `GET /api/delivery/provider/:id` — Provider profile, assigned vehicle, and active zone.
- `PUT /api/delivery/provider/:id/status` — Admin approval, suspension, or reactivation.

### Provider Wallets & Payouts
- `GET /api/delivery/provider-wallet` — Provider wallet balance and delivery fee breakdown.
- `POST /api/delivery/provider-payouts/request` — Provider withdrawal request.
- `GET /api/delivery/provider-payouts/history` — Historical payout disbursements.

### Operations & Assignments
- `POST /api/delivery/assignment` — Assign delivery to eligible provider.
- `POST /api/delivery/dispatch/batch` — Batch multiple orders into a single rider route leg.
- `GET /api/delivery/shipments` — Consolidated line-haul shipments.

### Tracking & Telemetry
- `GET /api/delivery/tracking/:deliveryId` — Complete milestone history for order.
- `POST /api/delivery/tracking/event` — Telemetry ingest (location update, transit scan).

### Internal API (Cluster Credential Required)
- `GET /internal/delivery/location/hierarchy` — Syncs geographic boundaries to Commerce.
- `POST /internal/delivery/request` — Direct commerce order delivery creation.

---

## 4. Testing

The Delivery Service test suite runs on Node's native test runner (`node --test`):

```bash
npm test
```

All **255 tests** pass with zero failures:
- Geographic point-in-polygon zone resolution
- Delivery lifecycle state machine validation
- Outbox event durability and retry mechanisms
- Provider wallet concurrency and COD reconciliation
- RBAC permission matrix for delivery actors
