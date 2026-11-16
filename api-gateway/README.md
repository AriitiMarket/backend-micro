# API Gateway

The single public ingress, edge security boundary, and real-time Socket.IO hub for Aritii Market microservices.

---

## 1. Overview & Responsibilities

The API Gateway binds to public port `:8000` and acts as the strict trust boundary between external clients (web apps, mobile apps) and the private backend microservices network:

- **Segment-Aware Route Dispatch:** Matches incoming requests to owning domain services (`identity`, `commerce`, `delivery`, `uploads`).
- **Edge Header Sanitization & Re-signing:** Strips all client-supplied spoofable headers (`x-internal-*`, `x-user-*`, `x-gateway-*`, `x-jurisdiction`). Resolves and verifies JWT access tokens against Identity Service JWKS and injects verified, tamper-proof user claims (`x-user-id`, `x-user-role`, `x-user-roles`, `x-user-capabilities`, `x-gateway-verified`).
- **JWKS In-Memory Caching & Anti-DoS:** Caches public RS256 signing keys in memory for 1 hour, enforces a 10-second refetch cooldown against unknown `kid` flooding, and provides a 60-second stale-key grace window during identity service restarts.
- **Service Availability Circuit Shield:** Fails fast with `503 SERVICE_UNAVAILABLE` when a downstream microservice is detected down, avoiding socket pile-up, and returns `504 SERVICE_TIMEOUT` on hung upstreams.
- **Real-Time WebSocket Hub (Socket.IO):** Authenticates handshakes via RS256 Bearer JWTs, tracks user presence and active sockets in memory with leak-free disconnect cleanup, enforces authorized room subscriptions, and provides an internal ingest endpoint (`POST /internal/realtime/emit`) for backend event fan-out.
- **Strict Rate Limiting & Security Headers:** Enforces per-IP and per-user ceilings, dedicated auth limiter on credentials/tokens, CORS origin whitelist, and OAuth 2.1 HTTPS transport security.

---

## 2. Architecture & Topography

```text
Clients (Customer Frontend / Seller Portal / Admin Console / Mobile)
                              │
                              │ HTTPS / WSS (:8000)
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                       API Gateway (:8000)                        │
│                                                                  │
│  [1] Request ID & Structured Logger                              │
│  [2] Enforce HTTPS, Security Headers & CORS                      │
│  [3] Auth / API Rate Limiters                                    │
│  [4] Identify & JWKS Signature Verification (RS256)              │
│  [5] Jurisdiction Scoping & RBAC Permission Gate                 │
│  [6] Segment-Aware Route Dispatcher                              │
│  [7] Socket.IO Engine & Session Registry                         │
└──────────────┬───────────────────┬───────────────────┬───────────┘
               │                   │                   │
   x-internal-token & claims       │                   │
               │                   │                   │
               ▼                   ▼                   ▼
      ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
      │ Identity (:8001)│ │ Commerce (:8002)│ │ Delivery (:8003)│
      │ PostgreSQL / RBAC│ │ MongoDB / Escrow│ │ MongoDB / Geo   │
      └─────────────────┘ └─────────────────┘ └─────────────────┘
```

---

## 3. Route Dispatch Table

All public requests route under `/api/*` (or root `/.well-known` / `/uploads`). Service matching is segment-aware (exact match or trailing `/` boundary).

| Public URL Prefix | Owning Microservice | Target Responsibilities |
| :--- | :--- | :--- |
| `/.well-known/*` | **Identity Service** | OIDC Discovery (`openid-configuration`) & JWKS public keys (`jwks.json`). |
| `/api/auth/*` | **Identity Service** | OAuth 2.1 PKCE authorization code, token exchange, refresh, 2FA, password reset. |
| `/api/user/*` | **Identity Service** | Customer & merchant user profiles, addresses, avatars, preferences. |
| `/api/agent/*` | **Identity Service** | Customer support & sales agent directory and status. |
| `/api/address/*` | **Identity Service** | Reusable address books for buyers and sellers. |
| `/api/admin/platform/*` | **Commerce Service** | Marketplace hierarchy, category trees, global operational controls. |
| `/api/admin/businesses/*`| **Commerce Service** | Business registrations, vendor compliance review. |
| `/api/admin/shops/*` | **Commerce Service** | Shop directory, status toggling, administrative overrides. |
| `/api/admin/orders/*` | **Commerce Service** | Global marketplace order auditing, manual settlement actions. |
| `/api/admin/operations/*`| **Commerce Service** | Operations management, queue health, seller SLA metrics. |
| `/api/admin/growth-analytics/*`| **Commerce Service** | Merchant gross volume, growth indicators, revenue reports. |
| `/api/admin/*` | **Identity Service** | Admin users, role management (RBAC), permission scopes, audit logs. |
| `/api/shop/*` | **Commerce Service** | Seller shop creation, branding, settings, status. |
| `/api/product/*` | **Commerce Service** | Product catalog, public listings, variants, stock reservations. |
| `/api/category/*` | **Commerce Service** | Category trees, tags, sector mappings. |
| `/api/order/*` | **Commerce Service** | Checkout, order creation, order lifecycle state transitions. |
| `/api/cart/*` | **Commerce Service** | Cart line items, quantities, session persistence. |
| `/api/wishlist/*` | **Commerce Service** | Customer saved items and wishlists. |
| `/api/wallet/*` | **Commerce Service** | Seller wallets, balance ledgers, earnings statements. |
| `/api/payout/*` | **Commerce Service** | Payout requests, bank transfer reviews, disbursement records. |
| `/api/return/*` | **Commerce Service** | Return requests, return status lifecycle, item handback. |
| `/api/disputes/*` | **Commerce Service** | Order disputes, buyer claims, seller dispute resolution. |
| `/api/coupon/*` | **Commerce Service** | Discount coupons, percentage/fixed vouchers, validation. |
| `/api/promotion/*` | **Commerce Service** | Campaign promotions, seasonal banner deals. |
| `/api/media/*` | **Commerce Service** | Standalone multi-part product/shop image uploads. |
| `/api/delivery/*` | **Delivery Service** | Fulfillment, locations, zones, routes, shipments, tracking, assignments. |
| `/api/provider-application/*`| **Delivery Service** | Delivery provider application, vehicle registration, onboarding review. |
| `/api/uploads/*` | **Uploads Proxy** | Static uploaded assets (cached images, media files). |
| `/internal/delivery/*` | **Delivery Service** | Service-to-service internal RPC (cluster credential required). |
| `/internal/commerce/*` | **Commerce Service** | Status sync & webhooks (cluster credential required). |
| `/internal/*` | **Identity Service** | Account directory and audit log RPC (cluster credential required). |

---

## 4. Socket.IO Real-Time Architecture

The API Gateway hosts the real-time Socket.IO server:

- **Handshake Authentication:** Extracts Bearer JWT from `socket.handshake.auth.token` or `Authorization` header. Verifies signature against JWKS. Anonymous connections are rejected with `unauthorized`.
- **Identity & Room Assignment:** Verified users auto-join their isolated room `user:<userId>`. If token claims declare active `shopId` or `providerId`, the socket auto-joins `shop:<shopId>` and `provider:<providerId>`.
- **Room Join Authorization:** Subscriptions to `shop:subscribe` or `provider:subscribe` verify that the caller owns the entity or holds an `ADMIN` role. Arbitrary third-party room joins are refused.
- **Session Registry (`registry.js`):** In-memory mapping of `userId <-> Set<socketId>` for targeted event delivery, presence queries, and automatic cleanup on socket `disconnect`.
- **Internal Event Ingest (`POST /internal/realtime/emit`):**
  - Requires cluster credential (`X-Internal-Token` + `X-Internal-Service`).
  - Strict payload validation:
    ```json
    {
      "type": "request.message.created",
      "requestId": "64b1f2e8...",
      "recipients": ["usr_buyer_123", "usr_seller_456"],
      "actorId": "usr_buyer_123",
      "data": { "text": "Shipment dispatched" }
    }
    ```
  - Fans out over Socket.IO to recipient user rooms and the request room.

---

## 5. Security & Edge Configuration

### Environment Variables (`.env`)

```ini
PORT=8000
NODE_ENV=production
CORS_ORIGIN=http://localhost:3000,http://localhost:4000
IDENTITY_SERVICE_URL=http://identity:8001
COMMERCE_SERVICE_URL=http://commerce:8002
DELIVERY_SERVICE_URL=http://delivery:8003
INTERNAL_SERVICE_NAME=gateway
INTERNAL_SERVICE_TOKENS={"gateway":"...","identity":"...","commerce":"...","delivery":"..."}
PROXY_TIMEOUT_MS=15000
HEALTH_PROBE_TIMEOUT_MS=2000
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=1000
AUTH_RATE_LIMIT_MAX=30
```

---

## 6. Testing

The API Gateway test suite runs on Node's native test runner:

```bash
npm test
```

All 81 tests pass cleanly, covering:
- CORS preflight & wildcard evaluation
- Forwarding proxy header sanitization & upstream re-signing
- 503/504 circuit breaker failure fast & retry logic
- JWKS in-memory caching, anti-DoS cooldown, and stale-key grace windows
- Segment-aware path resolution
- Socket.IO handshake authentication, room subscriptions, session registry, and event emit validation
