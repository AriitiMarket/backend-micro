const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/shipments.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const authorize = require('../../../app/middleware/authorize');

router.use(authenticate, authorize('ADMIN'));

// Mounted at /delivery/shipments — every path below is relative to that prefix,
// so the URLs match what the admin console calls:
//   GET    /delivery/shipments
//   GET    /delivery/shipments/consolidation/candidates
//   POST   /delivery/shipments                       (create via consolidation)
//   GET    /delivery/shipments/:id
//   POST   /delivery/shipments/:id/{dispatch,arrive,receive}
router.get('/consolidation/candidates', ctrl.getCandidates);
router.post('/', ctrl.createConsolidation);
router.post('/:id/consolidate', ctrl.createConsolidation);
router.get('/', ctrl.getShipments);
router.get('/:id', ctrl.getShipment);

router.post('/:id/dispatch', (req, res, next) => { req.params.action = 'dispatch'; next(); }, ctrl.transitionStatus);
router.post('/:id/arrive', (req, res, next) => { req.params.action = 'arrive'; next(); }, ctrl.transitionStatus);
router.post('/:id/receive', (req, res, next) => { req.params.action = 'receive'; next(); }, ctrl.transitionStatus);

module.exports = router;
