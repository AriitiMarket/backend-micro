const express = require('express');
const router = express.Router();
const shopsController = require('../controllers/shops.controller');
const publicShopsController = require('../controllers/shops.public.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const { authorize } = require('../../../app/middleware/authorize');
const { requireActiveSeller } = require('../../../app/middleware/requireActiveSeller');
const { upload } = require('../../../app/config/upload');
const { validateCreateShop, validateUpdateShop } = require('../../../shared/validators/commerce.validators');

// ── Public routes (no auth) — MUST be registered before parameterized routes ──
router.get('/public/all', publicShopsController.getPublicAllShops);
router.get('/public/:id', publicShopsController.getPublicShopById);

// ── Seller routes ───────────────────────────────────────────────────────────
// Identity is established by the API Gateway (RS256 access token → x-user-*);
// there is no shop-scoped credential and no cookie session. `create-shop` is
// seller-only: the OWNER always comes from the verified token, and a first
// shop is created through the seller-application flow (admin approval there
// provisions the shop). `update-*` may name the target shop with `shopId`,
// which the service verifies belongs to the caller.
// `requireActiveSeller` runs on every seller WRITE here: Identity keeps
// `role = SELLER` when a business is suspended, so `authorize('SELLER')` alone
// would still let a deactivated business edit its shops. Reads stay open so the
// owner can still see what the suspension did.
router.post('/create-shop', authenticate, authorize('SELLER'), requireActiveSeller, upload.single('file'), validateCreateShop, shopsController.createShop);
router.get('/getseller', authenticate, shopsController.getSeller);
router.get('/get-shop-info/:id', authenticate, shopsController.getShopInfo);
router.get('/get-all-shops', authenticate, shopsController.getAllShops);
router.put('/update-shop-avatar', authenticate, authorize('SELLER'), requireActiveSeller, upload.single('image'), shopsController.updateShopAvatar);
router.put('/update-shop-info', authenticate, authorize('SELLER'), requireActiveSeller, validateUpdateShop, shopsController.updateShopInfo);

// ── Admin endpoints for shop management ────────────────────────────────────
// Authorization is enforced here (`authorize('ADMIN')`) and, before the proxy,
// by the gateway's `shops.view` / `shops.manage` permission table.
router.get('/admin/shops', authenticate, authorize('ADMIN'), shopsController.listShopsAdmin);
router.get('/admin/shops/pending', authenticate, authorize('ADMIN'), shopsController.listPendingShops);
router.get('/admin/shops/:id', authenticate, authorize('ADMIN'), shopsController.getShopAdmin);
router.post('/admin/shops/:id/approve', authenticate, authorize('ADMIN'), shopsController.approveShop);
router.post('/admin/shops/:id/reject', authenticate, authorize('ADMIN'), shopsController.rejectShop);
router.post('/admin/shops/:id/suspend', authenticate, authorize('ADMIN'), shopsController.suspendShop);
router.post('/admin/shops/:id/activate', authenticate, authorize('ADMIN'), shopsController.activateShop);
// Admin public-allow toggle (in-place switch on the Stores table).
router.patch('/admin/shops/:id/public', authenticate, authorize('ADMIN'), shopsController.setShopShowOnPublic);
// Admin delivery coverage (service areas) for a shop.
router.put('/admin/shops/:id/coverage', authenticate, authorize('ADMIN'), shopsController.setShopCoverage);

module.exports = router;
