const promotionRepository = require('../repositories/promotions.repository');
const Promotion = require('../models/Promotions');
const { ok, created } = require('../../../shared/utils/response');

class ApiError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function formatCoupon(p) {
  if (!p) return null;
  const doc = typeof p.toObject === 'function' ? p.toObject() : p;
  const name = doc.code || doc.title || 'COUPON';
  const val = doc.discountPercent ?? doc.fixedAmount ?? 0;
  return {
    ...doc,
    _id: String(doc._id),
    id: String(doc._id),
    name,
    code: doc.code || name,
    title: doc.title || name,
    value: val,
    minAmount: doc.minPurchaseAmount ?? 0,
    maxAmount: doc.maxDiscountAmount ?? 0,
    startDate: doc.startsAt ? new Date(doc.startsAt).toISOString() : null,
    endDate: doc.endsAt ? new Date(doc.endsAt).toISOString() : null,
    usageCount: doc.usedCount ?? 0,
    maxUsage: doc.totalUsageLimit ?? null,
  };
}

/**
 * GET /coupon/get-coupon-value/:name
 * Handles both:
 *  - /coupon/get-coupon-value/all?page=1&limit=20
 *  - /coupon/get-coupon-value/:code (lookup specific promo code or name)
 */
async function getCouponValue(req, res, next) {
  try {
    const { name } = req.params;
    const { page = 1, limit = 50, search, shopId } = req.query;

    if (!name || name === 'all') {
      const filter = {};
      if (shopId) filter.shopId = shopId;
      if (search) {
        const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filter.$or = [{ code: rx }, { title: rx }, { description: rx }];
      }

      const safePage = Math.max(parseInt(page, 10) || 1, 1);
      const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
      const skip = (safePage - 1) * safeLimit;

      const [promos, total] = await Promise.all([
        Promotion.find(filter).sort({ createdAt: -1 }).skip(skip).limit(safeLimit),
        Promotion.countDocuments(filter),
      ]);

      const coupons = promos.map(formatCoupon);
      return ok(res, {
        coupons,
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit) || 0,
      });
    }

    // Lookup specific code/name
    const rx = new RegExp('^' + String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
    let promo = await Promotion.findOne({ $or: [{ code: rx }, { title: rx }] });

    if (!promo && Promotion.isValidObjectId && Promotion.isValidObjectId(name)) {
      promo = await Promotion.findById(name);
    }

    if (!promo) {
      return ok(res, {
        couponCode: null,
        coupons: [],
        total: 0,
        message: `Coupon "${name}" not found`,
      });
    }

    const formatted = formatCoupon(promo);
    return ok(res, {
      couponCode: formatted,
      coupons: [formatted],
      total: 1,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /coupon/get-coupon/:id
 */
async function getCouponById(req, res, next) {
  try {
    const { id } = req.params;
    const promo = await promotionRepository.findById(id);
    if (!promo) throw new ApiError('Coupon not found', 404);
    const formatted = formatCoupon(promo);
    return ok(res, { couponCode: formatted, couponCodes: [formatted] });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /coupon/create-coupon-code
 */
async function createCoupon(req, res, next) {
  try {
    const {
      name,
      code,
      value,
      discountType = 'PERCENTAGE',
      minAmount,
      maxAmount,
      startDate,
      endDate,
      maxUsage,
      shopId,
      selectedProduct,
    } = req.body;

    const couponCode = (code || name || '').toUpperCase().trim();
    if (!couponCode) throw new ApiError('Coupon name or code is required', 400);

    const callerShopId = shopId || req.headers['x-shop-id'] || 'platform';
    const isPlatformWide = !shopId || callerShopId === 'platform';

    const isFixed = discountType === 'FIXED_AMOUNT';
    const promo = await Promotion.create({
      title: name || couponCode,
      code: couponCode,
      discountType: isFixed ? 'FIXED_AMOUNT' : 'PERCENTAGE',
      discountPercent: isFixed ? null : (Number(value) || 0),
      fixedAmount: isFixed ? (Number(value) || 0) : null,
      minPurchaseAmount: Number(minAmount) || 0,
      maxDiscountAmount: maxAmount ? Number(maxAmount) : null,
      startsAt: startDate ? new Date(startDate) : new Date(),
      endsAt: endDate ? new Date(endDate) : null,
      totalUsageLimit: maxUsage ? Number(maxUsage) : null,
      shopId: callerShopId,
      isPlatformWide,
      eligibleProductIds: selectedProduct ? [String(selectedProduct)] : [],
      status: 'active',
      showOnPublic: true,
      createdBy: req.headers['x-user-id'] || null,
    });

    const formatted = formatCoupon(promo);
    return created(res, { couponCode: formatted, coupon: formatted }, 'Coupon created');
  } catch (err) {
    return next(err);
  }
}

/**
 * DELETE /coupon/delete-coupon/:id
 */
async function deleteCoupon(req, res, next) {
  try {
    const { id } = req.params;
    const promo = await promotionRepository.findById(id);
    if (!promo) throw new ApiError('Coupon not found', 404);
    await Promotion.findByIdAndDelete(id);
    return ok(res, { message: 'Coupon deleted successfully' });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getCouponValue,
  getCouponById,
  createCoupon,
  deleteCoupon,
};
