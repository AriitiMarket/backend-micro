// Admin roles repository — manages admin_roles, admin_permissions, admin_user_roles tables.
const { getPool } = require('../config/database');

// ── Permissions ──

async function listPermissions() {
  const pool = await getPool();
  const result = await pool.query('SELECT id, key, name, description, module FROM admin_permissions ORDER BY module, name;');
  return result.rows;
}

async function getPermissionByKey(key) {
  const pool = await getPool();
  const result = await pool.query('SELECT id, key, name, description, module FROM admin_permissions WHERE key = $1;', [key]);
  return result.rows[0] || null;
}

async function listPermissionsByModule() {
  const pool = await getPool();
  const result = await pool.query('SELECT id, key, name, description, module FROM admin_permissions ORDER BY module, name;');
  const grouped = {};
  for (const row of result.rows) {
    if (!grouped[row.module]) grouped[row.module] = [];
    grouped[row.module].push(row);
  }
  return grouped;
}

// ── Roles ──

async function listRoles() {
  const pool = await getPool();
  const result = await pool.query(`
    SELECT r.*,
      (SELECT COUNT(*) FROM admin_user_roles ur WHERE ur.role_id = r.id) as user_count
    FROM admin_roles r ORDER BY r.name;
  `);
  return result.rows.map(r => ({ ...r, permissions: r.permissions || [] }));
}

async function getRoleById(id) {
  const pool = await getPool();
  const result = await pool.query(`
    SELECT r.*,
      (SELECT COUNT(*) FROM admin_user_roles ur WHERE ur.role_id = r.id) as user_count
    FROM admin_roles r WHERE r.id = $1;
  `, [id]);
  if (!result.rows[0]) return null;
  const role = result.rows[0];
  return { ...role, permissions: role.permissions || [] };
}

async function getRoleByName(name) {
  const pool = await getPool();
  const result = await pool.query('SELECT * FROM admin_roles WHERE name = $1;', [name]);
  if (!result.rows[0]) return null;
  const role = result.rows[0];
  return { ...role, permissions: role.permissions || [] };
}

async function createRole({ name, displayName, description, permissions }) {
  const pool = await getPool();
  const result = await pool.query(
    `INSERT INTO admin_roles (name, display_name, description, permissions) VALUES ($1, $2, $3, $4) RETURNING *;`,
    [name, displayName, description || null, JSON.stringify(permissions || [])]
  );
  return { ...result.rows[0], permissions: result.rows[0].permissions || [] };
}

async function updateRole(id, { displayName, description, permissions }) {
  const pool = await getPool();
  const fields = [];
  const values = [];
  let idx = 1;
  if (displayName !== undefined) { fields.push(`display_name = $${idx++}`); values.push(displayName); }
  if (description !== undefined) { fields.push(`description = $${idx++}`); values.push(description); }
  if (permissions !== undefined) { fields.push(`permissions = $${idx++}`); values.push(JSON.stringify(permissions)); }
  if (fields.length === 0) return getRoleById(id);
  fields.push('updated_at = NOW()');
  values.push(id);
  await pool.query(`UPDATE admin_roles SET ${fields.join(', ')} WHERE id = $${idx};`, values);
  return getRoleById(id);
}

async function deleteRole(id) {
  const pool = await getPool();
  // Check if system role
  const check = await pool.query('SELECT is_system FROM admin_roles WHERE id = $1;', [id]);
  if (check.rows[0]?.is_system) {
    throw Object.assign(new Error('Cannot delete system roles'), { status: 400 });
  }
  // Remove all user assignments first
  await pool.query('DELETE FROM admin_user_roles WHERE role_id = $1;', [id]);
  await pool.query('DELETE FROM admin_roles WHERE id = $1;', [id]);
  return true;
}

// ── User-Role Assignments ──

async function getUserRoles(userId) {
  const pool = await getPool();
  const result = await pool.query(`
    SELECT r.id, r.name, r.display_name, r.description, ur.assigned_at, ur.assigned_by,
      array_agg(DISTINCT ap.key) FILTER (WHERE ap.id IS NOT NULL) as permission_keys
    FROM admin_roles r
    JOIN admin_user_roles ur ON ur.role_id = r.id
    LEFT JOIN admin_role_permissions arp ON r.id = arp.role_id
    LEFT JOIN admin_permissions ap ON arp.permission_id = ap.id
    WHERE ur.user_id = $1
    GROUP BY r.id, r.name, r.display_name, r.description, ur.assigned_at, ur.assigned_by
    ORDER BY r.name;
  `, [userId]);
  return result.rows.map(r => ({ ...r, permissions: r.permission_keys || [] }));
}

async function getAllUserRoles() {
  const pool = await getPool();
  const result = await pool.query(`
    SELECT ur.user_id, u.name as user_name, u.email as user_email,
      r.id as role_id, r.name as role_name, r.display_name as role_display_name, ur.assigned_at
    FROM admin_user_roles ur
    JOIN users u ON u.id = ur.user_id
    JOIN admin_roles r ON r.id = ur.role_id
    ORDER BY u.name, r.name;
  `);
  return result.rows;
}

async function assignRole(userId, roleId, assignedBy = null) {
  const pool = await getPool();
  try {
    await pool.query(
      `INSERT INTO admin_user_roles (user_id, role_id, assigned_by) VALUES ($1, $2, $3) ON CONFLICT (user_id, role_id) DO NOTHING;`,
      [userId, roleId, assignedBy]
    );
  } catch (err) {
    if (err.code === '23503') {
      throw Object.assign(new Error('User or role not found'), { status: 404 });
    }
    throw err;
  }
  return getUserRoles(userId);
}

async function removeRole(userId, roleId) {
  const pool = await getPool();
  await pool.query('DELETE FROM admin_user_roles WHERE user_id = $1 AND role_id = $2;', [userId, roleId]);
  return getUserRoles(userId);
}

async function getEffectivePermissions(userId) {
  const pool = await getPool();
  const result = await pool.query(`
    SELECT DISTINCT ap.key as permission
    FROM admin_roles r
    JOIN admin_user_roles ur ON ur.role_id = r.id
    JOIN admin_role_permissions arp ON r.id = arp.role_id
    JOIN admin_permissions ap ON arp.permission_id = ap.id
    WHERE ur.user_id = $1;
  `, [userId]);
  return result.rows.map(r => r.permission);
}

module.exports = {
  listPermissions,
  getPermissionByKey,
  listPermissionsByModule,
  listRoles,
  getRoleById,
  getRoleByName,
  createRole,
  updateRole,
  deleteRole,
  getUserRoles,
  getAllUserRoles,
  assignRole,
  removeRole,
  getEffectivePermissions,
};
