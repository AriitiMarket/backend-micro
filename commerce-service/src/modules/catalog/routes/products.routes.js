const express = require('express');
const router = express.Router();
const productsController = require('../controllers/products.controller');
const publicProductsController = require('../controllers/products.public.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const { authorize } = require('../../../app/middleware/authorize');
const { upload } = require('../../../app/config/upload');
const { validateCreateProduct, validateUpdateProduct } = require('../../../shared/validators/commerce.validators');

// ── Public routes (no auth) — MUST be registered before parameterized routes ──
router.get('/public/all', publicProductsController.getPublicAllProducts);
router.get('/public/:id', publicProductsController.getPublicProductById);

// ── Authenticated routes ──
// ADMIN is listed alongside SELLER on every management route: the service's
// assertOwnership already admits admins, and archive/unarchive already did —
// leaving ADMIN off these seven produced dead admin branches and 403s.
router.post('/create-product', authenticate, authorize(['SELLER', 'ADMIN']), upload.array('productImg'), validateCreateProduct, productsController.createProduct);
router.get('/get-all-products-shop/:id', productsController.getShopProducts);
router.get('/get-all-products', authenticate, productsController.getAllProducts);

// Admin bulk visibility action. Declared before the '/:param' style routes so
// 'bulk' can never be read as an identifier.
router.post('/bulk', authenticate, authorize('ADMIN'), productsController.bulkProductAction);

router.get('/get-product/:id', authenticate, productsController.getProduct);
router.get('/search', productsController.searchProducts);
router.put('/update-product/:id', authenticate, authorize(['SELLER', 'ADMIN']), upload.array('productImg'), validateUpdateProduct, productsController.updateProduct);
router.delete('/delete-shop-product/:id', authenticate, authorize(['SELLER', 'ADMIN']), productsController.deleteProduct);
router.put('/create-new-review', authenticate, productsController.createReview);

// ── Lifecycle: the APPROVED seller publishes/drafts their own products
//    (no admin approval step). Admin activate/deactivate is POST /bulk above.
router.post('/publish/:id', authenticate, authorize(['SELLER', 'ADMIN']), productsController.publishProduct);
router.post('/draft/:id', authenticate, authorize(['SELLER', 'ADMIN']), productsController.draftProduct);

// Archiving (reversible) is the seller's alternative to deleting: ownership is
// re-checked in the service, which also admits an ADMIN caller.
router.post('/archive/:id', authenticate, authorize(['SELLER', 'ADMIN']), productsController.archiveProduct);
router.post('/unarchive/:id', authenticate, authorize(['SELLER', 'ADMIN']), productsController.unarchiveProduct);

router.post('/restock/:id', authenticate, authorize(['SELLER', 'ADMIN']), productsController.restockProduct);
router.put('/adjust-stock/:id', authenticate, authorize(['SELLER', 'ADMIN']), productsController.adjustStock);
router.get('/stock-history/:id', authenticate, authorize(['SELLER', 'ADMIN']), productsController.getStockHistory);

module.exports = router;
