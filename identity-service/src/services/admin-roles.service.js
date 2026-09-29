// Admin roles service — business logic for role and permission management.
const adminRolesRepo = require('../repositories/admin-roles.repository');
const usersRepo = require('../repositories/users.repository');
const auditService = require('./audit.service');

async function listPermissions() {
  return adminRolesRepo.listPermissions();
}

async function listPermissionsByModule() {
  return adminRolesRepo.listPermissionsByModule();
}

async function listRoles() {
  return adminRolesRepo.listRoles();
}

async function getRole(id) {
  const role = await adminRolesRepo.getRoleById(id);
  if (!role) throw Object.assign(new Error('Role not found'), { status: 404 });
  return role;
}

async function createRole(data, adminId, adminName, req) {
  // Validate name format
  if (!data.name || !data.displayName) {
    throw Object.assign(new Error('Name and display name are required'), { status: 400 });
  }
  const name = data.name.toUpperCase().replace(/\s+/g, '_');
  const existing = await adminRolesRepo.getRoleByName(name);
  if (existing) {
    throw Object.assign(new Error('Role with this name already exists'), { status: 409 });
  }
  // Validate permissions exist
  const allPerms = await adminRolesRepo.listPermissions();
  const validKeys = new Set(allPerms.map(p => p.key));
  const invalidPerms = (data.permissions || []).filter(p => !validKeys.has(p));
  if (invalidPerms.length > 0) {
    throw Object.assign(new Error(`Invalid permissions: ${invalidPerms.join(', ')}`), { status: 400 });
  }
  const role = await adminRolesRepo.createRole({
    name,
    displayName: data.displayName,
    description: data.description || null,
    permissions: data.permissions || [],
  });
  await auditService.logAction({
    action: 'ADMIN_ROLE_CREATED',
    level: 'INFO',
    adminId, adminName,
    module: 'admin_roles',
    targetEntity: 'admin_role',
    targetId: role.id,
    newValue: { name: role.name, displayName: role.displayName, permissions: role.permissions },
    req,
  });
  return role;
}

async function updateRole(id, data, adminId, adminName, req) {
  const oldRole = await adminRolesRepo.getRoleById(id);
  if (!oldRole) throw Object.assign(new Error('Role not found'), { status: 404 });
  if (oldRole.is_system && data.permissions) {
    // Allow updating system role permissions but log it
  }
  if (data.permissions) {
    const allPerms = await adminRolesRepo.listPermissions();
    const validKeys = new Set(allPerms.map(p => p.key));
    const invalidPerms = data.permissions.filter(p => !validKeys.has(p));
    if (invalidPerms.length > 0) {
      throw Object.assign(new Error(`Invalid permissions: ${invalidPerms.join(', ')}`), { status: 400 });
    }
  }
  const updated = await adminRolesRepo.updateRole(id, {
    displayName: data.displayName,
    description: data.description,
    permissions: data.permissions,
  });
  await auditService.logAction({
    action: 'ADMIN_ROLE_UPDATED',
    level: 'WARNING',
    adminId, adminName,
    module: 'admin_roles',
    targetEntity: 'admin_role',
    targetId: id,
    previousValue: { permissions: oldRole.permissions, displayName: oldRole.display_name },
    newValue: { permissions: updated.permissions, displayName: updated.display_name },
    req,
  });
  return updated;
}

async function deleteRole(id, adminId, adminName, req) {
  const role = await adminRolesRepo.getRoleById(id);
  if (!role) throw Object.assign(new Error('Role not found'), { status: 404 });
  if (role.is_system) {
    throw Object.assign(new Error('Cannot delete system roles'), { status: 400 });
  }
  await adminRolesRepo.deleteRole(id);
  await auditService.logAction({
    action: 'ADMIN_ROLE_DELETED',
    level: 'CRITICAL',
    adminId, adminName,
    module: 'admin_roles',
    targetEntity: 'admin_role',
    targetId: id,
    previousValue: { name: role.name, displayName: role.display_name },
    req,
  });
  return true;
}

async function getUserRoles(userId) {
  const user = await usersRepo.findById(userId);
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
  const roles = await adminRolesRepo.getUserRoles(userId);
  const permissions = await adminRolesRepo.getEffectivePermissions(userId);
  return { user: { id: user.id, name: user.name, email: user.email, role: user.role }, roles, permissions };
}

async function getAllUserRoles() {
  return adminRolesRepo.getAllUserRoles();
}

async function assignRole(userId, roleId, adminId, adminName, req) {
  const user = await usersRepo.findById(userId);
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
  const role = await adminRolesRepo.getRoleById(roleId);
  if (!role) throw Object.assign(new Error('Role not found'), { status: 404 });
  const updatedRoles = await adminRolesRepo.assignRole(userId, roleId, adminId);
  await auditService.logAction({
    action: 'ADMIN_ROLE_ASSIGNED',
    level: 'WARNING',
    adminId, adminName,
    module: 'admin_roles',
    targetEntity: 'user',
    targetId: userId,
    newValue: { roleId, roleName: role.name },
    req,
  });
  return updatedRoles;
}

async function removeRole(userId, roleId, adminId, adminName, req) {
  const role = await adminRolesRepo.getRoleById(roleId);
  const updatedRoles = await adminRolesRepo.removeRole(userId, roleId);
  await auditService.logAction({
    action: 'ADMIN_ROLE_REMOVED',
    level: 'WARNING',
    adminId, adminName,
    module: 'admin_roles',
    targetEntity: 'user',
    targetId: userId,
    previousValue: { roleId, roleName: role?.name },
    req,
  });
  return updatedRoles;
}

async function getEffectivePermissions(userId) {
  return adminRolesRepo.getEffectivePermissions(userId);
}

module.exports = {
  listPermissions,
  listPermissionsByModule,
  listRoles,
  getRole,
  createRole,
  updateRole,
  deleteRole,
  getUserRoles,
  getAllUserRoles,
  assignRole,
  removeRole,
  getEffectivePermissions,
};
