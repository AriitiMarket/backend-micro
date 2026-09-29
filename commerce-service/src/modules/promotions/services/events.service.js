const eventRepository = require('../repositories/events.repository');
const shopRepository = require('../../selling/repositories/shops.repository');
const { validateCategory } = require('../../../shared/utils/categoryValidator');

class ApiError extends Error { constructor(message, statusCode) { super(message); this.statusCode = statusCode; } }

function isAdminRequester(requester) {
  return Boolean(requester && requester.role === 'ADMIN');
}

class EventService {
  /**
   * Create an event. The caller must own the target shop (admins excepted) —
   * previously any SELLER could attribute an event to any shopId that existed,
   * mirroring the product create hole.
   */
  async createEvent(payload, requester) {
    const { shopId, images, sellerId, category } = payload;
    const shop = await shopRepository.findById(shopId);
    if (!shop) throw new ApiError('Business not found', 404);
    if (!requester || !requester.id) throw new ApiError('Authentication required', 401);
    if (!isAdminRequester(requester) && String(shop.ownerId) !== String(requester.id)) {
      throw new ApiError('Forbidden: you can only create events for your own shop', 403);
    }
    if (!images || !images.length) throw new ApiError('Please upload at least one image', 400);
    await validateCategory(category, 'event');
    const data = {
      ...payload,
      images,
      shop,
      sellerId: isAdminRequester(requester) ? (sellerId || shop.ownerId || null) : requester.id,
    };
    return eventRepository.create(data);
  }

  getShopEvents(shopId) { return eventRepository.findByShop(shopId); }
  getAllEvents() { return eventRepository.findAll(); }

  /**
   * Delete an event. Ownership check: the caller must own the shop the event
   * belongs to (admins excepted) — previously this had zero authorization.
   */
  async deleteEvent(id, requester) {
    const event = await eventRepository.findById(id);
    if (!event) throw new ApiError('Event not found', 404);
    if (!requester || !requester.id) throw new ApiError('Authentication required', 401);
    if (!isAdminRequester(requester)) {
      const ownerId = event.shop && event.shop.ownerId ? String(event.shop.ownerId) : null;
      const isOwner =
        (event.sellerId && String(event.sellerId) === String(requester.id)) ||
        (ownerId && ownerId === String(requester.id));
      if (!isOwner) {
        throw new ApiError('Forbidden: you can only delete events from your own shop', 403);
      }
    }
    await eventRepository.deleteById(id);
    return { message: 'Event deleted successfully' };
  }
}

module.exports = new EventService();
