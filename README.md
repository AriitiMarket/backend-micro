# Aritii Market — Backend Services

The backend of the **Aritii multi-seller marketplace**: an API Gateway plus three
domain services (Identity, Commerce, Delivery), with PostgreSQL and MongoDB as
the backing stores.

## Layout

```text
backend-services/
├── api-gateway/        # The ONLY public entry point (:8000)
├── identity-service/   # Accounts, roles, OAuth 2.1 / OIDC (PostgreSQL, :8001)
├── commerce-service/   # Shops, products, carts, orders, chat, seller apps (MongoDB, :8002)
├── delivery-service/   # Zones, providers, shipments, tracking (MongoDB, :8003)
├── tests/              # Architecture guard + integration tests
├── docker-compose.yml  # Local/deployment composition
└── .env.example        # Copy to .env — the file docker compose actually reads
```

## Architecture

```text
  customer-frontend (:3000)          Aritii-admin-web
            \                             /
             v                           v
           API Gateway (:8000)  <- the ONLY published port
            /         |         \
           v          v          v
   Identity (:8001)  Commerce (:8002)  Delivery (:8003)
   PostgreSQL        MongoDB           MongoDB
```

- Clients only ever talk to the gateway at `/api/*`; the `/api` prefix is
  stripped before proxying (`/api/user/...` → `/user/...` upstream).
- Identity, Commerce and Delivery are reachable **only** on the private bridge
  network — none of them publishes a port.
- Service-to-service traffic is authenticated with **per-caller credentials**
  (`INTERNAL_SERVICE_TOKENS`): a service only ever sends its own secret, and a
  leaked credential authorises exactly one caller, not the cluster.

## Authentication

**OAuth 2.1 + OIDC — Authorization Code Flow with mandatory PKCE (S256).**

Short-lived RS256 access tokens (10 min), rotating refresh tokens with reuse
detection, HTTPS-only in production. **No cookies, no server sessions.**

```text
1. client generates code_verifier + code_challenge = BASE64URL(SHA256(verifier))
2. POST /api/auth/authorize  { email, password, code_challenge, S256 }  -> code
3. POST /api/auth/token      { grant_type=authorization_code, code, verifier } -> tokens
4. Authorization: Bearer <access_token>   (the gateway verifies via JWKS)
5. POST /api/auth/token      { grant_type=refresh_token } -> rotated pair
6. POST /api/auth/revoke     { token }                    -> RFC 7009 revocation
```

Tokens are issued **only** by `/api/auth/token`. Registration
(`POST /api/auth/register`) and login (`POST /api/auth/authorize`) return a
single-use authorization code — never a token. Interactive Swagger docs:
`http://localhost:8000/api/docs`.

## Quick start (Docker)

Prerequisites: Docker + Docker Compose, Node.js ≥ 18 (for the test suite).

```bash
cp .env.example .env            # then generate real secrets (see below)
docker compose up -d --build    # or: npm run up
```

This brings up PostgreSQL, MongoDB, Identity, Commerce, Delivery and the API
Gateway. Only the gateway publishes a port (`${API_GATEWAY_PORT:-8000}`).

Generate one distinct secret per caller before the first start:

```bash
openssl rand -hex 32   # ×4 → gateway, identity, commerce, delivery
```

Paste them into `INTERNAL_SERVICE_TOKENS` in `.env`. Compose fails closed with a
clear message if the map is missing. The internal credential is **not** a JWT
signing key — it can never mint or verify a user token, and it is never
committed: `.env` is git-ignored.

## Bare-metal development

Each service can also run outside Docker against its own database:

```bash
cd identity-service && npm install && npm run dev    # reads its own .env.example knobs
```

Each service folder ships an `.env.example` for exactly this mode (point
`IDENTITY_SERVICE_URL` etc. at `http://localhost:800x`).

## Verify the platform

```bash
npm test                                    # architecture guard + gateway + all 3 services (no Docker needed)
docker compose ps                           # every container should report (healthy)
curl localhost:8000/health/live             # 200 while the process is up
curl localhost:8000/health/ready            # 200 only when every backend is ready
curl localhost:8000/health                  # per-service report + unavailable list
ARITII_E2E=1 npm run test:integration       # edge behaviour, from the host
./tests/integration/service-to-service.sh   # the private plane, from inside a container
```

`npm test` at this level runs, in order:

1. `tests/architecture.test.js` — the architecture guard: no committed cluster
   credential, peer addresses only from configuration, no gateway hops for
   internal traffic, liveness/readiness probes everywhere, gateway keeps the
   backends private, client-supplied identity headers never forwarded.
2. Gateway tests (`npm --prefix api-gateway test`).
3. Per-service unit tests for Identity, Commerce and Delivery.

### Health model

Every service exposes three probes:

- `/health/live` — is the process up? (what a restart policy should watch)
- `/health/ready` — can it serve traffic (database reachable)? What compose and
  the gateway watch before routing traffic here.
- `/health` — backwards-compatible aggregate.

The gateway refuses to route into a service it has just seen fail (`503` +
`Retry-After`) and returns `504` when a service exceeds the proxy timeout.

## Test accounts & seeding

Identity ships a boot-time admin seed plus a full demo dataset:

```bash
# Admin only (ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME env-overridable;
# defaults: admin@aritii.com / Admin@12345)
docker compose exec identity node src/seed/seed-admin.js

# Admin + 3 sellers + shops + products demo data
docker compose exec identity node src/seed/seed-all.js
# Default demo credentials: admin@aritii.com / Admin@12345,
# seller1..3@aritii.com / Seller@12345
```

Delivery has its own geography seed (locations, zones, providers, hubs, routes):

```bash
docker compose exec delivery-service npm run seed
```

> **Warning:** The seeds **delete and rewrite** their collections — never point them at a
> database you care about.

## Seller onboarding (no admin UI required)

1. Buyer submits an application → `POST /api/seller-application` (Commerce).
2. Admin lists / approves / rejects:
   ```bash
   curl -H "Authorization: Bearer <ADMIN_TOKEN>" \
     http://localhost:8000/api/seller-application
   curl -X POST -H "Authorization: Bearer <ADMIN_TOKEN>" \
     http://localhost:8000/api/seller-application/<id>/approve
   ```
3. Approval grants the SELLER role (Identity) and creates the Shop (Commerce).

## CI/CD Pipeline

The backend repository runs automated integration and deployment workflows via GitHub Actions:

- **Continuous Integration (`.github/workflows/ci.yml`):**
  - Triggers on push and pull requests to `main` and active branches.
  - Validates architectural constraints, shared package dependencies (`@aritii/*`), and runs the unit and integration test suites on Node.js 20.
- **Continuous Deployment (`.github/workflows/deploy.yml` & `cd.yml`):**
  - Employs path-based change detection to identify updated services.
  - Triggers automated deployment hooks to Render for affected services and the API Gateway.
  - Runs post-deploy health probes before traffic cutover.

## Documentation

- [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) — services, responsibilities, diagrams
- [`docs/service-to-service-communication.md`](../docs/service-to-service-communication.md) — trust model, credentials, runbook
- [`docs/AUTHENTICATION_ACCOUNT_ARCHITECTURE.md`](../docs/AUTHENTICATION_ACCOUNT_ARCHITECTURE.md) — one-account model & roles
- [`docs/SELLER_ONBOARDING.md`](../docs/SELLER_ONBOARDING.md) — application + approval flow
- [`docs/API.md`](../docs/API.md) — unified-account & approval endpoints
- [`docs/API_REFERENCE_BY_ACTOR.md`](../docs/API_REFERENCE_BY_ACTOR.md) — full per-actor endpoint reference
