/**
 * FIX #7: Server-side Pagination for Orders
 * FIX #12: Delivery Coverage Check on Order Acceptance
 * FIX #1: ACID Transaction Integration
 * FIX #4: State Machine Integration
 * 
 * Unified orders service with pagination, delivery validation,
 * and atomic transaction support
 */

const mongoose = require('mongoose');
const crypto = require('crypto');
const orderRepository = require('../repositories/orders.repository');
const inventoryService = require('./inventory.service');
const orderStateService = require('./orderState.service');
const orderDeliveryService = require('./orderDelivery.service');
const shopRepository = require('../../selling/repositories/shops.repository');
const notificationService = require('../../../shared/services/notification.service');
const productRepository = require('../../catalog/repositories/products.repository');
const { isProductPubliclyVisible } = require('../../../shared/utils/productVisibility');
const promotionsService = require('../../promotions/services/promotions.service');
const { ORDER_STATUSES, normalizeStatus } = require('../constants/orderStatuses');
const { deliveryClient } = require('../../../app/clients/delivery.client');
const { isAdmin } = require('../../../shared/utils/roles');

async function notifyOrderStatus(order, previousStatus, nextStatus) {
  try {
    await notificationService.notifyOrderStatus(order, previousStatus, nextStatus);
  } catch (err) {
    console.warn(`Notification failed for order ${order._id}: ${err.message}`);
  }
}

/**
 * The platform's shipping rule for an order that is NOT priced by a delivery
 * zone: 3% of the order value, to 2dp.
 *
 * A checkout order takes its shipping from the delivery zone's own fee rule
 * (the Delivery Service prices it). An agreement order has no zone quote, so
 * it uses this rule — the same one the checkout UI shows for an agreement.
 */
function computeShipping(subtotal) {
  return Math.round((Number(subtotal) || 0) * 0.03 * 100) / 100;
}

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

class OrdersService {
  /**
   * Create order with stock reservation (FIX #2)
   * @param {Object} orderData
   * @returns {Promise<Array<Object>>} Seller-level order rows for the checkout
   */
  async createOrder(orderData = {}) {
    const fulfilmentType = String(orderData.fulfilmentType || 'delivery').toLowerCase();
    if (!['delivery', 'pickup'].includes(fulfilmentType)) throw new ApiError('Invalid fulfilment type', 422);
    const buyerId = String(orderData.userId || orderData.user?._id || orderData.user?.id || '');
    if (!buyerId) throw new ApiError('Authenticated buyer is required', 401);
    if (!Array.isArray(orderData.cart) || orderData.cart.length === 0) {
      throw new ApiError('Cart is required', 400);
    }

    // Rebuild every money-bearing field from current catalog records. The
    // browser's displayed total and line prices are estimates only.
    const cart = [];
    for (const requested of orderData.cart) {
      const productId = String(requested.productId || requested._id || '');
      const quantity = Number(requested.quantity ?? requested.qty ?? 1);
      if (!mongoose.isValidObjectId(productId)) throw new ApiError('Invalid product in cart', 400);
      if (!Number.isSafeInteger(quantity) || quantity < 1) throw new ApiError('Cart quantity must be a positive whole number', 400);

      const product = await productRepository.findById(productId);
      if (!product || !(await isProductPubliclyVisible(product))) {
        throw new ApiError('A product in your cart is no longer available', 409);
      }
      const unitPrice = Number(product.discountPrice);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new ApiError('A product has an invalid price', 409);
      const lineSubtotal = Math.round(unitPrice * quantity * 100) / 100;
      if (!Number.isFinite(lineSubtotal)) throw new ApiError('Cart total is too large', 400);

      cart.push({
        _id: String(product._id),
        productId: String(product._id),
        name: product.name,
        category: product.category,
        categoryId: product.categoryId || '',
        shopId: String(product.shopId),
        shopName: product.shop?.name || '',
        sellerId: String(product.sellerId || product.shop?.ownerId || ''),
        image: product.images?.[0] || '',
        images: product.images || [],
        price: unitPrice,
        discountPrice: unitPrice,
        originalPrice: Number(product.originalPrice) || unitPrice,
        quantity,
        qty: quantity,
        subtotal: lineSubtotal,
      });
    }

    const groups = new Map();
    for (const item of cart) {
      if (!groups.has(item.shopId)) groups.set(item.shopId, []);
      groups.get(item.shopId).push(item);
    }
    if (!groups.size) throw new ApiError('Cart has no valid seller items', 400);

    const groupTotals = new Map(await Promise.all([...groups.entries()].map(async ([shopId, items]) => {
      const subtotal = Math.round(items.reduce((sum, item) => sum + item.subtotal, 0) * 100) / 100;
      const quantity = items.reduce((sum, item) => sum + item.quantity, 0);
      if (fulfilmentType === 'pickup') {
        const pickupShop = await shopRepository.findById(shopId);
        if (!pickupShop || pickupShop.pickupEnabled !== true) throw new ApiError('Pickup is not available for this seller', 422);
        return [shopId, { items, subtotal, quantity, shippingFee: 0, deliveryFeeRuleId: null, delivererShareRate: 0 }];
      }
      const destinationLocationId = orderData.destination?.sectorId || orderData.destination?.locationId || orderData.locationId;
      const quoteResult = await deliveryClient.quoteDeliveryFee(orderData.deliveryZoneId, quantity, destinationLocationId);
      if (!quoteResult.ok || !Number.isFinite(Number(quoteResult.body?.fee))) {
        throw new ApiError(quoteResult.body?.message || 'Could not calculate delivery fee', quoteResult.status || 503);
      }
      return [shopId, {
        items, subtotal, quantity,
        shippingFee: Math.round(Number(quoteResult.body.fee) * 100) / 100,
        deliveryFeeRuleId: quoteResult.body.ruleId || null,
        delivererShareRate: Number(quoteResult.body.delivererShareRate ?? 80),
      }];
    })));
    const subtotal = Math.round([...groupTotals.values()].reduce((sum, group) => sum + group.subtotal, 0) * 100) / 100;
    let promo = null;
    const promoCode = orderData.promoCode ? String(orderData.promoCode) : null;

    if (promoCode) {
      const priorOrders = await orderRepository.count({
        buyerId,
        status: { $nin: [ORDER_STATUSES.CANCELLED, 'CANCELLED', 'CANCELED'] },
      });
      promo = await promotionsService.validateCode(
        promoCode,
        cart,
        subtotal,
        buyerId,
        priorOrders === 0
      );
    }

    // Allocate the validated discount only to seller groups that contain
    // eligible lines. Platform promotions are apportioned by eligible value;
    // seller promotions remain inside their owning shop.
    const eligibleByShop = new Map();
    if (promo) {
      const promotion = promo.promotion;
      for (const [shopId, group] of groupTotals) {
        const eligibleSubtotal = group.items.reduce((sum, item) => {
          if (!promotion.isPlatformWide && String(promotion.shopId) !== shopId) return sum;
          if (promo.eligibleProducts.length && !promo.eligibleProducts.includes(item.productId)) return sum;
          if (promo.eligibleCategories.length && !promo.eligibleCategories.includes(String(item.categoryId))) return sum;
          return sum + item.subtotal;
        }, 0);
        eligibleByShop.set(shopId, eligibleSubtotal);
      }
    }
    const eligibleTotal = [...eligibleByShop.values()].reduce((sum, value) => sum + value, 0);
    let discountRemaining = promo && !promo.isFreeDelivery
      ? Math.min(subtotal, Number(promo.discountAmount) || 0)
      : 0;
    const freeDelivery = promo?.isFreeDelivery === true;
    const shopDiscounts = new Map();
    for (const [shopId, group] of groupTotals) {
      const eligibleSubtotal = eligibleByShop.get(shopId) || 0;
      let discount = 0;
      if (freeDelivery && eligibleSubtotal > 0) {
        discount = group.shippingFee;
      } else if (eligibleSubtotal > 0 && eligibleTotal > 0 && discountRemaining > 0) {
        const remainingEligible = [...groupTotals.keys()]
          .slice([...groupTotals.keys()].indexOf(shopId) + 1)
          .reduce((sum, nextShopId) => sum + (eligibleByShop.get(nextShopId) || 0), 0);
        discount = remainingEligible === 0
          ? discountRemaining
          : Math.min(discountRemaining, Math.round((Number(promo.discountAmount) * eligibleSubtotal / eligibleTotal) * 100) / 100);
        discount = Math.min(discount, group.subtotal, discountRemaining);
        discountRemaining = Math.round((discountRemaining - discount) * 100) / 100;
      }
      shopDiscounts.set(shopId, Math.round(discount * 100) / 100);
    }

    const orderGroupId = new mongoose.Types.ObjectId().toString();
    const reservations = [];
    const createdOrders = [];

    try {
      for (const [shopId, group] of groupTotals) {
        const orderId = new mongoose.Types.ObjectId();
        const shop = await shopRepository.findById(shopId);
        if (!shop) throw new ApiError('A shop in your cart is no longer available', 409);
        if (shop.showOnPublic === false || (shop.status && !['APPROVED', 'ACTIVE'].includes(shop.status))) {
          throw new ApiError('A shop in your cart is no longer accepting orders', 409);
        }
        const sellerId = String(shop.ownerId || group.items[0].sellerId || '');
        for (const item of group.items) item.sellerId = sellerId;
        const groupReservations = [];
        for (const item of group.items) {
          const reservation = await inventoryService.reserveStock(
            item.productId,
            item.quantity,
            String(orderId),
            'STANDARD'
          );
          reservations.push({ ...reservation, orderId: String(orderId) });
          groupReservations.push(reservation);
        }

        const discountAmount = shopDiscounts.get(shopId) || 0;
        const pickupCode = fulfilmentType === 'pickup' ? String(crypto.randomInt(0, 1000000)).padStart(6, '0') : null;
        const order = await orderRepository.create({
          _id: orderId,
          orderGroupId,
          buyerId,
          user: { ...(orderData.user || {}), _id: buyerId, id: buyerId },
          cart: group.items,
          sellerId,
          shopId,
          sellerShipments: [{
            sellerId,
            businessId: shop.businessId ? String(shop.businessId) : null,
            shopId,
            items: group.items,
            subtotal: group.subtotal,
            discountAmount,
            origin: shop.locationSnapshot || {},
          }],
          subtotal: group.subtotal,
          shippingFee: group.shippingFee,
          fulfilmentType,
          ...(pickupCode ? {
            pickupCodeHash: crypto.createHash('sha256').update(pickupCode).digest('hex'),
            pickupExpiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
          } : {}),
          deliveryFeeRuleId: group.deliveryFeeRuleId,
          delivererShareRate: group.delivererShareRate,
          discountAmount,
          totalPrice: Math.max(0, Math.round((group.subtotal + group.shippingFee - discountAmount) * 100) / 100),
          currency: 'ETB',
          promoCode: promo?.promotion?.code || null,
          appliedPromotionId: promo?.promotion?.id ? String(promo.promotion.id) : null,
          promoDiscountDetails: promo?.promotion ? {
            discountType: promo.promotion.discountType,
            discountPercent: promo.promotion.discountPercent,
            fixedAmount: promo.promotion.fixedAmount,
            maxDiscountAmount: promo.promotion.maxDiscountAmount,
            isPlatformWide: promo.promotion.isPlatformWide,
          } : undefined,
          shippingAddress: orderData.shippingAddress || {},
          destination: orderData.destination || {},
          deliveryZoneId: orderData.deliveryZoneId || null,
          deliveryZoneName: orderData.deliveryZoneName || '',
          sectorId: orderData.sectorId || orderData.destination?.sectorId || null,
          locationId: orderData.locationId || orderData.destination?.sectorId || null,
          paymentInfo: orderData.paymentInfo || {},
          status: ORDER_STATUSES.PROCESSING,
          createdAt: new Date(),
          reservations: groupReservations,
        });
        if (pickupCode) {
          order.pickupCode = pickupCode;
          delete order.pickupCodeHash;
        }
        // The ORDER ↔ DELIVERY bridge row is written HERE, at checkout, with
        // the delivery brief (items, pickup, destination, declared value) that
        // the Delivery handoff and every order view read. Written later it
        // would be an empty shell — the Delivery Service events that create it
        // know nothing about the parcel.
        await orderDeliveryService.linkForOrder(order, order.sellerShipments?.[0], order.destination);
        createdOrders.push(order);
      }

      if (promo) {
        await promotionsService.usageTracker.recordUsage(
          promo.promotion.id,
          buyerId,
          orderGroupId,
          [...shopDiscounts.values()].reduce((sum, amount) => sum + amount, 0)
        );
      }

      return createdOrders;
    } catch (err) {
      if (promo) {
        try { await promotionsService.usageTracker.rollbackUsage(promo.promotion.id, orderGroupId); }
        catch (rollbackError) { console.error('Promotion usage rollback failed:', rollbackError.message); }
      }
      for (const createdOrder of createdOrders) {
        try { await orderRepository.deleteById(createdOrder._id); }
        catch (cleanupError) { console.error('Failed to remove incomplete order:', cleanupError.message); }
      }
      for (const reservation of reservations.reverse()) {
        try {
          await inventoryService.releaseReservation(reservation.productId, reservation.quantity, reservation.orderId);
        } catch (cleanupError) {
          console.error(`Failed to release reservation for ${reservation.productId}:`, cleanupError.message);
        }
      }
      throw err;
    }
  }

  /**
   * FIX #7: Get orders with server-side pagination
   * Prevents hanging on 10K+ orders
   * @param {string} shopId
   * @param {Object} options - { limit, offset, status, sortBy, sortOrder }
   * @returns {Promise<Object>} { orders, total, page, limit, hasMore }
   */
  async getShopOrders(shopId, options = {}) {
    const {
      limit = 20,
      offset = 0,
      status,
      sortBy = 'createdAt',
      sortOrder = -1,
    } = options;

    // Validate pagination params
    const validatedLimit = Math.min(Math.max(1, limit), 100); // 1-100 items per page
    const validatedOffset = Math.max(0, offset);

    // Build filter
    const filter = { shopId };
    if (status) {
      filter.status = { $regex: status, $options: 'i' };
    }

    // Query with pagination
    const [orders, total] = await Promise.all([
      orderRepository.find({
        filter,
        limit: validatedLimit,
        offset: validatedOffset,
        sort: { [sortBy]: sortOrder },
      }),
      orderRepository.count(filter),
    ]);

    const page = Math.floor(validatedOffset / validatedLimit) + 1;
    const totalPages = Math.ceil(total / validatedLimit);

    return {
      orders,
      total,
      page,
      limit: validatedLimit,
      totalPages,
      hasMore: page < totalPages,
      offset: validatedOffset,
    };
  }

  /**
   * Get all orders of a single shop (with seller context)
   * @param {string} shopId
   * @param {Object} query - { page, limit, status }
   * @returns {Promise<Object>}
   */
  async getAllOrdersOfShop(shopId, query = {}) {
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(parseInt(query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    return this.getShopOrders(shopId, {
      limit,
      offset,
      status: query.status,
      sortBy: query.sortBy || 'createdAt',
      sortOrder: query.sortOrder === 'asc' ? 1 : -1,
    });
  }

  /**
   * FIX #12: Confirm order with delivery coverage check
   * Verifies buyer zone is in shop's delivery coverage
   * @param {string} orderId
   * @param {Object} context - { userId, userRole }
   * @returns {Promise<Object>}
   */
  async confirmOrder(orderId, context = {}) {
    try {
      const order = await orderRepository.findById(orderId);
      if (!order) {
        throw new ApiError('Order not found', 404);
      }
      // A PREPAID order must be paid before the seller accepts it. A Cash On
      // Delivery order is different by design: the money is collected by the
      // rider at handover, so the seller accepts it while the payment is still
      // PENDING and the settlement happens on delivery. Gating COD here made
      // every COD checkout impossible to accept — a deadlock, because the
      // payment only turns CONFIRMED once the delivery completes.
      const paymentMethod = String(order.paymentInfo?.method || order.paymentInfo?.type || '').toUpperCase();
      const cashOnDelivery = ['COD', 'CASH ON DELIVERY', 'CASHONDELIVERY'].includes(paymentMethod);
      if (order.paymentStatus !== 'CONFIRMED' && !cashOnDelivery) {
        throw new ApiError('Order cannot be approved before payment is confirmed', 409);
      }

      // Get shop and buyer info
      const shop = await shopRepository.findById(order.shopId);
      if (!shop) {
        throw new ApiError('Shop not found', 404);
      }
      if (context.userRole === 'SELLER' && String(shop.ownerId) !== String(context.userId)) {
        throw new ApiError('You cannot approve orders for this seller', 403);
      }

      // FIX #12: Check delivery coverage
      const buyerZone = order.destination?.zone || order.buyer?.zone;
      const deliveryCoverage = shop.deliveryCoverage || [];

      if (
        deliveryCoverage.length > 0 &&
        !deliveryCoverage.includes(buyerZone)
      ) {
        throw new ApiError(
          `Order destination zone (${buyerZone}) not in shop delivery coverage: ${deliveryCoverage.join(
            ', '
          )}`,
          422
        );
      }

      // Use atomic confirmation from orderStateService
      return await orderStateService.confirmOrder(orderId, context);
    } catch (err) {
      throw err;
    }
  }

  /**
   * Transition order status
   * @param {string} orderId
   * @param {string|Object} newStatus — the target status, or the `{ status }`
   *   body the admin routes pass
   * @param {Object} context
   * @returns {Promise<Object>}
   */
  async updateOrderStatus(orderId, newStatus, context = {}) {
    // The admin routes pass the whole `{ status }` body while the public
    // controller and the bulk actions pass the status itself. Accept both:
    // forwarding the object as-is made every admin status change fail with
    // "Cannot transition from X to [object Object]".
    let targetStatus = newStatus;
    if (newStatus && typeof newStatus === 'object') {
      const { status, ...rest } = newStatus;
      targetStatus = status;
      context = { ...rest, ...context };
    }
    if (context.userRole === 'SELLER') {
      const order = await orderRepository.findById(orderId);
      if (!order) throw new ApiError('Order not found', 404);
      const shop = await shopRepository.findById(order.shopId);
      if (!shop || String(shop.ownerId) !== String(context.userId)) throw new ApiError('You cannot update this order', 403);
    }
    return orderStateService.transitionOrder(orderId, targetStatus, context);
  }

  async verifyPickup(orderId, suppliedCode, actorId) {
    const order = await orderRepository.findById(orderId, { pickupCode: true });
    if (!order) throw new ApiError('Order not found', 404);
    if (order.fulfilmentType !== 'pickup') throw new ApiError('This order is not a pickup order', 422);
    if (String(order.sellerId) !== String(actorId)) throw new ApiError('You cannot verify pickup for this order', 403);
    if (order.status === ORDER_STATUSES.DELIVERED || order.pickupCompletedAt) throw new ApiError('Pickup already completed', 409);
    if (order.status !== ORDER_STATUSES.SHIPPED) throw new ApiError('Order is not ready for pickup', 409);
    if (Number(order.pickupCodeAttempts || 0) >= 5) throw new ApiError('Pickup code verification is locked', 429);
    const code = String(suppliedCode || '');
    const suppliedHash = crypto.createHash('sha256').update(code).digest();
    const storedHash = Buffer.from(String(order.pickupCodeHash || ''), 'hex');
    const valid = /^\d{6}$/.test(code) && storedHash.length === suppliedHash.length && crypto.timingSafeEqual(storedHash, suppliedHash);
    if (!valid) {
      const updated = await orderRepository.incrementPickupCodeAttempt(orderId);
      const locked = !updated || Number(updated.pickupCodeAttempts) >= 5;
      throw new ApiError(locked ? 'Pickup code verification is locked' : 'Invalid pickup code', locked ? 429 : 422);
    }
    const completed = await orderRepository.claimPickupCompletion(orderId, storedHash.toString('hex'), actorId);
    if (!completed) throw new ApiError('Pickup was already completed or the code is no longer valid', 409);
    await notifyOrderStatus(completed, ORDER_STATUSES.SHIPPED, ORDER_STATUSES.DELIVERED);
    return completed;
  }

  /**
   * Get order timeline
   * @param {string} orderId
   * @returns {Promise<Array>}
   */
  async getOrderTimeline(orderId) {
    return orderStateService.getOrderTimeline(orderId);
  }

  /**
   * Cancel order (releases reservation)
   * @param {string} orderId
   * @param {Object} context - { userId, reason }
   * @returns {Promise<Object>}
   */
  async cancelOrder(orderId, context = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const order = await orderRepository.findById(orderId, { session });
      if (!order) {
        if (session.inTransaction()) await session.abortTransaction();
        throw new ApiError('Order not found', 404);
      }

      if (context.userRole === 'BUYER' && String(order.buyerId) !== String(context.userId)) {
        if (session.inTransaction()) await session.abortTransaction();
        throw new ApiError('You cannot cancel this order', 403);
      }
      if (context.userRole === 'SELLER') {
        const shop = await shopRepository.findById(order.shopId);
        if (!shop || String(shop.ownerId) !== String(context.userId)) {
          if (session.inTransaction()) await session.abortTransaction();
          throw new ApiError('You cannot cancel this order', 403);
        }
      }

      // Only an order that has not left the warehouse can be cancelled. The
      // state machine does not allow SHIPPED / DELIVERED / REFUND_REQUESTED
      // -> CANCELLED, and cancelling one of those would contradict the
      // shipment that is already on its way (or the refund already running).
      if (!orderStateService.validateTransition(order.status, ORDER_STATUSES.CANCELLED)) {
        if (session.inTransaction()) await session.abortTransaction();
        throw new ApiError(`Cannot cancel an order in status ${order.status}`, 409);
      }

      // Stock handling depends on whether the money already moved.
      //
      // Payment still PENDING: the units were only RESERVED, so releasing the
      // reservation gives them back to the available pool — `stock` is
      // untouched.
      //
      // Payment CONFIRMED: the units were sold (the stock was deducted when
      // the payment was confirmed), so cancelling has to RETURN them to stock
      // and the order's payment status becomes REFUNDED.
      const paymentWasConfirmed = String(order.paymentStatus || '').toUpperCase() === 'CONFIRMED';

      for (const item of (order.cart || [])) {
        await inventoryService.releaseReservation(
          item.productId,
          item.quantity,
          orderId,
          { session }
        );
        if (paymentWasConfirmed) {
          await inventoryService.restoreStock(
            item.productId,
            item.quantity,
            orderId,
            { session }
          );
        }
      }

      // Update status using the canonical spelling accepted by the model.
      const previousStatus = order.status;
      order.status = ORDER_STATUSES.CANCELLED;
      order.cancelledAt = new Date();
      order.cancelledBy = context.userId;
      order.cancellationReason = context.reason;
      if (paymentWasConfirmed) order.paymentStatus = 'REFUNDED';

      if (!order.timeline) order.timeline = [];
      order.timeline.push({
        status: ORDER_STATUSES.CANCELLED,
        previousStatus,
        timestamp: new Date(),
        reason: context.reason,
      });

      await order.save({ session });
      await session.commitTransaction();

      // A seller-split checkout counts as one promotion redemption. Release it
      // only after every order in that checkout has been cancelled.
      if (order.appliedPromotionId) {
        const activeGroupOrders = order.orderGroupId
          ? await orderRepository.count({
            orderGroupId: String(order.orderGroupId),
            status: { $nin: [ORDER_STATUSES.CANCELLED, 'CANCELLED', 'CANCELED'] },
          })
          : 0;
        if (activeGroupOrders === 0) {
          try {
            await promotionsService.usageTracker.rollbackUsage(
              order.appliedPromotionId,
              String(order.orderGroupId || order._id)
            );
          } catch (rollbackError) {
            // Cancellation is already committed; log so a redemption can be
            // repaired without restoring the cancelled order's stock/status.
            console.error('Promotion usage rollback failed:', rollbackError.message);
          }
        }
      }

      return order;
    } catch (err) {
      if (session.inTransaction()) await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Bulk order action (FIX #14 backend support)
   * @param {Array} orderIds
   * @param {string} action - 'ACCEPT' | 'REJECT' | 'SHIP'
   * @param {Object} context
   * @returns {Promise<Object>} { successCount, failureCount, errors }
   */
  async bulkOrderAction(orderIds, action, context = {}) {
    const results = {
      successCount: 0,
      failureCount: 0,
      errors: [],
    };

    for (const orderId of orderIds) {
      try {
        if (action === 'ACCEPT') {
          await this.confirmOrder(orderId, context);
        } else if (action === 'REJECT') {
          await this.cancelOrder(orderId, context);
        } else if (action === 'SHIP') {
          await this.updateOrderStatus(
            orderId,
            'SHIPPED',
            { ...context, reason: 'Bulk shipped' }
          );
        }
        results.successCount++;
      } catch (err) {
        results.failureCount++;
        results.errors.push({
          orderId,
          error: err.message,
        });
      }
    }

    return results;
  }

  /**
   * Get available stock (considering reservations)
   * @param {string} productId
   * @returns {Promise<number>}
   */
  async getAvailableStock(productId) {
    return inventoryService.getAvailableStock(productId);
  }

  /**
   * Refund order - transition to Refund Requested state
   * @param {string} orderId
   * @param {Object} data - { status }
   * @param {Object} context - { id, role }
   * @returns {Promise<Object>}
   */
  async refundOrder(orderId, data = {}, context = {}) {
    const order = await orderRepository.findById(orderId);
    if (!order) {
      throw new ApiError('Order not found', 404);
    }

    // Access control: only buyer or admin can request refund
    const buyerId = order.buyerId || order.user?._id || order.user?.id;
    if (context.role === 'CUSTOMER' && buyerId !== context.id) {
      throw new ApiError('Forbidden', 403);
    }

    // Use state machine for transition
    return orderStateService.transitionOrder(orderId, 'Refund Requested', context);
  }

  /**
   * Refund success - transition order and restock
   * @param {string} orderId
   * @param {Object} data - { status }
   * @returns {Promise<Object>}
   */
  async refundSuccess(orderId, data = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const order = await orderRepository.findById(orderId, { session });
      if (!order) {
        if (session.inTransaction()) await session.abortTransaction();
        throw new ApiError('Order not found', 404);
      }

      // A repeated refund is a no-op: the order is already refunded and the
      // stock was returned once. Returning early keeps the ledger correct — a
      // second release would either double-restock or fail on a product whose
      // reservation was already released.
      if (normalizeStatus(order.status) === ORDER_STATUSES.REFUND_SUCCESS) {
        if (session.inTransaction()) await session.abortTransaction();
        return order;
      }

      // Transition to Refund Success
      await orderStateService.transitionOrder(orderId, 'Refund Success', {}, { session, deferSideEffects: true });

      // Restock items if not already restocked. The units were sold when the
      // payment was confirmed, so they go back to stock (and their reservation
      // is released) — the ledger's RETURN entry.
      if (!order.restocked) {
        for (const item of (order.cart || [])) {
          await inventoryService.releaseReservation(
            item.productId,
            item.quantity,
            orderId,
            { session }
          );
          await inventoryService.restoreStock(
            item.productId,
            item.quantity,
            orderId,
            { session }
          );
        }
        order.restocked = true;
        await order.save({ session });
      }

      const updated = await orderRepository.findById(orderId, { session });
      await session.commitTransaction();
      await notifyOrderStatus(updated, order.status, updated.status);
      return updated;
    } catch (err) {
      if (session.inTransaction()) await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Deduct inventory on payment confirmation
   * @param {string} orderId
   * @returns {Promise<Object>}
   */
  async deductInventoryOnPayment(cartOrOrderId, maybeOrderId) {
    // Called both as (orderId) and as (cart, orderId): a caller that just
    // wrote the order can hand over the lines it wrote instead of reading the
    // order back.
    const orderId = Array.isArray(cartOrOrderId) ? maybeOrderId : cartOrOrderId;
    const providedCart = Array.isArray(cartOrOrderId) ? cartOrOrderId : null;

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const order = providedCart
        ? { cart: providedCart }
        : await orderRepository.findById(orderId, { session });
      if (!order) {
        if (session.inTransaction()) await session.abortTransaction();
        throw new ApiError('Order not found', 404);
      }

      // Deduct from actual inventory. Agreement lines have no product behind
      // them, so they are skipped.
      const movements = [];
      for (const item of order.cart || []) {
        if (!OrdersService.isStockManagedLine(item)) continue;
        const productId = OrdersService.lineProductId(item);
        const qty = OrdersService.lineQuantity(item);
        movements.push(await inventoryService.deductFromInventory(productId, qty, { session }));
      }

      await session.commitTransaction();
      return movements;
    } catch (err) {
      if (session.inTransaction()) await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Is this cart line backed by a catalogue product (and therefore by stock)?
   *
   * An agreement order's negotiated lines have no product behind them — they
   * are the deal itself — so every stock operation must skip them instead of
   * trying to reserve a product that does not exist.
   */
  static isStockManagedLine(line) {
    if (!line) return false;
    if (line.stockManaged === false) return false;
    return Boolean(line.productId || line._id || line.id);
  }

  /** The catalogue product id of a stock-managed line, or null. */
  static lineProductId(line) {
    if (!OrdersService.isStockManagedLine(line)) return null;
    return String(line.productId || line._id || line.id);
  }

  /** The quantity of a cart line. */
  static lineQuantity(line) {
    return Number(line?.quantity ?? line?.qty ?? 0) || 0;
  }

  /**
   * Check that every stock-managed line of a cart can still be supplied.
   * Agreement lines are skipped — there is no stock behind them.
   */
  async validateInventoryAvailability(cart) {
    const items = [];
    for (const item of cart || []) {
      if (!OrdersService.isStockManagedLine(item)) continue;
      const productId = OrdersService.lineProductId(item);
      const qty = OrdersService.lineQuantity(item);
      const product = await productRepository.findById(productId);
      if (!product) throw new ApiError(`Product not found: ${productId}`, 404);
      const availableStock = (product.stock || 0) - (product.reserved || 0);
      if (availableStock < qty) {
        throw new ApiError(`Insufficient stock for "${product.name}". Available: ${availableStock}, requested: ${qty}`, 400);
      }
      items.push({ productId, product, qty, availableStock });
    }
    return { available: true, items };
  }

  /**
   * Reserve the stock of every stock-managed line of a cart.
   * @returns {Promise<Array>} one entry per reserved line (agreement lines are
   *   skipped, so they produce no entry)
   */
  async reserveInventory(cart, orderId, tracker = null) {
    const movements = [];
    for (const item of cart || []) {
      if (!OrdersService.isStockManagedLine(item)) continue;
      const productId = OrdersService.lineProductId(item);
      const qty = OrdersService.lineQuantity(item);
      movements.push(await inventoryService.reserveStock(productId, qty, orderId, 'STANDARD'));
    }
    return movements;
  }

  /**
   * Release the reservation of every stock-managed line of a cart.
   * @returns {Promise<Array>} one entry per released line
   */
  async releaseInventory(cart, orderId, reason = '') {
    const movements = [];
    for (const item of cart || []) {
      if (!OrdersService.isStockManagedLine(item)) continue;
      const productId = OrdersService.lineProductId(item);
      const qty = OrdersService.lineQuantity(item);
      movements.push(await inventoryService.releaseReservation(productId, qty, orderId));
    }
    return movements;
  }

  /**
   * Reserve inventory for agreement/request orders
   * @param {string} productId
   * @param {number} quantity
   * @param {string} orderId
   * @param {string} type - 'AGREEMENT' | 'STANDARD'
   * @returns {Promise<Object>}
   */
  async reserveInventoryForOrder(productId, quantity, orderId, type = 'STANDARD') {
    return inventoryService.reserveStock(productId, quantity, orderId, type);
  }

  /**
   * Create order from agreement
   * @param {Object} agreementData
   * @returns {Promise<Object>}
   */
  async createAgreementOrder(agreementData = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Agreement orders use the same required core fields as checkout orders.
      // Keep the request service's descriptive `lines` input, but persist it as
      // the canonical cart and derive the amount from the accepted terms.
      //
      // The agreed lines are NOT catalogue products: there is no product id and
      // no stock behind them, so every line is marked `stockManaged: false`
      // and every stock operation skips it (see isStockManagedLine).
      const cart = (agreementData.lines || agreementData.cart || []).map((line) => ({
        ...line,
        quantity: Number(line.quantity || 0),
        price: Number(line.unitPrice ?? line.price ?? 0),
        unitPrice: Number(line.unitPrice ?? line.price ?? 0),
        stockManaged: false,
      }));
      const subtotal = cart.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
      const buyerId = String(agreementData.buyerId || agreementData.user?.id || agreementData.user?._id || '');
      const sellerId = String(agreementData.sellerId || cart[0]?.sellerId || '');
      const shopId = String(agreementData.shopId || cart[0]?.shopId || '');
      // Shipping on an agreement order: the platform's agreement rule (3% of
      // the agreed value). A checkout order is priced by the delivery zone's
      // own fee rule; an agreement has no zone quote, so it uses this rule —
      // the same one the checkout UI shows for an agreement.
      const shippingFee = Number(agreementData.shippingFee || computeShipping(subtotal));
      // Create order with agreement reference
      const order = await orderRepository.create(
        {
          ...agreementData,
          cart,
          buyerId,
          user: { ...(agreementData.user || {}), id: buyerId, _id: buyerId },
          sellerId,
          shopId,
          subtotal,
          shippingFee,
          totalPrice: Math.round((subtotal + shippingFee) * 100) / 100,
          status: 'Processing',
          isAgreement: true,
          createdAt: new Date(),
        },
        { session }
      );

      await session.commitTransaction();
      return order;
    } catch (err) {
      if (session.inTransaction()) await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }
/**
   * Get orders for a buyer
   * @param {string} userId
   * @returns {Promise<Array>}
   */
  async getBuyerOrders(userId) {
    if (!userId) throw new ApiError('User ID required', 400);
    // The repository reads a buyer's orders by `buyerId` through findByUser().
    return orderRepository.findByUser(String(userId));
  }

  /**
   * Get orders for a seller
   * @param {string} sellerId
   * @returns {Promise<Array>}
   */
  async getSellerOrders(sellerId) {
    if (!sellerId) throw new ApiError('Seller ID required', 400);
    return orderRepository.findBySellerId(sellerId);
  }

  /**
   * Get order by ID
   * @param {string} orderId
   * @returns {Promise<Object|null>}
   */
  async getOrderById(orderId) {
    if (!orderId) throw new ApiError('Order ID required', 400);
    return orderRepository.findById(orderId);
  }

  /**
   * Approve refund for order (seller action)
   * @param {string} orderId
   * @param {Object} data - { userId, userRole, status }
   * @returns {Promise<Object>}
   */
  async approveRefund(orderId, data = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const order = await orderRepository.findById(orderId, { session });
      if (!order) {
        if (session.inTransaction()) await session.abortTransaction();
        throw new ApiError('Order not found', 404);
      }

      // Transition to Refund Success
      await orderStateService.transitionOrder(orderId, 'Refund Success', {}, { session, deferSideEffects: true });

      // Restock items if not already restocked
      if (!order.restocked) {
        for (const item of (order.cart || [])) {
          await inventoryService.releaseReservation(
            item.productId,
            item.quantity,
            orderId,
            { session }
          );
        }
      }

      const updated = await orderRepository.findById(orderId, { session });
      await session.commitTransaction();
      await notifyOrderStatus(updated, order.status, updated.status);
      return updated;
    } catch (err) {
      if (session.inTransaction()) await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Request refund for order (buyer action)
   * @param {string} orderId
   * @param {Object} data - { userId, userRole, status }
   * @returns {Promise<Object>}
   */
  async requestRefund(orderId, data = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const order = await orderRepository.findById(orderId, { session });
      if (!order) {
        if (session.inTransaction()) await session.abortTransaction();
        throw new ApiError('Order not found', 404);
      }

      // Transition to Refund Requested
      await orderStateService.transitionOrder(orderId, 'Refund Requested', {}, { session, deferSideEffects: true });

      const updated = await orderRepository.findById(orderId, { session });
      await session.commitTransaction();
      await notifyOrderStatus(updated, order.status, updated.status);
      return updated;
    } catch (err) {
      if (session.inTransaction()) await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Recover delivery handoffs for orders that are confirmed but haven't been handed off to Delivery Service.
   * Runs at startup and periodically to ensure no confirmed order is stuck without a delivery request.
   * @param {number} limit - Max orders to process per run
   * @returns {Promise<Object>} { processed, succeeded, failed, abandoned }
   */
  async recoverDeliveryHandoffs(limit = 100) {
    // Find orders that are CONFIRMED but don't have a delivery request yet
    const orders = await orderRepository.find({
      filter: {
        status: 'Confirmed',
        // Only orders created from checkout (not agreement orders)
        requestId: null,
        // Pickup orders are completed at the shop and must never enter the
        // delivery network. `$ne` also includes legacy rows without this field.
        fulfilmentType: { $ne: 'pickup' },
      },
      limit,
      sort: { createdAt: 1 },
    });

    if (!orders.length) {
      return { processed: 0, succeeded: 0, failed: 0, abandoned: 0 };
    }

    let succeeded = 0;
    let failed = 0;
    let abandoned = 0;

    for (const order of orders) {
      const orderId = String(order._id);

      // Check if already has a delivery link
      const existingLink = await orderDeliveryService.getByOrderId(orderId);
      if (existingLink?.deliveryRequestId) {
        continue; // Already handed off
      }

      try {
        // The SAME handoff the seller confirmation sends — one brief, one
        // financial snapshot, one address snapshot.
        const result = await orderStateService.deliverHandoff(order);

        if (result.ok) {
          succeeded++;
        } else if (result.reason === 'rejected') {
          abandoned++;
        } else {
          // Server error or network issue - will retry next sweep
          failed++;
        }
      } catch (err) {
        // Network/timeout error - will retry next sweep
        await orderDeliveryService.waitForOrderApproval(orderId);
        console.error(`[recoverDeliveryHandoffs] Order ${orderId} handoff failed:`, err.message);
        failed++;
      }
    }

    return { processed: orders.length, succeeded, failed, abandoned };
  }

  /**
   * Buyer confirms receipt of a delivered order.
   * @param {string} orderId
   * @param {Object} actor - Authenticated user { id, role, ... }
   * @returns {Promise<Object>} Updated order document
   */
  async confirmReceipt(orderId, actor) {
    let order = await orderRepository.findById(orderId);
    let orderGroupId = order?.orderGroupId;

    if (!order) {
      const ordersInGroup = await orderRepository.findByOrderGroupId(orderId);
      if (ordersInGroup && ordersInGroup.length > 0) {
        orderGroupId = orderId;
        order = ordersInGroup[0];
      }
    }

    if (!order) throw new ApiError('Order not found', 404);

    const actorId = String(actor?.id || actor?.sub || '');
    const isBuyerOfOrder = String(order.buyerId || order.user?._id || order.user?.id || '') === actorId;
    if (!isBuyerOfOrder && !isAdmin(actor)) {
      throw new ApiError('You can only confirm receipt for your own order', 403);
    }

    const currentStatus = normalizeStatus(order.status);
    if (currentStatus !== ORDER_STATUSES.DELIVERED) {
      throw new ApiError(`Order must be in Delivered status to confirm receipt (current status: ${currentStatus})`, 409);
    }

    // Consolidated confirmation: if this order belongs to an order group,
    // confirm receipt for all sub-orders of this buyer in the group that are delivered.
    if (orderGroupId) {
      const groupOrders = await orderRepository.findByOrderGroupId(orderGroupId);
      for (const ord of groupOrders) {
        if (String(ord.buyerId) !== String(order.buyerId)) continue;
        const status = normalizeStatus(ord.status);
        if (status === ORDER_STATUSES.DELIVERED && !ord.buyerConfirmedReceipt) {
          ord.buyerConfirmedReceipt = true;
          ord.buyerConfirmedAt = new Date();
          if (!ord.timeline) ord.timeline = [];
          ord.timeline.push({
            status: ORDER_STATUSES.DELIVERED,
            previousStatus: status,
            timestamp: new Date(),
            actor: actorId,
            actorRole: 'BUYER',
            reason: 'Buyer confirmed receipt of consolidated order',
          });
          await ord.save();
        }
      }
      return await orderRepository.findById(order._id);
    }

    if (order.buyerConfirmedReceipt) {
      return order; // Idempotent
    }

    order.buyerConfirmedReceipt = true;
    order.buyerConfirmedAt = new Date();
    if (!order.timeline) order.timeline = [];
    order.timeline.push({
      status: ORDER_STATUSES.DELIVERED,
      previousStatus: currentStatus,
      timestamp: new Date(),
      actor: actorId,
      actorRole: 'BUYER',
      reason: 'Buyer confirmed receipt of order',
    });

    await order.save();
    return order;
  }
}

module.exports = new OrdersService();
