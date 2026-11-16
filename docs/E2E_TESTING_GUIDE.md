# End-to-End (E2E) & Concurrency Testing Guide

This guide details how to execute the comprehensive, automated End-to-End (E2E) test suite against the Docker Compose environment for **Aritii Market**.

---

## 1. Test Suite Architecture & Scenarios

The test runner [`scripts/run-endpoint-tests.js`](file:///home/yihunebelay/Desktop/aritii-market/backend-services/scripts/run-endpoint-tests.js) and harness [`tests/integration/harness.test.js`](file:///home/yihunebelay/Desktop/aritii-market/backend-services/tests/integration/harness.test.js) test the full platform lifecycle through the public API Gateway:

```text
E2E Test Runner (Native Fetch + Node Assert)
                     │
                     │ HTTP / REST (:8000 or :3000)
                     ▼
             ┌───────────────┐
             │  API Gateway  │
             └───────┬───────┘
                     │ (x-internal-token + verified claims)
        ┌────────────┼────────────┐
        ▼            ▼            ▼
   ┌──────────┐ ┌──────────┐ ┌──────────┐
   │ Identity │ │ Commerce │ │ Delivery │
   │ (Postgres)│ │ (MongoDB)│ │ (MongoDB)│
   └──────────┘ └──────────┘ └──────────┘
```

### Scenarios Covered

- **Scenario A (Happy Path E2E Flow):**
  1. Buyer registration and OAuth 2.1 PKCE authorization code login.
  2. Product catalog search and line item addition to shopping cart.
  3. Multi-vendor order creation from cart.
  4. Chapa payment webhook simulation with constant-time HMAC signature verification.
  5. Seller wallet balance and escrow ledger verification.
  6. Courier fulfillment request creation, transit updates, and delivery completion.

- **Scenario B (Negative & Security Tests):**
  1. Zero-trust gate rejection: 401 when accessing protected endpoints (`/api/wallet`) without JWT.
  2. Cross-seller IDOR prevention: 403/404 when Seller A attempts to modify Seller B's product or shop.
  3. HMAC webhook tamper rejection: 400/401 when receiving forged or invalid Chapa webhook signatures.
  4. Webhook replay rejection: 400/401 when webhook timestamp is older than tolerance (> 300s).

- **Scenario C (Concurrency & Race Conditions):**
  1. **Simultaneous Inventory Checkout:** Uses `Promise.all` to launch concurrent buyer checkouts for the last remaining stock unit (`stock: 1`). Asserts that exactly 1 buyer acquires the item and remaining buyers receive graceful `400/409 Insufficient Stock` responses without negative stock anomalies.
  2. **Concurrent Wallet Withdrawals:** Uses `Promise.all` to fire concurrent payout requests exceeding available balance. Asserts that balance cannot drop below 0.

- **Scenario D (Outbox Resilience & Failure Recovery):**
  1. Verifies delivery status synchronization and Transactional Outbox pattern durability.

---

## 2. Step-by-Step Execution Guide

### Step 1: Start the Docker Infrastructure
Ensure Docker Engine is running, then launch the containerized stack:

```bash
cd backend-services

# Copy .env template if not already present
cp .env.example .env

# Build and start all 7 containers
npm run up
# or: docker compose up -d --build
```

### Step 2: Verify All Services are Healthy
```bash
docker compose ps
```

Confirm that `aritii-gateway`, `aritii-identity`, `aritii-commerce`, and `aritii-delivery` report `(healthy)`.

### Step 3: (Optional) Reset and Seed Demo Data
To populate the database with complete geographic zones, merchants, and catalog items:

```bash
npm run seed
# or: docker compose exec identity node src/seed/seed-all.js
```

### Step 4: Run the E2E Test Suite
Execute the test runner using npm:

```bash
npm run test:e2e
```

Or run directly via Node with custom environment variables:

```bash
# If running Gateway on port 8000:
GATEWAY_URL=http://localhost:8000 node scripts/run-endpoint-tests.js

# If running Gateway on port 3000:
GATEWAY_URL=http://localhost:3000 node scripts/run-endpoint-tests.js
```

### Step 5: Running via Node's Native Test Runner
To run with Node's native test runner (`node:test`):

```bash
ARITII_E2E=1 node --test tests/integration/harness.test.js
```

---

## 3. Sample Execution Output

```text
======================================================================
  ARITII MARKET — FULL-SYSTEM ENDPOINT E2E & CONCURRENCY TEST SUITE
  Target Edge Gateway: http://localhost:8000
======================================================================

======================================================================
  PRE-FLIGHT: Gateway Liveness & Test Seeding
======================================================================
  ⏳ Gateway health and discovery verification... PASSED (22ms)
  ⏳ Seed/Register Test Accounts (Admin, Sellers, Buyer, Courier)... PASSED (145ms)
  ⏳ Provision Test Shops and Catalogs... PASSED (88ms)

======================================================================
  SCENARIO A: Happy Path Full Lifecycle E2E Flow
======================================================================
  ⏳ 1. Buyer views catalog and adds item to shopping cart... PASSED (35ms)
  ⏳ 2. Buyer creates order from cart checkout... PASSED (52ms)
  ⏳ 3. Chapa Payment Webhook ingest with constant-time HMAC signature... PASSED (28ms)
  ⏳ 4. Seller checks wallet balance for credited escrow allocation... PASSED (19ms)
  ⏳ 5. Courier dispatch and delivery order milestone progression... PASSED (41ms)

======================================================================
  SCENARIO B: Negative & Security Tests (Zero-Trust, IDOR, Webhooks)
======================================================================
  ⏳ 1. Rejection of unauthenticated protected endpoint calls (401)... PASSED (11ms)
  ⏳ 2. Rejection of cross-seller IDOR attempts (Seller B mutating Seller A shop/product)... PASSED (16ms)
  ⏳ 3. Rejection of payment webhooks with forged/invalid HMAC signature (400/401)... PASSED (14ms)
  ⏳ 4. Rejection of expired/replayed webhook timestamps (> 300s)... PASSED (12ms)

======================================================================
  SCENARIO C: Concurrency & Race Condition Verification (Promise.all)
======================================================================
  ⏳ 1. Simultaneous checkout of the last remaining product stock (stock=1)... PASSED (67ms)
  ⏳ 2. Concurrent withdrawal requests exceeding available seller wallet balance... PASSED (45ms)

======================================================================
  SCENARIO D: Outbox Pattern & Failure Recovery
======================================================================
  ⏳ 1. Verification of delivery outbox durability and status retry... PASSED (18ms)

======================================================================
  E2E TEST EXECUTION SUMMARY
======================================================================
  Total Scenarios Executed: 15
  Passed:                   15
  Failed:                   0
  Elapsed Time:             0.62s
======================================================================

✓ 100% of E2E endpoint scenarios passed successfully.
```
