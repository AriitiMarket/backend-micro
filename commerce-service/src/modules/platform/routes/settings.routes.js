const express = require('express');
const router = express.Router();
const controller = require('../controllers/settings.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const { authorize } = require('../../../app/middleware/authorize');

// Settings endpoints (admin only)
router.get('/settings/platform', authenticate, authorize('ADMIN'), controller.getPlatformSettings);
router.put('/settings/platform', authenticate, authorize('ADMIN'), controller.updatePlatformSettings);

router.get('/settings/notifications', authenticate, authorize('ADMIN'), controller.getNotificationSettings);
router.put('/settings/notifications', authenticate, authorize('ADMIN'), controller.updateNotificationSettings);

router.get('/settings/system', authenticate, authorize('ADMIN'), controller.getSystemSettings);
router.put('/settings/system', authenticate, authorize('ADMIN'), controller.updateSystemSettings);

module.exports = router;
