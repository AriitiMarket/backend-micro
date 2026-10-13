const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/ports.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const authorize = require('../../../app/middleware/authorize');

// Physical/logistical ports, surfaced in the Locations & Expansion workspace.
router.get('/stats', authenticate, authorize('ADMIN'), ctrl.getPortStats);
router.get('/', authenticate, authorize('ADMIN'), ctrl.getPorts);
router.get('/:id', authenticate, authorize('ADMIN'), ctrl.getPort);
router.post('/', authenticate, authorize('ADMIN'), ctrl.createPort);
router.put('/:id', authenticate, authorize('ADMIN'), ctrl.updatePort);
router.put('/:id/status', authenticate, authorize('ADMIN'), ctrl.setPortStatus);

module.exports = router;