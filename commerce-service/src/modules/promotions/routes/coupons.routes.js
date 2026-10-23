const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/coupons.controller');

// Public lookup - used by admin promotions list and buyer checkout
router.get('/get-coupon-value/:name', ctrl.getCouponValue);
router.get('/get-coupon/:id', ctrl.getCouponById);
router.post('/create-coupon-code', ctrl.createCoupon);
router.delete('/delete-coupon/:id', ctrl.deleteCoupon);

module.exports = router;
