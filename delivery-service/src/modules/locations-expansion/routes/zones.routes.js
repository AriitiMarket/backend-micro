const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/zones.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const authorize = require('../../../app/middleware/authorize');

// Specific paths first: `/public` and `/location/:locationId` must not be
// swallowed by `/:id`.
//
// `/public` is the anonymous marketplace selector's read (minimal projection of
// active zones); Delivery serves it without an identity on purpose. The gateway
// mirrors that posture with a method-restricted public-read rule.
router.get('/public', ctrl.getPublicZones);
router.get('/fee-quote', ctrl.quoteDeliveryFee);
router.get('/fee-settings', authenticate, authorize('ADMIN'), ctrl.getDeliveryFeeSettings);
router.put('/fee-settings', authenticate, authorize('ADMIN'), ctrl.updateDeliveryFeeSettings);
router.get('/coverage/:locationId', ctrl.checkCoverage);
router.get('/location/:locationId', ctrl.findZoneForLocation);
router.get('/stats', authenticate, authorize('ADMIN'), ctrl.getZoneStats);
router.get('/', authenticate, authorize('ADMIN'), ctrl.getZones);
router.get('/:id', authenticate, authorize('ADMIN'), ctrl.getZone);
router.post('/', authenticate, authorize('ADMIN'), ctrl.createZone);
router.put('/:id', authenticate, authorize('ADMIN'), ctrl.updateZone);
router.delete('/:id', authenticate, authorize('ADMIN'), ctrl.deleteZone);
router.put('/:id/activate', authenticate, authorize('ADMIN'), ctrl.activateZone);
router.put('/:id/deactivate', authenticate, authorize('ADMIN'), ctrl.deactivateZone);
router.post('/:id/locations', authenticate, authorize('ADMIN'), ctrl.addLocationToZone);
router.delete('/:id/locations/:locationId', authenticate, authorize('ADMIN'), ctrl.removeLocationFromZone);

module.exports = router;
