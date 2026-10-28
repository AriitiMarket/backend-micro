const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRole, ROLES, LEGACY_ROLE_ALIASES } = require('../../models/Role');
const { resolveAdminAuthorization } = require('../../services/adminAuthorization.service');
const adminRolesRepo = require('../../repositories/admin-roles.repository');
const authorize = require('../../middleware/authorize');

test('Role.js: normalizeRole canonicalizes all admin variants to ADMIN', () => {
  assert.equal(normalizeRole('OPERATIONS_ADMIN'), 'ADMIN');
  assert.equal(normalizeRole('SUPER_ADMIN'), 'ADMIN');
  assert.equal(normalizeRole('OPS_ADMIN'), 'ADMIN');
  assert.equal(normalizeRole('OPERATIONAL_ADMIN'), 'ADMIN');
  assert.equal(normalizeRole('ADMIN'), 'ADMIN');
  assert.equal(normalizeRole('CUSTOMER'), 'BUYER');
  assert.equal(normalizeRole('BUYER'), 'BUYER');
});

test('adminAuthorization.service: resolves unassigned operations admin with default operational permissions', async () => {
  const original = adminRolesRepo.getUserRoles;
  adminRolesRepo.getUserRoles = async () => [];

  try {
    const user = {
      id: 'test-ops-user-id',
      role: 'OPERATIONS_ADMIN',
      adminScope: { locations: ['*'], services: ['*'] },
    };

    const auth = await resolveAdminAuthorization(user);
    assert.ok(auth.adminRoles.includes('OPERATIONS_ADMIN'));
    assert.ok(auth.permissions.includes('orders.view'));
    assert.ok(auth.permissions.includes('delivery.view'));
    assert.ok(auth.permissions.includes('dashboard.view'));
    assert.equal(auth.adminScope.locations[0], '*');
  } finally {
    adminRolesRepo.getUserRoles = original;
  }
});

test('adminAuthorization.service: resolves explicit RBAC operations admin roles', async () => {
  const original = adminRolesRepo.getUserRoles;
  adminRolesRepo.getUserRoles = async () => [
    {
      id: 'role-ops-1',
      name: 'OPERATIONS_ADMIN',
      permissions: ['orders.view', 'delivery.view', 'reports.view'],
    },
  ];

  try {
    const user = {
      id: 'test-ops-user-2',
      role: 'ADMIN',
      adminScope: { locations: ['L1'] },
    };

    const auth = await resolveAdminAuthorization(user);
    assert.ok(auth.adminRoles.includes('OPERATIONS_ADMIN'));
    assert.ok(auth.permissions.includes('orders.view'));
    assert.ok(auth.permissions.includes('delivery.view'));
    assert.ok(auth.permissions.includes('reports.view'));
    assert.equal(auth.adminScope.locations[0], 'L1');
  } finally {
    adminRolesRepo.getUserRoles = original;
  }
});

test('middleware/authorize: accepts OPERATIONS_ADMIN for authorize("ADMIN")', () => {
  const middleware = authorize('ADMIN');
  let nextCalled = false;
  let statusResult = null;
  let jsonResult = null;

  const req = {
    user: {
      id: 'ops-user-1',
      role: 'OPERATIONS_ADMIN',
    },
  };
  const res = {
    status(s) {
      statusResult = s;
      return {
        json(j) {
          jsonResult = j;
        },
      };
    },
  };
  const next = () => {
    nextCalled = true;
  };

  middleware(req, res, next);
  assert.equal(nextCalled, true, 'Operations admin should be authorized for ADMIN endpoints');
  assert.equal(statusResult, null);
});
