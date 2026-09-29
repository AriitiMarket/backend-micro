const express = require('express');
const router = express.Router();
const auditController = require('../controllers/audit.controller');
const auditRepository = require('../repositories/audit.repository');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const requirePermission = require('../middleware/requirePermission');
const internalOnly = require('../middleware/internalOnly');
const { created } = require('../utils/response');

// Audit log endpoints (admin only)
router.get('/admin/audit-logs', authenticate, authorize('ADMIN'), requirePermission('audit.view'), auditController.listLogs);
router.get('/admin/audit-logs/stats', authenticate, authorize('ADMIN'), requirePermission('audit.view'), auditController.getStats);
router.get('/admin/audit-logs/filters', authenticate, authorize('ADMIN'), requirePermission('audit.view'), auditController.getFilterOptions);
router.get('/admin/audit-logs/purge-preview', authenticate, authorize('ADMIN'), requirePermission('audit.manage'), auditController.previewPurge);
router.get('/admin/audit-logs/:id', authenticate, authorize('ADMIN'), requirePermission('audit.view'), auditController.getLog);

// Purging is intentionally NOT covered by `audit.view`: reading the log must
// never imply the ability to erase it. It needs its own `audit.manage` grant.
router.delete('/admin/audit-logs', authenticate, authorize('ADMIN'), requirePermission('audit.manage'), auditController.purgeLogs);

// Internal ingestion endpoint — other backend services POST audit entries here.
// Guarded by the dedicated internal service token (X-Internal-Token).
router.post('/internal/audit-log', internalOnly, async (req, res, next) => {
  try {
    const log = await auditRepository.create(req.body);
    return created(res, { log }, 'Audit log created');
  } catch (err) { return next(err); }
});

module.exports = router;
