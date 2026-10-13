const usersRepo = require('../repositories/users.repository');
const auditService = require('./audit.service');
const { ROLES, normalizeRole } = require('../models/Role');

function isValidUUID(id) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(id);
}

async function listUsers(opts) {
  return usersRepo.listAll(opts);
}

async function getUser(id) {
    if (!isValidUUID(id)) {
        throw Object.assign(new Error('Invalid user ID'), { status: 400 });
    }
    const user = await usersRepo.findById(id);
    if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
    return user;
}

async function setRole(userId, role, adminId = 'system', adminName = 'System', req = null) {
  // Every platform actor is assignable here; ADMIN is a privileged grant and is
  // deliberately included so the console can promote/demote administrators.
  const canonical = normalizeRole(role);
  const allowed = [ROLES.BUYER, ROLES.SELLER, ROLES.PROVIDER, ROLES.AGENT, ROLES.ADMIN];
  if (!allowed.includes(canonical)) throw Object.assign(new Error('Invalid role'), { status: 400 });
  const user = await usersRepo.findById(userId);
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });

  const oldRole = user.role;
  const result = await usersRepo.setRole(userId, canonical);
  
  if (canonical !== normalizeRole(oldRole)) {
    await auditService.logRoleChanged(adminId, adminName, userId, oldRole, canonical, req);
  }
  
  return result;
}

async function setUserStatus(userId, status, adminId = 'system', adminName = 'System', req = null) {
  const allowed = ['active', 'inactive', 'suspended', 'banned'];
  if (!allowed.includes(status)) throw Object.assign(new Error('Invalid status'), { status: 400 });
  const user = await usersRepo.findById(userId);
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
  
  const oldStatus = user.status;
  const result = await usersRepo.setStatus(userId, status);
  
  if (status === 'suspended') {
    await auditService.logUserSuspended(adminId, adminName, userId, null, req);
  } else if (status === 'banned') {
    await auditService.logUserBanned(adminId, adminName, userId, null, req);
  } else if (oldStatus === 'suspended' || oldStatus === 'banned') {
    await auditService.logUserReactivated(adminId, adminName, userId, req);
  }
  
  return result;
}

async function setAdminScope(userId, scope) {
  const user = await usersRepo.findById(userId);
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
  if (user.role !== 'ADMIN') throw Object.assign(new Error('User must be ADMIN to set scope'), { status: 400 });
  return usersRepo.setAdminScope(userId, scope);
}

async function getAdminScope(userId) {
  const user = await usersRepo.findById(userId);
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
  return user.adminScope || {};
}

async function listSellers(opts) {
  return usersRepo.listSellers(opts);
}

async function getSeller(id) {
    if (!isValidUUID(id)) {
        throw Object.assign(new Error('Invalid seller ID'), { status: 400 });
    }
    const seller = await usersRepo.findById(id);
    if (!seller) throw Object.assign(new Error('Seller not found'), { status: 404 });
    if (normalizeRole(seller.role) !== ROLES.SELLER) throw Object.assign(new Error('User is not a seller'), { status: 400 });
    return seller;
}

async function getDashboardStats() {
  const [userCounts, sellerCounts] = await Promise.all([
    usersRepo.counts(),
    usersRepo.countSellersByStatus(),
  ]);

  return {
    totalUsers: userCounts.total,
    totalSellers: userCounts.sellers,
    totalAdmins: userCounts.admins,
    totalBuyers: userCounts.buyers,
    // Legacy alias for existing dashboard consumers.
    totalCustomers: userCounts.customers,
    totalAgents: userCounts.agents,
    activeUsers: userCounts.active,
    inactiveUsers: userCounts.inactive,
    suspendedUsers: userCounts.suspended,
    bannedUsers: userCounts.banned,
    usersByRole: userCounts.byRole,
    usersByStatus: userCounts.byStatus,
    sellersByStatus: sellerCounts.byStatus,
  };
}

async function getPendingStats() {
  const sellerCounts = await usersRepo.countSellersByStatus();
  const pendingStatuses = ['PENDING_REVIEW', 'pending'];
  const pendingSellers = pendingStatuses.reduce(
    (sum, status) => sum + (sellerCounts.byStatus[status] || 0),
    0
  );

  return {
    pendingSellers,
    totalSellers: sellerCounts.total,
    sellersByStatus: sellerCounts.byStatus,
    timestamp: new Date().toISOString(),
  };
}

module.exports = { listUsers, getUser, setRole, setUserStatus, setAdminScope, getAdminScope, listSellers, getSeller, getDashboardStats, getPendingStats };
