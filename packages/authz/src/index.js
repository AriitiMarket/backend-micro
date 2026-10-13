/**
 * Role-based authorization (RBAC)
 */

const ROLE_HIERARCHY = {
  'admin': { level: 100, permissions: ['*'] },
  'moderator': { level: 75, permissions: ['moderate', 'read', 'support'] },
  'seller': { level: 50, permissions: ['sell', 'read', 'edit_own'] },
  'provider': { level: 40, permissions: ['deliver', 'read', 'update_status'] },
  'buyer': { level: 20, permissions: ['buy', 'read', 'comment'] },
  'guest': { level: 0, permissions: ['read_public'] }
};

class AuthorizationManager {
  /**
   * Normalize role name
   */
  static normalizeRole(role) {
    if (!role) return 'guest';
    return role.toLowerCase().trim();
  }

  /**
   * Get role level (for hierarchy)
   */
  static getRoleLevel(role) {
    const normalized = this.normalizeRole(role);
    return ROLE_HIERARCHY[normalized]?.level || 0;
  }

  /**
   * Get role permissions
   */
  static getPermissions(role) {
    const normalized = this.normalizeRole(role);
    return ROLE_HIERARCHY[normalized]?.permissions || [];
  }

  /**
   * Check if user has permission
   */
  static hasPermission(userRole, requiredPermission) {
    const permissions = this.getPermissions(userRole);
    return permissions.includes('*') || permissions.includes(requiredPermission);
  }

  /**
   * Check if user has role
   */
  static hasRole(userRole, requiredRole) {
    const normalized = this.normalizeRole(userRole);
    return normalized === this.normalizeRole(requiredRole);
  }

  /**
   * Check if user can access (hierarchy-based)
   */
  static canAccess(userRole, requiredRole) {
    const userLevel = this.getRoleLevel(userRole);
    const requiredLevel = this.getRoleLevel(requiredRole);
    return userLevel >= requiredLevel;
  }

  /**
   * Authorize middleware factory
   */
  static middleware(...allowedRoles) {
    return (req, res, next) => {
      const userRole = req.user?.role || 'guest';

      // Check if user has any of the allowed roles
      const authorized = allowedRoles.some(role =>
        this.canAccess(userRole, role)
      );

      if (!authorized) {
        return res.status(403).json({
          success: false,
          message: 'Insufficient permissions',
          userRole,
          requiredRoles: allowedRoles
        });
      }

      next();
    };
  }

  /**
   * Check specific permission middleware
   */
  static requirePermission(permission) {
    return (req, res, next) => {
      const userRole = req.user?.role || 'guest';

      if (!this.hasPermission(userRole, permission)) {
        return res.status(403).json({
          success: false,
          message: `Permission '${permission}' required`,
          userRole,
          requiredPermission: permission
        });
      }

      next();
    };
  }

  /**
   * Ownership check middleware
   */
  static requireOwnership(resourceOwnerId) {
    return (req, res, next) => {
      const userId = req.user?.id;
      const userRole = req.user?.role;

      // Admin can access everything
      if (userRole === 'admin') {
        return next();
      }

      // Owner can access their own
      if (userId === resourceOwnerId) {
        return next();
      }

      return res.status(403).json({
        success: false,
        message: 'You do not have access to this resource'
      });
    };
  }
}

module.exports = AuthorizationManager;
