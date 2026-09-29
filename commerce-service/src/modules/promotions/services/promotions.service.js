const promotionRepository = require('../repositories/promotions.repository');
const shopRepository = require('../../selling/repositories/shops.repository');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

const isAdmin = (role) => role === 'ADMIN';

/**
 * Publicly visible = listed by the owner, still active, and inside its window.
 *
 * The window is evaluated on read rather than trusted from `status`, so a
 * promotion stops being advertised the moment `endsAt` passes even if nobody
 * updated the document.
 */
function isLive(promotion) {
  if (!promotion) return false;
  if (promotion.showOnPublic !== true) return false;
  if (promotion.status !== 'active') return false;
  const now = Date.now();
  if (promotion.startsAt && new Date(promotion.startsAt).getTime() > now) return false;
  if (promotion.endsAt && new Date(promotion.endsAt).getTime() < now) return false;
  return true;
}

function normalizePercent(value) {
  if (value === undefined || value === null || value === '') return null;
  const percent = Number(value);
  if (Number.isNaN(percent) || percent < 0 || percent > 100) {
    throw new ApiError('discountPercent must be a number between 0 and 100', 400);
  }
  return percent;
}

function normalizeDate(value, field) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ApiError(`${field} must be a valid date`, 400);
  return date;
}

class PromotionsService {
  /**
   * Live, publicly visible promotions. Guests and buyers use this.
   * @param {{ shopId?: string }} options
   */
  async listPublic({ shopId } = {}) {
    const filter = { showOnPublic: true, status: 'active' };
    if (shopId) filter.shopId = shopId;
    const promotions = await promotionRepository.find({ filter });
    return promotions.filter(isLive);
  }

  /** True when `userId` owns the shop. Never throws — used to pick a view. */
  async ownsShop(shopId, userId) {
    if (!shopId || !userId) return false;
    const shops = await shopRepository.find({ filter: { ownerId: userId } });
    return shops.some((shop) => String(shop._id) === String(shopId));
  }

  /**
   * Every promotion of a shop, in any state.
   *
   * Only the shop owner (or an admin) may see paused/unlisted drafts, so the
   * caller must already have been checked with ownsShop().
   */
  listForShop(shopId) {
    return promotionRepository.find({ filter: { shopId } });
  }

  /**
   * A single promotion.
   *
   * A non-live promotion is indistinguishable from a missing one unless the
   * caller owns it or is an admin — otherwise a draft offer could be enumerated.
   */
  async getById(id, { userId, role } = {}) {
    const promotion = await promotionRepository.findById(id);
    if (!promotion) throw new ApiError('Promotion not found', 404);
    if (isLive(promotion)) return promotion;
    if (isAdmin(role)) return promotion;
    if (await this.ownsShop(promotion.shopId, userId)) return promotion;
    throw new ApiError('Promotion not found', 404);
  }

  async create(payload, { userId, role } = {}) {
    const { shopId, title, description, startsAt, endsAt, showOnPublic } = payload || {};

    if (!shopId) throw new ApiError('shopId is required', 400);
    if (!title || String(title).trim().length < 2) {
      throw new ApiError('A promotion title is required (min 2 chars)', 400);
    }

    const discountPercent = normalizePercent(payload.discountPercent);
    const start = normalizeDate(startsAt, 'startsAt') || new Date();
    const end = normalizeDate(endsAt, 'endsAt');
    if (end && end.getTime() < start.getTime()) {
      throw new ApiError('endsAt must be after startsAt', 400);
    }

    if (!isAdmin(role) && !(await this.ownsShop(shopId, userId))) {
      throw new ApiError('You do not manage this business', 403);
    }

    const shop = await shopRepository.findById(shopId);

    return promotionRepository.create({
      shopId,
      shop: shop ? { _id: String(shop._id), name: shop.name } : undefined,
      title: String(title).trim(),
      description: description ? String(description).trim() : '',
      discountPercent,
      startsAt: start,
      endsAt: end,
      showOnPublic: showOnPublic !== false,
      createdBy: userId || null,
    });
  }

  async update(id, payload, { userId, role } = {}) {
    const promotion = await promotionRepository.findById(id);
    if (!promotion) throw new ApiError('Promotion not found', 404);
    if (!isAdmin(role) && !(await this.ownsShop(promotion.shopId, userId))) {
      throw new ApiError('You do not manage this business', 403);
    }

    const data = {};
    if (payload.title !== undefined) {
      if (!payload.title || String(payload.title).trim().length < 2) {
        throw new ApiError('A promotion title is required (min 2 chars)', 400);
      }
      data.title = String(payload.title).trim();
    }
    if (payload.description !== undefined) data.description = String(payload.description || '').trim();
    if (payload.discountPercent !== undefined) data.discountPercent = normalizePercent(payload.discountPercent);
    if (payload.startsAt !== undefined) data.startsAt = normalizeDate(payload.startsAt, 'startsAt');
    if (payload.endsAt !== undefined) data.endsAt = normalizeDate(payload.endsAt, 'endsAt');
    if (payload.status !== undefined) {
      if (!['active', 'paused'].includes(payload.status)) {
        throw new ApiError("status must be 'active' or 'paused'", 400);
      }
      data.status = payload.status;
    }
    if (payload.showOnPublic !== undefined) data.showOnPublic = payload.showOnPublic !== false;

    if (data.endsAt && data.startsAt && data.endsAt.getTime() < data.startsAt.getTime()) {
      throw new ApiError('endsAt must be after startsAt', 400);
    }

    return promotionRepository.findByIdAndUpdate(id, data);
  }

  async remove(id, { userId, role } = {}) {
    const promotion = await promotionRepository.findById(id);
    if (!promotion) throw new ApiError('Promotion not found', 404);
    if (!isAdmin(role) && !(await this.ownsShop(promotion.shopId, userId))) {
      throw new ApiError('You do not manage this business', 403);
    }
    await promotionRepository.deleteById(id);
    return { message: 'Promotion deleted' };
  }
}

module.exports = new PromotionsService();
module.exports.isLive = isLive;
module.exports.ApiError = ApiError;
