const router = require('express').Router();
const { authenticate } = require('../../../app/middleware/authenticate');
const authorize = require('../../../app/middleware/authorize');
const ctrl = require('../controllers/routes.controller');

router.get('/stats', authenticate, authorize('ADMIN'), ctrl.getRouteStats);
router.get('/', authenticate, authorize('ADMIN'), ctrl.getRoutes);
router.get('/:id', authenticate, authorize('ADMIN'), ctrl.getRoute);
router.post('/', authenticate, authorize('ADMIN'), ctrl.createRoute);
router.put('/:id', authenticate, authorize('ADMIN'), ctrl.updateRoute);
router.delete('/:id', authenticate, authorize('ADMIN'), ctrl.deleteRoute);

module.exports = router;
