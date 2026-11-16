'use strict';

const express = require('express');
const router = express.Router();
const { verifyInternalRequest, loadCredentials } = require('@packages/internal-auth');

const credentials = loadCredentials(process.env);

/**
 * Strict internal service auth gate.
 * Enforces that all endpoints under /internal/delivery are accessible ONLY
 * by authenticated peer services (e.g. Commerce, Identity) or gateway cluster callers
 * carrying valid cluster credentials, never by regular user JWTs.
 */
function requireInternalServiceAuth(req, res, next) {
  const verdict = verifyInternalRequest(req, credentials);
  if (!verdict.ok) {
    return res.status(403).json({
      success: false,
      code: verdict.code,
      message: verdict.message || 'Forbidden: Valid internal service credentials required',
      errors: [],
    });
  }
  req.internalCaller = verdict.caller;
  return next();
}

router.use(requireInternalServiceAuth);

const ctrl = require('../controllers/internal.controller');
const requestsCtrl = require('../../delivery-fulfillment/controllers/delivery-request.controller');
const deliveriesCtrl = require('../../delivery-fulfillment/controllers/delivery-fulfillment.controller');
const locationsCtrl = require('../../locations-expansion/controllers/locations.controller');
const zonesCtrl = require('../../locations-expansion/controllers/zones.controller');

router.get('/operations/dashboard', ctrl.getOperationsDashboard);
router.get('/deliveries', ctrl.listDeliveries);
router.post('/deliveries/by-orders', ctrl.getDeliveriesForOrders);
router.get('/locations-expansion/counts', ctrl.getLocationCounts);
router.get('/locations/counts', ctrl.getLocationCounts);

// ── Service-to-service reads: single delivery + its status history ───────────
router.get('/deliveries/order/:orderId', deliveriesCtrl.getDeliveryByOrderId);
router.get('/deliveries/:id/history', deliveriesCtrl.getDeliveryHistory);

// ── Service-to-service reads: the geographic location tree ───────────────────
router.get('/location/hierarchy', locationsCtrl.getHierarchy);
router.get('/location/search', locationsCtrl.searchLocations);
router.get('/location/types', locationsCtrl.getTypeRules);
router.get('/location/stats', locationsCtrl.getLocationStats);
router.get('/location', locationsCtrl.getLocations);
router.get('/location/:id/children', locationsCtrl.getChildren);
router.get('/location/:id/ancestors', locationsCtrl.getAncestors);
router.get('/location/:id', locationsCtrl.getLocation);

// ── Service-to-service reads: zone catalogue ────────────────────────────────
router.get('/zone/location/:locationId', zonesCtrl.findZoneForLocation);
router.get('/zone/fee-quote', zonesCtrl.quoteDeliveryFee);
router.get('/zone', zonesCtrl.getZoneSummariesInternal);
router.get('/zone/:id', zonesCtrl.getZoneSummaryInternal);

// ── Service-to-service: Commerce hands an order to the Delivery Service ─────
router.post('/request', requestsCtrl.createRequest);

module.exports = router;
