# Ariiti Market — Backend Microservices

The backend infrastructure for **Ariiti Market**, an Ethiopian multi-vendor e-commerce marketplace and logistics platform. The system is designed around an API Gateway routing requests to three domain microservices, backed by a polyglot persistence architecture (PostgreSQL and MongoDB) with Redis caching.

---

## Architecture Overview

```text
  Customer & Seller Web              Admin Operations Web
   (aritii-seller-buyer-web)          (Aritii-admin-web)
            \                                /
             \                              /
              v                            v
          ┌────────────────────────────────────────┐
          │       API Gateway (:8000)              │  <-- Single public entry point
          │       Rate limiting, reverse proxy      │
          └──────────────────┬─────────────────────┘
                             │
     ┌───────────────────────┼───────────────────────┐
     │                       │                       │
     v                       v                       v
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│ Identity (:8001)│   │ Commerce (:8002)│   │ Delivery (:8003)│
│ PostgreSQL      │   │ MongoDB         │   │ MongoDB         │
│ (Private net)   │   │ (Private net)   │   │ (Private net)   │
└─────────────────┘   └─────────────────┘   └─────────────────┘
```

### Core Architecture Principles

- **Single Public Ingress:** The API Gateway (`:8000`) is the only service that binds to an external port. All external client requests route through `/api/*`.
- **Private Microservice Network:** Domain services (`identity-service`, `commerce-service`, `delivery-service`) reside strictly on an isolated network. They do not publish host ports.
- **Service-to-Service Trust:** Inter-service requests bypass the public gateway and authenticate over the internal network using per-caller secrets (`INTERNAL_SERVICE_TOKENS`). A compromised token grants access only to the assigned caller.
- **Polyglot Persistence:** Each microservice uses the database engine optimized for its data domain.

---

## Repository Structure

```text
backend-services/
├── api-gateway/            # Central entry point: reverse proxy, rate limiting, and route dispatch (:8000)
├── identity-service/       # Auth, accounts, RBAC, OAuth 2.1 / OIDC (PostgreSQL, :8001)
├── commerce-service/       # Shops, products, cart, orders, escrow, reviews (MongoDB, :8002)
├── delivery-service/       # Zones, routes, hubs, tracking, GeoJSON (MongoDB, :8003)
├── packages/               # Shared internal libraries
│   ├── authz/              # Unified authorization and permission helpers
│   ├── database/           # Connection management utilities (PostgreSQL pool & Mongoose)
│   ├── internal-auth/      # Service-to-service credential verification
│   ├── request-context/    # Correlation IDs and request tracing
│   ├── service-client/     # Resilient HTTP client for internal microservice RPC
│   └── validators/         # Shared payload validators
├── tests/                  # Architectural compliance and cross-service integration tests
├── .github/workflows/      # Automated CI/CD pipelines (test, lint, deploy)
├── docker-compose.yml      # Local container orchestration definition
└── .env.example            # Environment template for containerized development
```

---

## Services & Database Strategy

| Service | Port | Database | Primary Responsibilities |
| :--- | :--- | :--- | :--- |
| **API Gateway** | `8000` | Redis (Cache) | Public request ingress, URL path rewriting, CORS, rate limiting, and health aggregation. |
| **Identity Service** | `8001` | **PostgreSQL** | User registration, authentication, OAuth 2.1 / OIDC (PKCE), session management, and granular RBAC. |
| **Commerce Service** | `8002` | **MongoDB** | Merchant business onboarding, multi-shop catalogs, product inventory, cart, escrow payments, and orders. |
| **Delivery Service** | `8003` | **MongoDB (GeoJSON)** | Location hierarchies, delivery zones, dispatch routing, delivery requests, and shipment milestones. |

### Why Polyglot Persistence?

- **PostgreSQL for Identity:** User accounts, roles, and administrative permissions require strict relational integrity, foreign key enforcement, and ACID transaction guarantees.
- **MongoDB for Commerce & Delivery:** Catalogs and logistics require flexible document schemas. Product attributes vary widely across categories, and delivery logistics rely on GeoJSON spatial indexing (`2dsphere`) for polygon boundaries and coordinate calculations.

---

## Authentication & Security

Ariiti Market implements **OAuth 2.1 and OpenID Connect (OIDC)** using Authorization Code Flow with mandatory **PKCE (S256)**:

```text
1. Client generates:
   code_verifier
   code_challenge = BASE64URL(SHA256(code_verifier))

2. POST /api/auth/authorize  { email, password, code_challenge, code_challenge_method="S256" }
   -> Returns single-use authorization code (never a direct token)

3. POST /api/auth/token      { grant_type="authorization_code", code, code_verifier }
   -> Validates PKCE challenge and returns access_token + refresh_token

4. Subsequent requests pass:
   Authorization: Bearer <access_token>
   -> Gateway and services verify JWT signature via JWKS

5. POST /api/auth/token      { grant_type="refresh_token", refresh_token }
   -> Rotates token pair with automatic reuse detection

6. POST /api/auth/revoke     { token }
   -> RFC 7009 token revocation
```

Tokens are short-lived (10 minutes) and refresh tokens rotate on every exchange. Cookies and server-side session state are avoided in favor of stateless, cryptographically signed tokens.

---

## Dockerization & Container Architecture

The backend platform is fully containerized for both local development and production environments using multi-stage Docker builds and Docker Compose orchestration.

### Container Stack & Components

The `docker-compose.yml` environment provisions a complete self-contained infrastructure running 7 managed containers:

| Container Name | Service | Base Image | Role & Configuration |
| :--- | :--- | :--- | :--- |
| `aritii-postgres` | PostgreSQL | `postgres:15-alpine` | Relational database for accounts, RBAC roles, and credentials. Persisted in `postgres_data`. |
| `aritii-mongodb` | MongoDB Replica Set | `mongo:7` | Document database running single-node replica set (`rs0`) to support multi-document ACID transactions. Persisted in `mongodb_data`. |
| `aritii-mongo-keyfile` | Keyfile Generator | `mongo:7` | One-shot init container generating secure base64 keyfile for replica set authentication. |
| `aritii-redis` | Redis Cache | `redis:latest` | In-memory key-value store for session caching and rate limiting. Persisted in `redis_data`. |
| `aritii-identity` | Identity Service | `node:20-bookworm-slim` | Authentication, OAuth 2.1, and RBAC service. Depends on healthy PostgreSQL, MongoDB, and Redis. |
| `aritii-commerce` | Commerce Service | `node:20-bookworm-slim` | Multi-shop, catalog, cart, and order processing. Depends on healthy MongoDB and Redis. |
| `aritii-delivery` | Delivery Service | `node:20-bookworm-slim` | Logistics, zones, routing, and tracking. Depends on healthy MongoDB and Redis. |
| `aritii-gateway` | API Gateway | `node:20-bookworm-slim` | Public reverse proxy and rate limiter. Sole service publishing port `8000:8000` to the host. |

### Multi-Stage Dockerfile Highlights

The root `Dockerfile` employs an optimized two-stage build architecture:
- **Build Stage (`deps`):** Copies root and workspace manifests, resolves internal packages under `packages/`, and installs only production dependencies (`--omit=dev`).
- **Runner Stage (`runner`):** Runs on lightweight Debian Bookworm Slim, installs `curl` for container health checks, creates permission-controlled upload volumes, and switches execution to a non-privileged `node` user.
- **Service Targets:** Dedicated build targets exist for `api-gateway`, `identity-service`, `commerce-service`, and `delivery-service`.

### Networking & Volume Isolation

- **Internal Bridge Network:** All containers communicate across the dedicated `aritii-network` bridge. Identity, Commerce, and Delivery services do not bind to host ports, making them unreachable from outside the Docker network.
- **Volume Persistence:** Data integrity is maintained across container restarts through named Docker volumes:
  - `postgres_data`
  - `mongodb_data` & `mongodb_config`
  - `redis_data`
  - `commerce_uploads` & `identity_uploads`
  - `identity_keys`
- **Health Checks & Startup Order:** Every service specifies active health checks (`curl` / `pg_isready` / `mongosh`). Downstream dependencies wait for upstream health before launching (`condition: service_healthy`).

---

## Quick Start (Docker Compose)

### Prerequisites
- Docker Engine >= 24.0
- Docker Compose >= 2.0
- Node.js >= 18 (for running unit test suites locally)

### Steps to Run

1. **Configure Environment Variables:**
   ```bash
   cp .env.example .env
   ```

2. **Generate Internal Service Secrets:**
   Generate distinct random 32-byte hex tokens for inter-service communication:
   ```bash
   openssl rand -hex 32   # Run 4 times: for gateway, identity, commerce, delivery
   ```
   Assign them to `INTERNAL_SERVICE_TOKENS` in your `.env` file.

3. **Build and Launch All Containers:**
   ```bash
   docker compose up -d --build
   ```

4. **Verify Container Health & Running Status:**
   ```bash
   docker compose ps
   curl http://localhost:8000/health
   ```

5. **Access Application Endpoints:**
   - Public API Gateway: `http://localhost:8000`
   - Interactive Swagger API Documentation: `http://localhost:8000/api/docs`
   - Gateway Health Endpoint: `http://localhost:8000/health`

### Common Docker Operations

```bash
# View live logs for a specific service
docker compose logs -f identity
docker compose logs -f api-gateway

# Execute seeding commands inside running containers
docker compose exec identity node src/seed/seed-admin.js
docker compose exec identity node src/seed/create-ops-admin.js

# Rebuild an individual service image
docker build --target identity-service -t aritii-identity:latest .

# Stop the stack and preserve database volumes
docker compose down

# Stop the stack and wipe all database volumes (fresh start)
docker compose down -v
```

---

## Local Development (Without Docker)

Each microservice can run independently against local or remote databases:

```bash
# 1. Install root and shared packages dependencies
npm install

# 2. Run Identity Service
cd identity-service
npm install
npm run dev

# 3. Run Commerce Service
cd ../commerce-service
npm install
npm run dev

# 4. Run Delivery Service
cd ../delivery-service
npm install
npm run dev

# 5. Run API Gateway
cd ../api-gateway
npm install
npm run dev
```

Each service directory contains an `.env.example` file specifying required connection strings and service ports.

---

## Testing & Quality Assurance

Run the test suite from the repository root:

```bash
# Run architecture constraints, gateway tests, and all microservice unit tests
npm test

# Run end-to-end edge integration tests
ARITII_E2E=1 npm run test:integration

# Test private inter-service networking
./tests/integration/service-to-service.sh
```

### Health Probes Standard

Every service implements three standardized health endpoints:
- `/health/live` — Returns HTTP 200 while the process is running (used by container restart policies).
- `/health/ready` — Returns HTTP 200 only when backing databases (PostgreSQL/MongoDB) are reachable.
- `/health` — Aggregated health diagnostics report.

---

## Administrative Accounts & Seeding

The repository provides seeding scripts for provisioning administrative and demo accounts:

```bash
# Seed initial Super Administrator
docker compose exec identity node src/seed/seed-admin.js

# Provision an Operations Administrator (scoped RBAC without user/financial management)
docker compose exec identity node src/seed/create-ops-admin.js

# Seed complete demo environment (Super Admin, 3 sellers, shops, and catalog data)
docker compose exec identity node src/seed/seed-all.js

# Seed logistics and delivery geography (regions, zones, hubs, ports, and routes)
docker compose exec delivery-service npm run seed
```

> **Warning:** Seeding commands overwrite existing demo collections. Do not execute these scripts in production environments.

---

## CI/CD Pipeline

The repository includes automated continuous integration and continuous deployment pipelines via GitHub Actions:

- **Continuous Integration (`.github/workflows/ci.yml`):**
  - Triggers on every push and pull request targeting `main` and active feature branches.
  - Enforces architectural boundaries (no hardcoded secrets, no unrouted internal calls).
  - Validates package integrity across `@aritii/*` shared packages.
  - Executes unit and integration test suites on Node.js 20.

- **Continuous Deployment (`.github/workflows/deploy.yml` & `cd.yml`):**
  - Uses path filtering to determine which microservices changed.
  - Executes automated deployment webhooks to [Render](https://render.com) for updated services and the API Gateway.
  - Performs post-deploy health check verification to ensure zero-downtime releases.

---

## Documentation Links

- `docs/ARCHITECTURE.md` — Detailed microservice boundaries and interaction diagrams.
- `docs/service-to-service-communication.md` — Internal trust model, token rotation, and networking.
- `docs/AUTHENTICATION_ACCOUNT_ARCHITECTURE.md` — Account lifecycle, roles, and authorization matrix.
- `docs/SELLER_ONBOARDING.md` — Merchant application, verification, and shop creation workflows.
- `docs/API_REFERENCE_BY_ACTOR.md` — Comprehensive REST API endpoint reference categorized by actor (buyer, seller, admin, deliverer).
