// Audit logs controller — querying and retrieval of audit records.
const auditRepository = require('../repositories/audit.repository');
const { ok } = require('../utils/response');

async function listLogs(req, res, next) {
  try {
    const { adminId, action, module, targetEntity, targetId, startDate, endDate, search, page = 1, limit = 20 } = req.query;
    const result = await auditRepository.list({
      adminId, action, module, targetEntity, targetId, startDate, endDate, search,
      page: parseInt(page), limit: parseInt(limit),
    });
    return ok(res, result);
  } catch (err) { return next(err); }
}

// Non-UUID ids would otherwise surface as pg 22P02 → 500 instead of 404.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getLog(req, res, next) {
  try {
    if (!UUID_RE.test(String(req.params.id || ''))) {
      return next(Object.assign(new Error('Audit log not found'), { statusCode: 404 }));
    }
    const log = await auditRepository.findById(req.params.id);
    if (!log) return next(Object.assign(new Error('Audit log not found'), { statusCode: 404 }));
    return ok(res, { log });
  } catch (err) { return next(err); }
}

async function getFilterOptions(req, res, next) {
  try {
    const [admins, actions, modules] = await Promise.all([
      auditRepository.getDistinctAdmins(),
      auditRepository.getDistinctActions(),
      auditRepository.getDistinctModules(),
    ]);
    return ok(res, { admins, actions, modules });
  } catch (err) { return next(err); }
}

async function getStats(req, res, next) {
  try {
    const stats = await auditRepository.getStats();
    return ok(res, { stats });
  } catch (err) { return next(err); }
}

// ── Purging audit logs ──────────────────────────────────────────────────────
// Deleting audit rows destroys the evidence trail, so the operation is
// deliberately awkward to perform by accident:
//   1. a non-empty reason is mandatory (it is stored with the purge record),
//   2. the client must explicitly confirm,
//   3. the scope can be narrowed to a date range / action / module, and the
//      exact affected count is returned BEFORE anything is deleted,
//   4. the purge itself is written back as a CRITICAL audit entry AFTER the
//      delete, so the act of wiping the log is permanently attributable even
//      though everything it removed is gone.

const MIN_REASON_LENGTH = 10;
const CONFIRM_PHRASE = 'DELETE AUDIT LOGS';

/** Preview how many logs a given purge scope would remove. */
async function previewPurge(req, res, next) {
  try {
    const scope = purgeScopeFrom(req.query);
    const total = await auditRepository.count(scope);
    return ok(res, { total });
  } catch (err) { return next(err); }
}

function purgeScopeFrom(input = {}) {
  return {
    action: input.action || undefined,
    module: input.module || undefined,
    level: input.level || undefined,
    startDate: input.startDate || undefined,
    endDate: input.endDate || undefined,
  };
}

async function purgeLogs(req, res, next) {
  try {
    const { reason, confirm } = req.body || {};

    if (!reason || String(reason).trim().length < MIN_REASON_LENGTH) {
      throw Object.assign(
        new Error(`A reason of at least ${MIN_REASON_LENGTH} characters is required to clear audit logs`),
        { statusCode: 400 }
      );
    }
    if (confirm !== CONFIRM_PHRASE) {
      throw Object.assign(
        new Error(`Type "${CONFIRM_PHRASE}" to confirm this destructive action`),
        { statusCode: 400 }
      );
    }

    const scope = purgeScopeFrom(req.body);
    const before = await auditRepository.count(scope);
    if (before === 0) {
      return ok(res, { deleted: 0, byLevel: {}, total: 0 }, 'No audit logs matched the given scope');
    }

    const { deleted, byLevel } = await auditRepository.purge(scope);

    // Written AFTER the delete so this record survives the purge it describes.
    const adminId = req.user?.id || null;
    const adminName = req.user?.name || req.user?.email || null;
    await auditRepository.create({
      action: 'AUDIT_LOGS_PURGED',
      level: 'CRITICAL',
      adminId,
      adminName,
      module: 'audit',
      targetEntity: 'audit_log',
      reason: String(reason).trim(),
      details: { deleted, byLevel, scope },
      ipAddress: req.ip || req.headers?.['x-forwarded-for'] || null,
      userAgent: req.headers?.['user-agent'] || null,
    });

    return ok(
      res,
      { deleted, byLevel, total: before },
      `Cleared ${deleted} audit log${deleted === 1 ? '' : 's'}`
    );
  } catch (err) { return next(err); }
}

module.exports = { listLogs, getLog, getFilterOptions, getStats, previewPurge, purgeLogs };
