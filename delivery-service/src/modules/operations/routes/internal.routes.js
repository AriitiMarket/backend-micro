const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/internal.controller');
const requestsCtrl = require('../../delivery-fulfillment/controllers/delivery-request.controller');
const deliveriesCtrl = require('../../delivery-fulfillment/controllers/delivery-fulfillment.controller');
const locationsCtrl = require('../../locations-expansion/controllers/locations.controller');

router.get('/operations/dashboard', ctrl.getOperationsDashboard);
router.get('/deliveries', ctrl.listDeliveries);
router.post('/deliveries/by-orders', ctrl.getDeliveriesForOrders);
router.get('/locations-expansion/counts', ctrl.getLocationCounts);
// Alias: Commerce has always called `/locations/counts`, while this router only
// exposed `/locations-expansion/counts`, so the admin dashboard's location
// counter silently 404'd. Both spellings now resolve to the same handler.
router.get('/locations/counts', ctrl.getLocationCounts);

// ── Service-to-service reads: single delivery + its status history ───────────
// Commerce's admin order views need the delivery record and its transition
// history for one order at a time. The public equivalents
// (`/delivery/delivery/order/:orderId`, `/delivery/delivery/:id/history`) are
// guarded by `authenticate`, and an internal call deliberately carries NO user
// identity, so a service call could never succeed against them. These internal
// reads are the supported path.
router.get('/deliveries/order/:orderId', deliveriesCtrl.getDeliveryByOrderId);
router.get('/deliveries/:id/history', deliveriesCtrl.getDeliveryHistory);

// ── Service-to-service reads: the geographic location tree ───────────────────
// Commerce caches and resolves the whole location hierarchy, so it needs these
// reads on the internal surface. They mirror the public read-only handlers
// exactly (no writes are exposed here: location mutations are admin actions that
// require a real actor identity, which a service call deliberately does not
// carry). Peer services are refused on the public routes by gatewayOnly, so
// these are the supported path rather than a duplicate of one.
//
// Specific paths first: `/location/:id` must not swallow `/location/hierarchy`.
router.get('/location/hierarchy', locationsCtrl.getHierarchy);
router.get('/location/search', locationsCtrl.searchLocations);
router.get('/location/types', locationsCtrl.getTypeRules);
router.get('/location/stats', locationsCtrl.getLocationStats);
router.get('/location', locationsCtrl.getLocations);
router.get('/location/:id/children', locationsCtrl.getChildren);
router.get('/location/:id/ancestors', locationsCtrl.getAncestors);
router.get('/location/:id', locationsCtrl.getLocation);

// ── Service-to-service reads: zone catalogue ────────────────────────────────
// Commerce validates the buyer's delivery zone at checkout and validates the
// zone ids an admin writes into a shop's service areas. The public equivalents
// are either admin-gated (`/delivery/zone/:id`) or user-facing, so a peer
// service is refused on them by gatewayOnly — these internal mirrors are the
// supported path (reads only; zone mutations stay admin actions that require a
// real actor identity, which a service call deliberately does not carry).
const zonesCtrl = require('../../locations-expansion/controllers/zones.controller');
router.get('/zone/location/:locationId', zonesCtrl.findZoneForLocation);
router.get('/zone', zonesCtrl.getZoneSummariesInternal);
router.get('/zone/:id', zonesCtrl.getZoneSummaryInternal);

// ── Service-to-service: Commerce hands an order to the Delivery Service ─────
// `POST /internal/delivery/request`. No `authenticate` on purpose: this router
// only ever receives traffic from the gateway's INTERNAL surface or from a named
// peer service, both gated by the cluster credential (gatewayOnly). Request
// creation is intentionally absent from the public route: only Commerce may
// bind a marketplace order and its parties to delivery.
router.post('/request', requestsCtrl.createRequest);

module.exports = router;
