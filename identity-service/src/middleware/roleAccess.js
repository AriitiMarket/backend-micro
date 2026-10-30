// Role access middleware — enforces status-aware authorization for role portals.
//
// This middleware checks if a user has the required role and whether that role
// is in an ACTIVE status before allowing access to protected portals.
//
// It returns appropriate status messages for different role states:
// - PENDING: "Your application is still under review"
// - REJECTED: "Your application was not approved"
// - NOT_APPLIED: "You do not have access. Submit an application to continue"
// - SUSPENDED: "Your access is currently suspended"
// - ACTIVE: Allow access
const userRolesRepo = require('../repositories/user-roles.repository');
const { MEMBERSHIP_STATUSES, ACTOR_ROLES, normalizeRole } = require('../models/Role');

/**
 * Check if user has ACTIVE membership for the required role
 * Returns object with { allowed: boolean, status: string, message: string }
 */
async function checkRoleAccess(userId, requiredRole) {
  if (!userId || !requiredRole) {
    return { 
      allowed: false, 
      status: 'NOT_APPLIED', 
      message: 'Authentication required' 
    };
  }

  // Legacy `CUSTOMER` requests normalize to BUYER — one actor, one spelling.
  const role = normalizeRole(requiredRole);

  // BUYER is implicit for all accounts, no membership check needed
  if (role === 'BUYER') {
    return { 
      allowed: true, 
      status: 'ACTIVE', 
      message: 'Buyer access granted' 
    };
  }

  // For actor roles (SELLER, PROVIDER, AGENT), check membership status
  if (!ACTOR_ROLES.includes(role)) {
    return { 
      allowed: false, 
      status: 'INVALID_ROLE', 
      message: 'Invalid role requested' 
    };
  }

  const memberships = await userRolesRepo.listForUser(userId);
  const membership = memberships.find(m => String(m.role).toUpperCase() === role);

  if (!membership) {
    return { 
      allowed: false, 
      status: 'NOT_APPLIED', 
      message: `You do not have ${role} access. Submit a ${role} application to continue.` 
    };
  }

  const status = String(membership.status).toUpperCase();
  
  switch (status) {
    case MEMBERSHIP_STATUSES.ACTIVE:
    case 'APPROVED':
      return { 
        allowed: true, 
        status: 'ACTIVE', 
        message: `${role} access granted` 
      };
    
    case MEMBERSHIP_STATUSES.PENDING:
      return { 
        allowed: false, 
        status: 'PENDING', 
        message: `Your ${role} application is still under review. You will receive access after approval.` 
      };
    
    case MEMBERSHIP_STATUSES.REJECTED:
      return { 
        allowed: false, 
        status: 'REJECTED', 
        message: `Your ${role} application was not approved. Please review the reason and resubmit if available.` 
      };
    
    case MEMBERSHIP_STATUSES.SUSPENDED:
      return { 
        allowed: false, 
        status: 'SUSPENDED', 
        message: `Your ${role} access is currently suspended. Please contact platform support.` 
      };
    
    default:
      return { 
        allowed: false, 
        status: 'UNKNOWN', 
        message: `Your ${role} access status is unknown. Please contact support.` 
      };
  }
}

/** Membership status -> canonical authorization code (see middleware/authorize.js). */
function canonicalCodeForStatus(status) {
  switch (String(status || '').toUpperCase()) {
    case 'PENDING':
      return 'ROLE_NOT_APPROVED';
    case 'REJECTED':
      return 'ROLE_REJECTED';
    case 'SUSPENDED':
      return 'ROLE_SUSPENDED';
    case 'ACTIVE':
      return 'PERMISSION_DENIED';
    default:
      return 'ROLE_REQUIRED';
  }
}

/**
 * Express middleware to enforce role access
 * Usage: router.get('/seller/*', authenticate, requireRoleAccess('SELLER'), handler)
 */
function requireRoleAccess(requiredRole) {
  return async (req, res, next) => {
    try {
      const userId = req.user?.sub || req.user?.id;
      const access = await checkRoleAccess(userId, requiredRole);

      if (access.allowed) {
        return next();
      }

      // Return status-aware error response. `code` is the platform's canonical
      // authorization code (same vocabulary as authorize()), `error` is kept for
      // the existing portal contract.
      return res.status(403).json({
        success: false,
        error: 'ACCESS_DENIED',
        code: canonicalCodeForStatus(access.status),
        error_description: access.message,
        message: access.message,
        roleStatus: access.status,
        requiredRole,
        errors: [],
      });
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: 'INTERNAL_ERROR',
        message: 'Failed to verify role access',
      });
    }
  };
}

/**
 * Express middleware to check role access but continue even if denied
 * Useful for endpoints that need to return different responses based on status
 */
function checkRoleAccessMiddleware(requiredRole) {
  return async (req, res, next) => {
    try {
      const userId = req.user?.sub || req.user?.id;
      const access = await checkRoleAccess(userId, requiredRole);
      
      // Attach access info to request for handlers to use
      req.roleAccess = {
        allowed: access.allowed,
        status: access.status,
        message: access.message,
        requiredRole,
      };
      
      return next();
    } catch (err) {
      req.roleAccess = {
        allowed: false,
        status: 'ERROR',
        message: 'Failed to verify role access',
        requiredRole,
      };
      return next();
    }
  };
}

module.exports = {
  checkRoleAccess,
  requireRoleAccess,
  checkRoleAccessMiddleware,
};