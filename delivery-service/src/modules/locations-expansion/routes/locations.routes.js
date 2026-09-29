const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/locations.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const authorize = require('../../../app/middleware/authorize');

router.get('/search', ctrl.searchLocations);
router.get('/hierarchy', ctrl.getHierarchy);
router.get('/', ctrl.getLocations);
router.post('/bulk', authenticate, authorize('ADMIN'), ctrl.bulkCreateLocations);
router.get('/types', ctrl.getTypeRules);
router.get('/stats', ctrl.getLocationStats);
router.get('/:id', ctrl.getLocation);
router.get('/:id/children', ctrl.getChildren);
router.get('/:id/ancestors', ctrl.getAncestors);
router.post('/', authenticate, authorize('ADMIN'), ctrl.createLocation);
router.put('/:id', authenticate, authorize('ADMIN'), ctrl.updateLocation);
router.put('/:id/activate', authenticate, authorize('ADMIN'), ctrl.activateLocation);
router.put('/:id/deactivate', authenticate, authorize('ADMIN'), ctrl.deactivateLocation);

module.exports = router;
