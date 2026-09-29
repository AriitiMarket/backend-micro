// User repository — only layer that queries the users table.
const crypto = require('crypto');
const { getPool } = require('../config/database');
const { toUser } = require('../models/User');
const { ROLES, normalizeRole } = require('../models/Role');
const userRolesRepo = require('./user-roles.repository');

const USER_COLUMNS = 'id, name, email, phone_number, role, active_role, avatar_public_id, avatar_url, addresses, shop_id, status, is_verified, seller_status, admin_scope, created_at, updated_at';

/** Attach the actor memberships of many rows in ONE extra query (never N+1). */
async function attachMemberships(rows) {
  const list = (rows || []).filter(Boolean);
  if (list.length === 0) return list;
  const byUser = await userRolesRepo.listForUsers(list.map((row) => row.id));
  return list.map((row) => ({ ...row, memberships: byUser.get(String(row.id)) || [] }));
}

/** Attach memberships to a single row (profile reads, token minting). */
async function attachMembershipsOne(row) {
  if (!row) return null;
  const memberships = await userRolesRepo.listForUser(row.id);
  return { ...row, memberships };
}

async function findByEmail(email) {
  const pool = await getPool();
  const result = await pool.query(
    `SELECT ${USER_COLUMNS} FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1;`,
    [email]
  );
  return result.rows[0] ? toUser(result.rows[0]) : null;
}

/**
 * Case-insensitive lookup. Emails are stored exactly as entered, so an admin
 * typing "Seller1@Aritii.com" must still resolve the account.
 */
async function findByEmailInsensitive(email) {
  const pool = await getPool();
  const result = await pool.query(
    `SELECT ${USER_COLUMNS} FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1;`,
    [email]
  );
  return result.rows[0] ? toUser(result.rows[0]) : null;
}

/**
 * Login lookup — MUST match the insensitive rule above: emails are stored
 * exactly as entered, so "Seller1@Aritii.com" typed at the login form has to
 * resolve the same account as the seeded "seller1@aritii.com".
 */
async function findByEmailForLogin(email) {
  const pool = await getPool();
  const result = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1;', [email]);
  // Memberships travel with the raw row because the caller mints the token from
  // it — the capability set must be resolved before signing.
  return attachMembershipsOne(result.rows[0] || null);
}

async function findById(id) {
  const pool = await getPool();
  const result = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1;`, [id]);
  return result.rows[0] ? toUser(await attachMembershipsOne(result.rows[0])) : null;
}

async function create(userData) {
  const pool = await getPool();
  const id = crypto.randomUUID();
  const name = userData.name;
  const email = userData.email;
  const passwordHash = userData.passwordHash;
  const phoneNumber = userData.phoneNumber || null;
  const role = normalizeRole(userData.role) || ROLES.BUYER;
  const avatarPublicId = userData.avatarPublicId || null;
  const avatarUrl = userData.avatarUrl || null;
  const shopId = userData.shopId || null;
  await pool.query(
    'INSERT INTO users (id, name, email, password_hash, phone_number, role, avatar_public_id, avatar_url, shop_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);',
    [id, name, email, passwordHash, phoneNumber, role, avatarPublicId, avatarUrl, shopId]
  );
  return findById(id);
}

async function updateFields(opts) {
  const pool = await getPool();
  const id = opts.id;
  const fields = opts.fields;
  const keys = Object.keys(fields);
  if (keys.length < 1) return findById(id);
  const assignments = keys.map(function (key, index) {
    return key + ' = $' + (index + 1);
  });
  const values = Object.values(fields);
  values.push(id);
  const setSql = assignments.join(', ') + ', updated_at = NOW()';
  await pool.query('UPDATE users SET ' + setSql + ' WHERE id = $' + values.length + ';', values);
  return findById(id);
}

async function updatePassword(opts) {
  return updateFields({ id: opts.id, fields: { password_hash: opts.hash } });
}

async function updateAvatar(opts) {
  return updateFields({ id: opts.id, fields: { avatar_public_id: opts.publicId, avatar_url: opts.url } });
}

async function setShopId(opts) {
  return updateFields({ id: opts.id, fields: { shop_id: opts.shopId } });
}

async function addAddress(opts) {
  const pool = await getPool();
  const newAddress = { _id: crypto.randomUUID() };
  if (opts.addressData) {
    Object.assign(newAddress, opts.addressData);
  }
  await pool.query('UPDATE users SET addresses = addresses || $2::jsonb, updated_at = NOW() WHERE id = $1;', [opts.id, JSON.stringify(newAddress)]);
  return findById(opts.id);
}

async function removeAddress(opts) {
  const pool = await getPool();
  const result = await pool.query('SELECT addresses FROM users WHERE id = $1;', [opts.id]);
  let addresses = [];
  const row = result.rows[0];
  if (row) {
    addresses = row.addresses || [];
  }
  const kept = addresses.filter(function (addr) {
    return String(addr._id) !== opts.addressId;
  });
  await pool.query('UPDATE users SET addresses = $2::jsonb, updated_at = NOW() WHERE id = $1;', [opts.id, JSON.stringify(kept)]);
  return findById(opts.id);
}

async function setAddresses(opts) {
  const pool = await getPool();
  await pool.query(
    'UPDATE users SET addresses = $2::jsonb, updated_at = NOW() WHERE id = $1;',
    [opts.id, JSON.stringify(opts.addresses)]
  );
  return findById(opts.id);
}

async function setSellerStatus(opts) {
  return updateFields({ id: opts.id, fields: { seller_status: opts.status } });
}

async function findByIdForAuth(id) {
  const pool = await getPool();
  const result = await pool.query('SELECT *, password_hash FROM users WHERE id = $1;', [id]);
  return result.rows[0] || null;
}

// --- Admin user management ---

async function listAll(opts = {}) {
  const pool = await getPool();
  const { role, status, search, ids, limit = 50, offset = 0 } = opts;
  let where = [];
  let params = [];
  let idx = 1;
  
  if (role) {
    const canonical = normalizeRole(role);
    // BUYER and its legacy spelling CUSTOMER are the same actor: a filter for
    // either has to return both until every stored row is migrated.
    if (canonical === ROLES.BUYER) {
      where.push(`role IN ('BUYER', 'CUSTOMER')`);
    } else {
      where.push(`role = $${idx++}`);
      params.push(canonical);
    }
  }
  if (status) { where.push(`status = $${idx++}`); params.push(status); }
  if (search) { 
    where.push(`(name ILIKE $${idx++} OR email ILIKE $${idx})`); 
    params.push(`%${search}%`);
    params.push(`%${search}%`);
    idx++;
  }
  // `ids` resolves a page of foreign keys to display names (the admin console
  // never shows a raw user id). Malformed ids are dropped here rather than
  // cast-failed: a single typo would otherwise turn a name lookup into a 500.
  if (ids) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const valid = (Array.isArray(ids) ? ids : String(ids).split(','))
      .map((value) => String(value || '').trim())
      .filter((value) => uuid.test(value));
    if (valid.length === 0) return { users: [], total: 0 };
    where.push(`id = ANY($${idx++}::uuid[])`);
    params.push(valid);
  }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
  const result = await pool.query(
    `SELECT ${USER_COLUMNS} FROM users ${whereClause} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++};`,
    [...params, limit, offset]
  );
  const countResult = await pool.query(`SELECT COUNT(*) as total FROM users ${whereClause};`, params);
  const rows = await attachMemberships(result.rows);
  return { users: rows.map(toUser), total: parseInt(countResult.rows[0].total) };
}

// Platform aggregates for the admin console. Counted in SQL (never by loading
// every row into memory) so the dashboard stays O(1) as the user table grows.
async function counts() {
  const pool = await getPool();

  const [byRole, byStatus, totals] = await Promise.all([
    pool.query('SELECT role, COUNT(*)::int AS total FROM users GROUP BY role;'),
    pool.query('SELECT status, COUNT(*)::int AS total FROM users GROUP BY status;'),
    pool.query('SELECT COUNT(*)::int AS total FROM users;'),
  ]);

  // Count under the canonical spelling so legacy CUSTOMER rows roll up into
  // BUYER instead of appearing as a second buyer population.
  const roleCounts = {};
  for (const row of byRole.rows) {
    const key = normalizeRole(row.role);
    roleCounts[key] = (roleCounts[key] || 0) + row.total;
  }

  const statusCounts = {};
  for (const row of byStatus.rows) statusCounts[row.status] = row.total;

  return {
    total: totals.rows[0].total,
    byRole: roleCounts,
    byStatus: statusCounts,
    admins: roleCounts.ADMIN || 0,
    sellers: roleCounts.SELLER || 0,
    buyers: roleCounts.BUYER || 0,
    // Legacy alias kept for existing dashboard consumers.
    customers: roleCounts.BUYER || 0,
    agents: roleCounts.AGENT || 0,
    active: statusCounts.active || 0,
    inactive: statusCounts.inactive || 0,
    suspended: statusCounts.suspended || 0,
    banned: statusCounts.banned || 0,
  };
}

// Seller onboarding pipeline, counted in SQL by seller_status.
//
// "Is a seller" now means "holds a SELLER membership" — membership STATUS is
// deliberately not filtered, so a suspended seller still appears in the pipeline
// (that is how an admin finds them to reactivate). Reading users.role here would
// miss every seller whose primary role is something else.
async function countSellersByStatus() {
  const pool = await getPool();
  const result = await pool.query(
    `SELECT COALESCE(u.seller_status, 'NONE') AS seller_status, COUNT(*)::int AS total
     FROM users u
     WHERE EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role = 'SELLER')
     GROUP BY u.seller_status;`
  );
  const out = {};
  let total = 0;
  for (const row of result.rows) {
    out[row.seller_status] = row.total;
    total += row.total;
  }
  return { total, byStatus: out };
}

async function setRole(id, role) {
  return updateFields({ id, fields: { role } });
}

/**
 * Set which actor role the account is currently acting as.
 * `null` clears the choice, meaning "use the primary role".
 */
async function setActiveRole(id, role) {
  return updateFields({ id, fields: { active_role: role || null } });
}

async function setStatus(id, status) {
  return updateFields({ id, fields: { status } });
}

async function setAdminScope(id, scope) {
  return updateFields({ id, fields: { admin_scope: scope } });
}

async function listSellers(opts = {}) {
  const pool = await getPool();
  const { status, search, limit = 20, offset = 0 } = opts;
  // Membership existence (any status) — see countSellersByStatus above.
  let where = ["EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = users.id AND ur.role = 'SELLER')"];
  let params = [];
  let idx = 1;
  
  if (status) { 
    where.push(`seller_status = $${idx++}`); 
    params.push(status); 
  }
  
  if (search) { 
    where.push(`(name ILIKE $${idx++} OR email ILIKE $${idx})`); 
    params.push(`%${search}%`);
    params.push(`%${search}%`);
    idx++;
  }
  
  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
  const result = await pool.query(
    `SELECT ${USER_COLUMNS} FROM users ${whereClause} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++};`,
    [...params, limit, offset]
  );
  const countResult = await pool.query(`SELECT COUNT(*) as total FROM users ${whereClause};`, params);
  const rows = await attachMemberships(result.rows);
  return {
    sellers: rows.map(toUser),
    total: parseInt(countResult.rows[0].total),
    page: Math.floor(offset / limit) + 1,
    limit 
  };
}

module.exports = {
  findByEmail,
  findByEmailInsensitive,
  findByEmailForLogin,
  findById,
  findByIdForAuth,
  create,
  updateFields,
  updatePassword,
  updateAvatar,
  setShopId,
  addAddress,
  removeAddress,
  setAddresses,
  setSellerStatus,
  listAll,
  counts,
  countSellersByStatus,
  setRole,
  setActiveRole,
  setStatus,
  setAdminScope,
  listSellers,
};
