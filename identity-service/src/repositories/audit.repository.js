// Audit log repository — only layer that queries the audit_logs table.
const { getPool } = require('../config/database');

const LOG_COLUMNS = 'id, timestamp, action, level, admin_id, admin_name, module, target_entity, target_id, previous_value, new_value, reason, details, ip_address, user_agent, created_at';

/**
 * Maps a snake_case audit_logs row onto the camelCase shape the admin UI reads
 * (adminName, targetEntity, ipAddress, …). Spreading the raw row left those
 * keys undefined, so every row rendered Admin as "System" and Target as "-".
 */
function toAuditLog(row) {
  if (!row) return null;
  return {
    id: row.id,
    timestamp: row.timestamp,
    action: row.action,
    level: row.level,
    adminId: row.admin_id,
    adminName: row.admin_name,
    module: row.module,
    targetEntity: row.target_entity,
    targetId: row.target_id,
    previousValue: row.previous_value || null,
    newValue: row.new_value || null,
    reason: row.reason,
    details: row.details || {},
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    createdAt: row.created_at,
  };
}

async function create(opts) {
  const pool = await getPool();
  const {
    action,
    level = 'INFO',
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

  const result = await pool.query(
    `INSERT INTO audit_logs (action, level, admin_id, admin_name, module, target_entity, target_id, previous_value, new_value, reason, details, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING ${LOG_COLUMNS};`,
    [action, level, adminId, adminName, module, targetEntity, targetId,
     previousValue ? JSON.stringify(previousValue) : null,
     newValue ? JSON.stringify(newValue) : null,
     reason, JSON.stringify(details), ipAddress, userAgent]
  );
  return result.rows[0];
}

/**
 * Builds the shared WHERE clause used by BOTH `list` and `purge`.
 *
 * Sharing it matters: if purge filtered differently from the list the admin was
 * just shown, "clear these 42 logs" could delete a different set entirely.
 */
function buildWhere(opts = {}) {
  const {
    adminId, action, module, targetEntity, targetId,
    startDate, endDate, search, level,
  } = opts;

  const where = [];
  const params = [];
  let idx = 1;

  if (adminId) { where.push(`admin_id = $${idx++}`); params.push(adminId); }
  if (action) { where.push(`action = $${idx++}`); params.push(action); }
  if (module) { where.push(`module = $${idx++}`); params.push(module); }
  if (targetEntity) { where.push(`target_entity = $${idx++}`); params.push(targetEntity); }
  if (targetId) { where.push(`target_id = $${idx++}`); params.push(targetId); }
  if (level) { where.push(`level = $${idx++}`); params.push(level); }
  if (startDate) { where.push(`timestamp >= $${idx++}`); params.push(startDate); }
  if (endDate) {
    // A bare date from <input type="date"> is midnight; without covering the
    // whole end day, "To = today" always returns an empty list.
    const end = /^\d{4}-\d{2}-\d{2}$/.test(String(endDate)) ? `${endDate}T23:59:59.999Z` : endDate;
    where.push(`timestamp <= $${idx++}`);
    params.push(end);
  }
  if (search) {
    where.push(`(admin_name ILIKE $${idx} OR target_id ILIKE $${idx} OR reason ILIKE $${idx} OR action ILIKE $${idx})`);
    params.push(`%${search}%`);
    idx++;
  }

  return { where, params, nextIndex: idx };
}

async function count(opts = {}) {
  const pool = await getPool();
  const { where, params } = buildWhere(opts);
  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
  const result = await pool.query(`SELECT COUNT(*) as total FROM audit_logs ${whereClause};`, params);
  return parseInt(result.rows[0].total, 10);
}

/**
 * Deletes audit rows matching the same filter shape as `list`.
 *
 * Returns the deleted rows' levels so the caller can report how many CRITICAL
 * entries were destroyed. The caller is responsible for writing a fresh
 * CRITICAL record of the purge itself — see audit.controller.purgeLogs.
 */
async function purge(opts = {}) {
  const pool = await getPool();
  const { where, params } = buildWhere(opts);
  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
  const result = await pool.query(
    `DELETE FROM audit_logs ${whereClause} RETURNING level;`,
    params
  );
  const byLevel = result.rows.reduce((acc, r) => {
    acc[r.level] = (acc[r.level] || 0) + 1;
    return acc;
  }, {});
  return { deleted: result.rows.length, byLevel };
}

async function list(opts = {}) {
  const pool = await getPool();
  const { page = 1, limit = 20 } = opts;
  const { where, params, nextIndex } = buildWhere(opts);
  let idx = nextIndex;

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const result = await pool.query(
    `SELECT ${LOG_COLUMNS} FROM audit_logs ${whereClause} ORDER BY timestamp DESC LIMIT $${idx++} OFFSET $${idx++};`,
    [...params, parseInt(limit), offset]
  );
  const countResult = await pool.query(`SELECT COUNT(*) as total FROM audit_logs ${whereClause};`, params);

  return {
    logs: result.rows.map(toAuditLog),
    total: parseInt(countResult.rows[0].total),
    page: parseInt(page),
    limit: parseInt(limit),
    totalPages: Math.max(1, Math.ceil(parseInt(countResult.rows[0].total) / parseInt(limit))),
  };
}

async function findById(id) {
  const pool = await getPool();
  const result = await pool.query(`SELECT ${LOG_COLUMNS} FROM audit_logs WHERE id = $1;`, [id]);
  if (!result.rows[0]) return null;
  return toAuditLog(result.rows[0]);
}

async function getDistinctAdmins() {
  const pool = await getPool();
  const result = await pool.query(
    `SELECT DISTINCT admin_id, admin_name FROM audit_logs WHERE admin_id IS NOT NULL ORDER BY admin_name;`
  );
  return result.rows;
}

async function getDistinctActions() {
  const pool = await getPool();
  const result = await pool.query(
    `SELECT DISTINCT action FROM audit_logs ORDER BY action;`
  );
  return result.rows.map(r => r.action);
}

async function getDistinctModules() {
  const pool = await getPool();
  const result = await pool.query(
    `SELECT DISTINCT module FROM audit_logs WHERE module IS NOT NULL ORDER BY module;`
  );
  return result.rows.map(r => r.module);
}

async function getStats() {
  const pool = await getPool();
  const totalResult = await pool.query('SELECT COUNT(*) as total FROM audit_logs;');
  const todayResult = await pool.query(
    "SELECT COUNT(*) as count FROM audit_logs WHERE timestamp >= NOW() - INTERVAL '24 hours';"
  );
  const criticalResult = await pool.query(
    "SELECT COUNT(*) as count FROM audit_logs WHERE level = 'CRITICAL' AND timestamp >= NOW() - INTERVAL '7 days';"
  );
  const moduleStats = await pool.query(
    `SELECT module, COUNT(*) as count FROM audit_logs WHERE module IS NOT NULL GROUP BY module ORDER BY count DESC;`
  );

  return {
    total: parseInt(totalResult.rows[0].total),
    today: parseInt(todayResult.rows[0].count),
    criticalLast7Days: parseInt(criticalResult.rows[0].count),
    byModule: moduleStats.rows,
  };
}

module.exports = {
  create,
  list,
  count,
  purge,
  findById,
  getDistinctAdmins,
  getDistinctActions,
  getDistinctModules,
  getStats,
  toAuditLog,
};
