const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/hubs.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const authorize = require('../../../app/middleware/authorize');

// Physical/logistical hubs, surfaced in the Locations & Expansion workspace.
router.get('/stats', authenticate, authorize('ADMIN'), ctrl.getHubStats);
router.get('/', authenticate, authorize('ADMIN'), ctrl.getHubs);
router.get('/:id', authenticate, authorize('ADMIN'), ctrl.getHub);
router.post('/', authenticate, authorize('ADMIN'), ctrl.createHub);
router.put('/:id', authenticate, authorize('ADMIN'), ctrl.updateHub);
router.put('/:id/status', authenticate, authorize('ADMIN'), ctrl.setHubStatus);

module.exports = router;