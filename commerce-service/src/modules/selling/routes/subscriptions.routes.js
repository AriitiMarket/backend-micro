const router = require('express').Router();
const subscriptionsController = require('../controllers/subscriptions.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const { authorize } = require('../../../app/middleware/authorize');

// Subscriptions are a seller's plan for their store. Reads and writes both
// require the seller role (admins may act too); the controller then scopes the
// row to the caller's own store.
router.post('/', authenticate, authorize(['SELLER', 'ADMIN']), subscriptionsController.create);
router.get('/store/:storeId', authenticate, authorize(['SELLER', 'ADMIN']), subscriptionsController.getByStore);
router.put('/:id', authenticate, authorize(['SELLER', 'ADMIN']), subscriptionsController.update);

module.exports = router;
