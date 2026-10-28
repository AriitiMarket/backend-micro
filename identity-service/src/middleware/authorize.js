// Role-based authorization — CANONICAL implementation.
//
// This file is intentionally byte-identical across identity, commerce and
// delivery. It previously existed as three drifting copies: commerce and
// delivery accepted an `{ exact }` option and replied with a direct 403 body,
// while identity had no `exact` and deferred to its own errorHandler — so the
// same rejection produced different JSON (and sometimes no `code`) depending on
// which service you hit. Keep the three copies in sync; if you change one,
// change all three.
//
// Semantics (identical in every service):
//   * roles are spelled with the canonical vocabulary BUYER / SELLER /
//     PROVIDER / AGENT / ADMIN; the legacy spelling CUSTOMER is normalized to
//     BUYER on BOTH sides (allowed lists and the caller's roles) so old route
//     definitions and old rows keep working without a second actor type;
//   * a role is allowed only if it is explicitly listed;
//   * a role an account holds as a CAPABILITY counts exactly like the token's
//     primary `role`, so one account can be a seller AND a delivery provider and
//     satisfy both gates;
//   * SELLER inherits BUYER (one-account model) unless `exact: true`;
//   * ADMIN has NO implicit bypass — admin endpoints must list 'ADMIN', which
//     keeps least-privilege auditing simple. ADMIN is never sent as a capability
//     either, so it can never be inherited from another actor role;
//   * a held role is not enough on its own: the account's membership STATUS for
//     that role is checked too, so a pending / rejected / suspended application
//     answers ROLE_NOT_APPROVED / ROLE_REJECTED / ROLE_SUSPENDED instead of a
//     bare "forbidden". Statuses arrive as the `role_statuses` claim, relayed by
//     the gateway as `x-user-role-statuses`.
// The response is written directly rather than delegated to an errorHandler so
// the failure body is identical everywhere.
const LEGACY_ROLE_ALIASES = {
  CUSTOMER: 'BUYER',
  SUPER_ADMIN: 'ADMIN',
  OPERATIONS_ADMIN: 'ADMIN',
  OPERATIONAL_ADMIN: 'ADMIN',
  OPS_ADMIN: 'ADMIN',
  OPSADMIN: 'ADMIN',
  OS_ADMIN: 'ADMIN',
  OSADMIN: 'ADMIN',
  OPERATIONS: 'ADMIN',
};

// Membership statuses that block a gate, mapped to the platform's canonical
// authorization codes. Anything else (ACTIVE, or no status at all) is usable.
const BLOCKING_STATUSES = {
  PENDING: { code: 'ROLE_NOT_APPROVED', message: 'is pending approval' },
  PENDING_REVIEW: { code: 'ROLE_NOT_APPROVED', message: 'is pending approval' },
  REJECTED: { code: 'ROLE_REJECTED', message: 'application was rejected' },
  SUSPENDED: { code: 'ROLE_SUSPENDED', message: 'access is suspended' },
};

function normalizeRole(role) {
  if (!role) return null;
  const upper = String(role).toUpperCase();
  return LEGACY_ROLE_ALIASES[upper] || upper;
}

// Severity order: the most specific blocking reason wins when every satisfying
// role is blocked.
function blockingPriority(code) {
  if (code === 'ROLE_SUSPENDED') return 3;
  if (code === 'ROLE_REJECTED') return 2;
  return 1;
}

function authorize(rolesArray, options = {}) {
  const allowedRoles = (Array.isArray(rolesArray) ? rolesArray : [rolesArray])
    .map(normalizeRole)
    .filter(Boolean);
  const { exact = false } = options;

  return function (req, res, next) {
    const deny = (code, message) => {
      const status = code === 'AUTH_REQUIRED' ? 401 : 403;
      return res.status(status).json({
        success: false,
        code,
        message: message || 'You do not have permission to perform this action',
        errors: [],
      });
    };

    if (!req.user || !req.user.role) {
      return deny('AUTH_REQUIRED', 'Authentication required');
    }

    const role = normalizeRole(req.user.role);
    const capabilities = Array.isArray(req.user.capabilities)
      ? req.user.capabilities.map(normalizeRole).filter(Boolean)
      : [];

    // One account, many actors: the token's `role` is only the PRIMARY role, so
    // every capability the account holds counts as an actor role here.
    const effectiveRoles = [role, ...capabilities];

    // A seller is also a buyer unless the caller asked for an exact role.
    if (!exact && (role === 'SELLER' || capabilities.includes('SELLER'))) {
      effectiveRoles.push('BUYER');
    }

    // A status map that is missing entirely means the token predates the
    // `role_statuses` claim: fall back to the historical "held role is enough"
    // behaviour rather than locking every existing session out.
    const statuses = req.user.roleStatuses && typeof req.user.roleStatuses === 'object'
      ? req.user.roleStatuses
      : null;

    const statusOf = (target) => {
      if (!statuses) return null;
      const raw = statuses[target] || statuses[target.toUpperCase()] || null;
      return raw ? String(raw).toUpperCase() : null;
    };

    // Most specific blocking reason across the requested roles, used both when a
    // role is missing (a PENDING application must not read as "you are not a
    // seller") and when every satisfying role is blocked.
    const worstBlock = (roles) => {
      let best = null;
      for (const target of roles) {
        const blocking = BLOCKING_STATUSES[statusOf(target)];
        if (blocking && (!best || blockingPriority(blocking.code) > blockingPriority(best.code))) {
          best = { code: blocking.code, message: blocking.message, role: target };
        }
      }
      return best;
    };

    const satisfying = allowedRoles.filter((r) => effectiveRoles.includes(r));
    if (satisfying.length === 0) {
      const pending = worstBlock(allowedRoles);
      if (pending) return deny(pending.code, `Your ${pending.role} ${pending.message}`);
      return deny('ROLE_REQUIRED', 'You do not have permission to perform this action');
    }

    // Gate on the membership STATUS of the roles that satisfied the gate.
    if (statuses) {
      let best = null;
      let usable = false;
      for (const satisfied of satisfying) {
        const blocking = BLOCKING_STATUSES[statusOf(satisfied)];
        if (!blocking) {
          usable = true;
          break;
        }
        if (!best || blockingPriority(blocking.code) > blockingPriority(best.code)) {
          best = { code: blocking.code, message: blocking.message, role: satisfied };
        }
      }
      if (!usable && best) {
        return deny(best.code, `Your ${best.role} ${best.message}`);
      }
    }

    return next();
  };
}

module.exports = authorize;
module.exports.authorize = authorize;
