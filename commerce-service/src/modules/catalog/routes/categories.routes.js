const express = require('express');
const router = express.Router();
const categoriesController = require('../controllers/categories.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const { authorize } = require('../../../app/middleware/authorize');

// Public: read active categories by type
router.get('/active/:type', categoriesController.getActiveCategoriesByType);

// Public: read all (admin filters via query params)
router.get('/', categoriesController.getAllCategories);
router.get('/:id', categoriesController.getCategory);

// Protected: write (ADMIN only)
router.post('/', authenticate, authorize('ADMIN'), categoriesController.createCategory);
router.put('/:id', authenticate, authorize('ADMIN'), categoriesController.updateCategory);
router.patch('/:id/status', authenticate, authorize('ADMIN'), categoriesController.toggleCategoryStatus);
router.delete('/:id', authenticate, authorize('ADMIN'), categoriesController.deleteCategory);

module.exports = router;
