# Admin Rules Update Report

Date: 2026-10-18

## Objective

Make the administrator model clear and fail-safe:

- `SUPER_ADMIN` owns platform-wide configuration, RBAC, financial settings,
  approvals, and emergency actions.
- `OPERATIONAL_ADMIN` runs daily orders, delivery, and dispute operations.
- An administrator must have an explicit admin-role assignment.
- The API Gateway remains the public authorization boundary; the Admin Web is
  only a user-interface guard and must not be treated as the security boundary.

## What was updated

### 1. Added the `OPERATIONAL_ADMIN` system role

File: `identity-service/src/config/database.js`

The new system role has:

- Dashboard read access.
- User, business, shop, and location read access.
- Order read and operational management access.
- Delivery read and management access.
- Dispute read and management access.
- Reports read access.
- Audit-log read access.

It does **not** have:

- `admin_roles.manage`
- `admin_roles.view`
- `platform_settings.manage`
- `platform_settings.view`
- `commerce.manage`
- `locations.manage`
- `businesses.manage`
- `shops.manage`
- `users.manage`
- `audit.manage`

This prevents an operational administrator from changing platform policy,
assigning privileges, changing financial/configuration settings, approving
businesses, or deleting audit history.

### 2. Removed implicit wildcard access for unassigned admins

File: `identity-service/src/services/adminAuthorization.service.js`

Previously, an `ADMIN` account with no row in `admin_user_roles` received the
wildcard permission `*`. That meant a newly-created or forgotten admin account
could receive full access without an explicit role assignment.

The new default is fail-closed:

```text
ADMIN + explicit role assignment   -> permissions from assigned roles
ADMIN + no assignment              -> no admin permissions
non-ADMIN                          -> no admin permissions
```

For controlled migration only, the environment variable below can temporarily
restore the old behavior:

```text
ALLOW_UNASSIGNED_ADMIN_WILDCARD=true
```

It must be set back to `false` after every legacy administrator has received an
explicit role.

### 3. Made the seeded administrator explicit

File: `identity-service/src/seed/seed-admin.js`

The seed now creates or verifies an explicit `SUPER_ADMIN` assignment in
`admin_user_roles`. This keeps the seeded administrator working after wildcard
fallback is disabled and makes the access decision visible in the RBAC tables.

The assignment is idempotent and does not create duplicates.

### 4. Documented the migration switch

File: `identity-service/.env.example`

The environment template now explains the fail-closed default and the limited
purpose of `ALLOW_UNASSIGNED_ADMIN_WILDCARD`.

### 5. Corrected the platform-route documentation

File: `commerce-service/src/modules/platform/routes/adminPlatform.routes.js`

The comment previously claimed that all platform routes required `SUPER_ADMIN`.
That was inaccurate because the API Gateway applies permission-specific rules.
The comment now documents the real policy: operational users may read daily
operations, while business approval requires `businesses.manage`.

### 6. Clarified permission middleware behavior

File: `identity-service/src/middleware/requirePermission.js`

The comment now states that wildcard access is explicit and that new admins
must receive a role assignment. The middleware behavior itself remains
compatible with explicit wildcard permissions.

## Recommended administrator policy

| Role | Main responsibility | Should control |
|---|---|---|
| `SUPER_ADMIN` | Platform owner / security owner | RBAC, users, settings, financial configuration, seller/provider approvals, locations, audit administration, emergency overrides |
| `OPERATIONAL_ADMIN` | Daily operations | Orders, delivery assignments, provider operations, disputes, operational reports, read-only business context |

Use separate accounts for these roles. Do not use the seeded
`SUPER_ADMIN` account for routine order or delivery work.

## Deployment steps

1. Deploy the Identity Service with the new schema seed code.
2. Run the normal Identity database initialization so
   `OPERATIONAL_ADMIN` is inserted into `admin_roles`.
3. Run:

   ```text
   docker compose exec identity-service node src/seed/seed-admin.js
   ```

   This ensures the seeded account has an explicit `SUPER_ADMIN` assignment.
4. List existing administrators and their assignments using the admin-role
   APIs or directly from PostgreSQL.
5. Assign `SUPER_ADMIN` or `OPERATIONAL_ADMIN` to every legitimate admin.
6. Keep `ALLOW_UNASSIGNED_ADMIN_WILDCARD=false`.
7. Re-authenticate administrator sessions so new access-token claims contain
   the explicit role and permissions.
8. Verify that:
   - an operational admin can view and manage orders/delivery/disputes;
   - an operational admin receives `403` for settings, RBAC, approvals, and
     financial administration;
   - a super admin can perform the full administrative workflow.

If a legacy deployment needs uninterrupted access during step 4, set
`ALLOW_UNASSIGNED_ADMIN_WILDCARD=true` only for that migration window, then
disable it and restart Identity.

## Admin Web alignment required

The Admin Web is maintained in the separate repository
`AriitiMarket/Aritii-admin-web`; it was not modified in this backend change.
Its current frontend role list contains `SUPER_ADMIN`, `RIDER_ADMIN`,
`SELLER_ADMIN`, and `CUSTOMER_ADMIN`.

The next frontend change should:

1. Add `OPERATIONAL_ADMIN` to the frontend role type and role labels.
2. Replace role-only route visibility with the backend permission claims where
   possible.
3. Show operational pages for `OPERATIONAL_ADMIN`.
4. Hide settings, role management, financial configuration, and approval
   actions from `OPERATIONAL_ADMIN`.
5. Keep backend `403` responses authoritative even when a page or button is
   accidentally visible.

## Remaining work deliberately not changed

This update does not change checkout totals, delivery prices, tax, commission,
or promotion behavior. Those rules currently have conflicting implementations
between Commerce, Delivery, settlement allocation, and platform settings.
Changing them without an approved pricing policy could change real customer
charges or seller payouts.

The next business-rule phase should define and implement one versioned pricing
engine before wiring Admin Web financial settings into checkout.

## Validation

Completed:

- Reviewed the current Identity RBAC resolver, permission middleware, database
  seed, Gateway permission mapping, and platform admin routes.
- Checked the patch with `git diff --check`.
- Confirmed the new role uses existing canonical permission keys.
- Identity Service test suite passed: 74 tests.
- API Gateway test suite passed: 25 tests.

The first API Gateway test run was blocked by a missing local `semver`
dependency in the workspace installation. Running the existing
`api-gateway` install restored the declared dependencies; the test suite then
passed. No application dependency declaration was intentionally added by this
RBAC change.

Not completed in this phase:

- Database-backed integration tests, because they require the running
  PostgreSQL/Identity stack.
- Admin Web source changes, because that application is in a separate
  repository and this workspace contains only the backend.

## Changed files

| File | Reason |
|---|---|
| `identity-service/src/config/database.js` | Seed the explicit `OPERATIONAL_ADMIN` role and its least-privilege permissions |
| `identity-service/src/services/adminAuthorization.service.js` | Fail closed for unassigned admins with an opt-in migration switch |
| `identity-service/src/seed/seed-admin.js` | Explicitly assign `SUPER_ADMIN` to the seeded administrator |
| `identity-service/src/middleware/requirePermission.js` | Document the new explicit-assignment behavior |
| `identity-service/.env.example` | Document the migration flag and safe default |
| `commerce-service/src/modules/platform/routes/adminPlatform.routes.js` | Correct the route authorization documentation |
| `ADMIN-RULES-UPDATE-REPORT.md` | Record the policy, implementation, deployment steps, and remaining work |
