# Identity Service

User authentication, OAuth 2.1 / OIDC identity provider, granular RBAC, refresh token rotation, and 2FA security for Aritii Market.

---

## 1. Overview & Architecture

The Identity Service runs on Node.js and PostgreSQL. It acts as the single source of truth for accounts, credentials, and permissions across the marketplace.

The service is fully private within the Docker network, protected by `gatewayOnly.js`. It exposes public OIDC discovery documents and issues RS256-signed JWT access tokens verified by the API Gateway and downstream services via JWKS.

```text
identity-service/src/
├── config/                  # PostgreSQL connection pool & transaction runner (@packages/database)
├── controllers/             # Auth, User, Admin, Seller, Provider, 2FA, Agent, Address controllers
├── middleware/              # Gateway gate, authenticate, authorize, requirePermission, rateLimiter
├── migrations/              # DDL schema migrations (roles, permissions, 2FA, token rotation)
├── models/                  # Role & permission constants, canonical normalization
├── repositories/            # Transaction-safe PostgreSQL data access repositories
├── routes/                  # Express route mounts
├── services/                # Business logic: auth, token rotation, 2FA, password reset, audit log
└── utils/                   # JWT signing, PKCE verification, password hashing, privacy mapper
```

---

## 2. Security & Modernization Architecture

### A. Connection Pooling & Transaction Safety (`@packages/database`)
- Replaces raw connection handling with a managed, leak-free PostgreSQL connection pool.
- All multi-table updates (user registration, password resets, role promotions, token rotations) run within `withTransaction(async (client) => { ... })` ensuring ACID consistency and automatic rollback on failure.

### B. Refresh Token Rotation (RTR) & Reuse Detection
- **Token Rotation:** When exchanging a refresh token (`POST /api/auth/token` with `grant_type="refresh_token"`), the presented token is immediately revoked and a new high-entropy token pair is generated.
- **Family Reuse Detection:** If an already-revoked refresh token is replayed (indicating credential theft or man-in-the-middle leakage), the system immediately revokes **all** active tokens for that user family and logs a critical security audit event.

### C. Two-Factor Authentication (2FA Hardening)
- **TOTP:** RFC 6238 time-based one-time password support compatible with Google Authenticator and Authy.
- **Constant-Time Verification:** Employs constant-time string comparison (`crypto.timingSafeEqual`) to prevent timing side-channel attacks on OTP validation.
- **Single-Use Backup Codes:** High-entropy hashed backup codes that are consumed atomically on first use.

### D. Granular Role-Based Access Control (RBAC)
- **Canonical Roles (`models/Role.js`):** `BUYER`, `SELLER`, `PROVIDER`, `AGENT`, `ADMIN`.
- **Granular Admin Roles:** `SUPER_ADMIN` (unrestricted), `OPERATIONS_ADMIN` (order, shipment, and catalog operations without user/financial permissions), `SUPPORT_ADMIN` (customer care and dispute oversight).
- **Wildcard Permission Bypass:** Root permissions (`*`) for super admins, with explicit permission checks (`requirePermission('users.view')`, `requirePermission('dashboard.view')`) for specialized roles.

### E. Response Privacy Mapping (`utils/user.mapper.js`)
All user retrieval endpoints pass results through `toUserResponse()`, guaranteeing that sensitive fields (`password`, `salt`, `resetToken`, `twoFactorSecret`, `backupCodes`) can never leak to client responses.

---

## 3. API Endpoints Reference

All public endpoints are reached through the API Gateway via `/api/*`:

### OIDC & Discovery (Root Mount)
- `GET /.well-known/openid-configuration` — OIDC discovery document.
- `GET /.well-known/jwks.json` — Public RS256 signing keys.

### Authentication & Token Flow
- `POST /api/auth/authorize` — PKCE Authorization code grant initiation.
- `POST /api/auth/token` — Exchange authorization code or refresh token for JWT access token.
- `POST /api/auth/register` — Standard buyer account registration.
- `POST /api/auth/register/:role` — Role-specific registration (`SELLER`, `PROVIDER`, `AGENT`).
- `POST /api/auth/login` — Direct email/phone and password authentication.
- `POST /api/auth/revoke` — Revoke active refresh token (RFC 7009).
- `POST /api/auth/forgot-password` — Request password reset email.
- `POST /api/auth/reset-password` — Submit new password with validated reset token.

### Two-Factor Authentication (2FA)
- `POST /api/auth/2fa/setup` — Generate TOTP secret and QR code.
- `POST /api/auth/2fa/enable` — Verify initial OTP and activate 2FA with backup codes.
- `POST /api/auth/verify-2fa` — Verify OTP / backup code during login challenge.
- `POST /api/auth/2fa/disable` — Deactivate 2FA (requires current password).

### User Profiles & Addresses
- `GET /api/user/user-info/:id` — View user public profile.
- `PUT /api/user/update-user-info` — Update name, phone, bio.
- `PUT /api/user/update-user-password` — Change password.
- `PUT /api/user/update-user-addresses` — Add/update shipping address.
- `DELETE /api/user/delete-user-address/:id` — Remove shipping address.

### Administration & User Management
- `GET /api/admin/users` — List platform users (requires `users.view`).
- `GET /api/admin/users/:id` — User detail and role assignments.
- `PUT /api/admin/users/:id/role` — Update user role (requires `users.manage`).
- `PUT /api/admin/users/:id/status` — Suspend or reactivate user account.
- `GET /api/admin/sellers` — List sellers with onboarding verification status.

### Internal API (Cluster Credential Required)
- `GET /internal/users/count` — Aggregate account metrics for marketplace dashboard.
- `POST /internal/users/by-ids` — Batch profile lookup for commerce order views.
- `POST /internal/audit-log` — Ingest structured audit events from peer microservices.

---

## 4. Testing

The Identity Service test suite runs on Node's native test runner (`node --test`):

```bash
npm test
```

All **98 tests** pass with zero failures:
- OAuth 2.1 PKCE verification algorithms
- Managed PostgreSQL transaction rollbacks and connection release
- Refresh token rotation and family theft revocation
- 2FA TOTP verification, time window tolerance, and single-use backup codes
- Privacy mapper field sanitization
- Granular RBAC permission enforcement
