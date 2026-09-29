// Audit logging service for sensitive admin actions — persists to PostgreSQL.
const auditRepository = require('../repositories/audit.repository');

const AUDIT_LEVELS = {
  INFO: 'INFO',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL',
};

const AUDIT_ACTIONS = {
  USER_SUSPENDED: 'USER_SUSPENDED',
  USER_REACTIVATED: 'USER_REACTIVATED',
  USER_BANNED: 'USER_BANNED',
  USER_UNBANNED: 'USER_UNBANNED',
  USER_ROLE_CHANGED: 'USER_ROLE_CHANGED',
  USER_VERIFIED: 'USER_VERIFIED',
  ADMIN_SCOPE_CHANGED: 'ADMIN_SCOPE_CHANGED',
  SELLER_APPROVED: 'SELLER_APPROVED',
  SELLER_REJECTED: 'SELLER_REJECTED',
  SELLER_SUSPENDED: 'SELLER_SUSPENDED',
  SELLER_REACTIVATED: 'SELLER_REACTIVATED',
  AGENT_VERIFIED: 'AGENT_VERIFIED',
  AGENT_REJECTED: 'AGENT_REJECTED',
  AGENT_UPDATED: 'AGENT_UPDATED',
  AGENT_COMMISSION_CHANGED: 'AGENT_COMMISSION_CHANGED',
  SHOP_APPROVED: 'SHOP_APPROVED',
  SHOP_REJECTED: 'SHOP_REJECTED',
  SHOP_SUSPENDED: 'SHOP_SUSPENDED',
  ORDER_STATUS_CHANGED: 'ORDER_STATUS_CHANGED',
  PAYMENT_REFUNDED: 'PAYMENT_REFUNDED',
  PRODUCT_CREATED: 'PRODUCT_CREATED',
  PRODUCT_UPDATED: 'PRODUCT_UPDATED',
  PRODUCT_DELETED: 'PRODUCT_DELETED',
  DELIVERY_STATUS_CHANGED: 'DELIVERY_STATUS_CHANGED',
  RIDER_STATUS_CHANGED: 'RIDER_STATUS_CHANGED',
  ZONE_UPDATED: 'ZONE_UPDATED',
  DISPUTE_RESOLVED: 'DISPUTE_RESOLVED',
  DISPUTE_REJECTED: 'DISPUTE_REJECTED',
  DISPUTE_STATUS_CHANGED: 'DISPUTE_STATUS_CHANGED',
  SETTINGS_CHANGED: 'SETTINGS_CHANGED',
  PERMISSION_CHANGED: 'PERMISSION_CHANGED',
  PLATFORM_SETTINGS_CHANGED: 'PLATFORM_SETTINGS_CHANGED',
};

const MODULES = {
  IDENTITY: 'identity',
  COMMERCE: 'commerce',
  DELIVERY: 'delivery',
  DISPUTES: 'disputes',
  SETTINGS: 'settings',
  AUTH: 'auth',
  ADMIN_ROLES: 'admin_roles',
  AGENTS: 'agents',
};

async function logAction(opts) {
  const {
    action,
    level = AUDIT_LEVELS.INFO,
    adminId = null,
    adminName = null,
    module = null,
    targetEntity = null,
    targetId = null,
    previousValue = null,
    newValue = null,
    reason = null,
    details = {},
    ipAddress = null,
    userAgent = null,
  } = opts;

  const auditLog = {
    action,
    level,
    adminId,
    adminName,
    module,
    targetEntity,
    targetId,
    previousValue,
    newValue,
    reason,
    details,
    ipAddress,
    userAgent,
  };

  console.log('[AUDIT]', JSON.stringify(auditLog, null, 2));

  try {
    return await auditRepository.create(auditLog);
  } catch (err) {
    console.error('[AUDIT] Failed to persist audit log:', err.message);
    return auditLog;
  }
}

async function logUserSuspended(adminId, adminName, userId, reason = null, req = null) {
  return logAction({
    action: AUDIT_ACTIONS.USER_SUSPENDED,
    level: AUDIT_LEVELS.CRITICAL,
    adminId, adminName,
    module: MODULES.IDENTITY,
    targetEntity: 'user',
    targetId: userId,
    reason,
    ipAddress: req?.ip || req?.headers?.['x-forwarded-for'] || null,
    userAgent: req?.headers?.['user-agent'] || null,
  });
}

async function logUserReactivated(adminId, adminName, userId, req = null) {
  return logAction({
    action: AUDIT_ACTIONS.USER_REACTIVATED,
    level: AUDIT_LEVELS.WARNING,
    adminId, adminName,
    module: MODULES.IDENTITY,
    targetEntity: 'user',
    targetId: userId,
    ipAddress: req?.ip || null,
    userAgent: req?.headers?.['user-agent'] || null,
  });
}

async function logUserBanned(adminId, adminName, userId, reason = null, req = null) {
  return logAction({
    action: AUDIT_ACTIONS.USER_BANNED,
    level: AUDIT_LEVELS.CRITICAL,
    adminId, adminName,
    module: MODULES.IDENTITY,
    targetEntity: 'user',
    targetId: userId,
    reason,
    ipAddress: req?.ip || null,
    userAgent: req?.headers?.['user-agent'] || null,
  });
}

async function logUserUnbanned(adminId, adminName, userId, req = null) {
  return logAction({
    action: AUDIT_ACTIONS.USER_UNBANNED,
    level: AUDIT_LEVELS.WARNING,
    adminId, adminName,
    module: MODULES.IDENTITY,
    targetEntity: 'user',
    targetId: userId,
    ipAddress: req?.ip || null,
    userAgent: req?.headers?.['user-agent'] || null,
  });
}

async function logRoleChanged(adminId, adminName, userId, fromRole, toRole, req = null) {
  return logAction({
    action: AUDIT_ACTIONS.USER_ROLE_CHANGED,
    level: AUDIT_LEVELS.CRITICAL,
    adminId, adminName,
    module: MODULES.IDENTITY,
    targetEntity: 'user',
    targetId: userId,
    previousValue: { role: fromRole },
    newValue: { role: toRole },
    ipAddress: req?.ip || null,
    userAgent: req?.headers?.['user-agent'] || null,
  });
}

async function logSellerApproved(adminId, adminName, sellerId, req = null) {
  return logAction({
    action: AUDIT_ACTIONS.SELLER_APPROVED,
    level: AUDIT_LEVELS.INFO,
    adminId, adminName,
    module: MODULES.IDENTITY,
    targetEntity: 'seller',
    targetId: sellerId,
    ipAddress: req?.ip || null,
    userAgent: req?.headers?.['user-agent'] || null,
  });
}

async function logSellerRejected(adminId, adminName, sellerId, reason = null, req = null) {
  return logAction({
    action: AUDIT_ACTIONS.SELLER_REJECTED,
    level: AUDIT_LEVELS.WARNING,
    adminId, adminName,
    module: MODULES.IDENTITY,
    targetEntity: 'seller',
    targetId: sellerId,
    reason,
    ipAddress: req?.ip || null,
    userAgent: req?.headers?.['user-agent'] || null,
  });
}

async function logSellerSuspended(adminId, adminName, sellerId, reason = null, req = null) {
  return logAction({
    action: AUDIT_ACTIONS.SELLER_SUSPENDED, level: AUDIT_LEVELS.CRITICAL,
    adminId, adminName, module: MODULES.IDENTITY, targetEntity: 'seller', targetId: sellerId, reason,
    ipAddress: req?.ip || null, userAgent: req?.headers?.['user-agent'] || null,
  });
}

async function logSellerReactivated(adminId, adminName, sellerId, req = null) {
  return logAction({
    action: AUDIT_ACTIONS.SELLER_REACTIVATED, level: AUDIT_LEVELS.WARNING,
    adminId, adminName, module: MODULES.IDENTITY, targetEntity: 'seller', targetId: sellerId,
    ipAddress: req?.ip || null, userAgent: req?.headers?.['user-agent'] || null,
  });
}

async function logAgentVerified(adminId, adminName, agentId, req = null) {
  return logAction({
    action: AUDIT_ACTIONS.AGENT_VERIFIED, level: AUDIT_LEVELS.INFO,
    adminId, adminName, module: MODULES.AGENTS, targetEntity: 'agent', targetId: agentId,
    ipAddress: req?.ip || null, userAgent: req?.headers?.['user-agent'] || null,
  });
}

async function logAgentRejected(adminId, adminName, agentId, reason = null, req = null) {
  return logAction({
    action: AUDIT_ACTIONS.AGENT_REJECTED, level: AUDIT_LEVELS.WARNING,
    adminId, adminName, module: MODULES.AGENTS, targetEntity: 'agent', targetId: agentId, reason,
    ipAddress: req?.ip || null, userAgent: req?.headers?.['user-agent'] || null,
  });
}

async function logAgentUpdated(adminId, adminName, agentId, previousValue, newValue, req = null) {
  return logAction({
    action: AUDIT_ACTIONS.AGENT_UPDATED, level: AUDIT_LEVELS.INFO,
    adminId, adminName, module: MODULES.AGENTS, targetEntity: 'agent', targetId: agentId,
    previousValue, newValue,
    ipAddress: req?.ip || null, userAgent: req?.headers?.['user-agent'] || null,
  });
}

async function logAgentCommissionChanged(adminId, adminName, agentId, oldRate, newRate, req = null) {
  return logAction({
    action: AUDIT_ACTIONS.AGENT_COMMISSION_CHANGED, level: AUDIT_LEVELS.WARNING,
    adminId, adminName, module: MODULES.AGENTS, targetEntity: 'agent', targetId: agentId,
    previousValue: { commissionRate: oldRate }, newValue: { commissionRate: newRate },
    ipAddress: req?.ip || null, userAgent: req?.headers?.['user-agent'] || null,
  });
}

async function logAdminScopeChanged(adminId, adminName, userId, previousScope, newScope, req = null) {
  return logAction({
    action: AUDIT_ACTIONS.ADMIN_SCOPE_CHANGED, level: AUDIT_LEVELS.CRITICAL,
    adminId, adminName, module: MODULES.IDENTITY, targetEntity: 'user', targetId: userId,
    previousValue: { adminScope: previousScope }, newValue: { adminScope: newScope },
    ipAddress: req?.ip || null, userAgent: req?.headers?.['user-agent'] || null,
  });
}

module.exports = {
  AUDIT_LEVELS,
  AUDIT_ACTIONS,
  MODULES,
  logAction,
  logUserSuspended,
  logUserReactivated,
  logUserBanned,
  logUserUnbanned,
  logRoleChanged,
  logSellerApproved,
  logSellerRejected,
  logSellerSuspended,
  logSellerReactivated,
  logAgentVerified,
  logAgentRejected,
  logAgentUpdated,
  logAgentCommissionChanged,
  logAdminScopeChanged,
};
