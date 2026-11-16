# Commerce Service

Product catalog, multi-vendor shop management, order processing, escrow financial transactions, and after-sales dispute operations for Aritii Market.

---

## 1. Overview & Architecture

The Commerce Service runs on Node.js and MongoDB (using a single-node replica set `rs0` to support multi-document ACID transactions). It is strictly isolated within the private Docker bridge network and reachable only through the API Gateway presenting verified cluster credentials (`@packages/internal-auth`).

### Domain Decomposition & Bounded Contexts

Following the architectural modernization refactoring, commerce operations are partitioned into clean, decoupled domain modules under `src/modules/`:

```text
commerce-service/src/modules/
├── orders/               # Order lifecycle, inventory allocation, SLA tracking, delivery webhooks
├── finance/              # Seller wallets, Chapa payments, payouts, commission ledgers, reconciliation
├── after-sales/          # Customer returns, refunds, order disputes, arbitration
├── catalog/              # Products, stock reservations, categories, customer reviews
├── selling/              # Seller shops, seller applications, subscriptions, sectors, metrics
├── platform/             # Admin operations, marketplace hierarchy, business reviews, analytics
├── carts/                # Shopping carts, persistent sessions, customer wishlists
├── promotions/           # Coupon codes, promotional campaigns, banner events
├── media/                # Image uploads (Cloudinary / S3 via ImageUploadManager)
├── chat/                 # Order conversations, real-time participant messaging
└── requests/             # Custom product / bulk sourcing requests
```

---

## 2. Core Functional Modules

### A. Orders (`src/modules/orders/`)
- **Lifecycle Management:** Strict state machine transitions (`PENDING` -> `PROCESSING` -> `CONFIRMED` -> `SHIPPED` -> `DELIVERED` / `CANCELLED`).
- **Inventory Allocation (`allocation.service.js`):** Multi-vendor line item reservation and automated rollback upon expiration or cancellation.
- **SLA & Notes:** Automated order SLA timer tracking (`orderSLA.service.js`), audit trail notes (`orderNotes.service.js`), order hold/priority management (`orderHold.service.js`).
- **Delivery Webhook (`deliveryWebhook.service.js`):** Ingests status updates from Delivery Service with idempotent transaction processing and automated COD (Cash-on-Delivery) collection verification.

### B. Finance & Wallets (`src/modules/finance/`)
- **Atomic Seller Wallets (`wallets.service.js`):** Tracks available balance, pending earnings, and historical ledger transactions. All financial mutations run inside atomic MongoDB transactions (`transaction.js`).
- **Payment Gateway Integration (`paymentWebhook.service.js`):** Ingests Chapa webhook events, verifies HMAC signatures using constant-time comparison, enforces 5-minute replay tolerance, and credits seller wallets idempotently.
- **Payouts (`payouts.service.js`):** Merchant payout request workflows, bank account validation, admin approval gates, and disbursement recording.
- **Commission & Reconciliation:** Platform commission tracking (`commissionLedger.service.js`) and payment reconciliation reporting (`paymentReconciliation.service.js`).

### C. After-Sales (`src/modules/after-sales/`)
- **Returns & Refunds (`returns.service.js`):** Customer return initiation, merchant inspection approval, and automated reverse-ledger wallet deductions.
- **Dispute Resolution (`disputes.service.js`):** Buyer-seller dispute arbitration, evidence upload, admin decision enforcement.

---

## 3. Security, Transactions & Concurrency

- **Gateway-Only Verification (`gatewayOnly.js`):** Direct requests from outside the private network or callers lacking valid `x-internal-token` / `x-internal-service` credentials are immediately rejected with `403 FORBIDDEN`.
- **Atomic Multi-Document Transactions (`transaction.js`):** Balance modifications, wallet deductions, payout holds, and inventory reservations run within MongoDB transactions:
  ```javascript
  const { withTransaction } = require('../../../shared/utils/transaction');
  
  await withTransaction(async (session) => {
    await walletsRepository.deductAvailable(sellerId, amount, { session });
    await payoutsRepository.create(payoutData, { session });
  });
  ```
- **Webhook Replay Protection (`verifyWebhookSignature.js`):** Constant-time signature comparison (`crypto.timingSafeEqual`) prevents timing attacks, while timestamp validation rejects replayed webhooks older than 300 seconds.
- **Debloated Platform Administration:** Large monolith controllers are decoupled into specialized services (`adminOrders.service.js`, `adminBusinesses.service.js`, `adminAnalytics.service.js`, `adminHierarchy.service.js`).

---

## 4. API Endpoints Reference

All endpoints below are reached through the API Gateway via `/api/*`:

### Catalog & Categories
- `GET /api/product/public/all` — Public product listing with filters, pagination, and sorting.
- `GET /api/product/:id` — Product details by ID.
- `POST /api/product/create` — Create product listing (requires `SELLER` role).
- `PUT /api/product/:id` — Update product listing (requires seller shop ownership).
- `DELETE /api/product/:id` — Delete product listing.
- `GET /api/category/all` — Category tree and sector mappings.

### Shops & Selling
- `POST /api/shop/create` — Create seller shop.
- `GET /api/shop/all` — List shops (with filters).
- `GET /api/shop/:id` — Shop profile, banner, and active products.
- `PUT /api/shop/:id` — Update shop information (requires shop owner).
- `POST /api/seller-application/apply` — Merchant onboarding application.

### Cart & Wishlist
- `GET /api/cart` — Get authenticated user's cart.
- `POST /api/cart/add` — Add line item to cart with quantity validation.
- `PUT /api/cart/update-quantity` — Adjust line item quantity.
- `DELETE /api/cart/item/:id` — Remove line item from cart.
- `GET /api/wishlist` — View saved wishlist items.
- `POST /api/wishlist/add` — Add product to wishlist.

### Orders
- `POST /api/order/create-order` — Checkout cart into new order.
- `GET /api/order/user` — Authenticated buyer order history.
- `GET /api/order/shop/:shopId` — Shop order list for seller review.
- `POST /api/order/:orderId/confirm` — Seller confirms order (triggers inventory allocation).
- `POST /api/order/:orderId/confirm-receipt` — Buyer confirms receipt.
- `POST /api/order/:orderId/cancel` — Cancel order and release reservations.

### Finance, Wallets & Payouts
- `GET /api/wallet` — Authenticated seller wallet balance.
- `POST /api/payout/request` — Submit withdrawal request to bank/telebirr.
- `GET /api/payout/history` — Merchant payout request history.
- `GET /api/payment-ledger` — Detailed ledger of debits, credits, and escrow holds.

### After-Sales (Returns & Disputes)
- `POST /api/return/request` — Initiate return for delivered order item.
- `GET /api/return/my-returns` — Buyer return requests.
- `PUT /api/return/:id/status` — Merchant/admin return status update.
- `POST /api/disputes/create` — File order dispute.
- `GET /api/disputes` — List active disputes.

### Internal Webhooks (Cluster Credential Required)
- `POST /internal/commerce/delivery-webhook` — Delivery status update ingest.
- `POST /internal/commerce/payment-webhook` — Chapa payment status webhook.

---

## 5. Testing

The Commerce Service test suite runs on Node's native test runner (`node --test`):

```bash
npm test
```

All **483 tests** pass with zero failures:
- Bounded context unit tests (`orders`, `finance`, `after-sales`)
- Atomic transaction rollbacks and balance consistency
- Webhook signature and replay tolerance checks
- Response envelope serialization (`toOrderResponse`, `toWalletResponse`)
