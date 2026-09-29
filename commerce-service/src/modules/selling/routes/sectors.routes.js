const router = require('express').Router();
const sectorsController = require('../controllers/sectors.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const { authorize } = require('../../../app/middleware/authorize');

// Sectors are the platform's classification taxonomy: reads are public (they
// label the catalog), writes are admin-only. Previously the mutations only
// required a token, so any authenticated buyer could rewrite them.
router.post('/', authenticate, authorize('ADMIN'), sectorsController.create);
router.get('/', sectorsController.getAll);
router.get('/:id', sectorsController.getById);
router.put('/:id', authenticate, authorize('ADMIN'), sectorsController.update);
router.delete('/:id', authenticate, authorize('ADMIN'), sectorsController.remove);

module.exports = router;
