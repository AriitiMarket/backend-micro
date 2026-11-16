/**
 * Orders Controller — manages buyer checkout creation, seller fulfillment workflows, delivery linking, and refund lifecycles.
 */
'use strict';

const ordersService = require('../services/orders.service');
const orderDeliveryService = require('../services/orderDelivery.service');
const shopRepository = require('../../selling/repositories/shops.repository');
const { isSeller, isAdmin } = require('../../../shared/utils/roles');

class OrdersController {
  /**
   * Get all orders for a shop with pagination and status filtering.
   * 
   * @param {import('express').Request} req - Express request with params { shopId } and query { page, limit, status, sortBy, sortOrder }
   * @param {import('express').Response} res - Express response
   * @param {import('express').NextFunction} next - Express next error handler
   */
  async getAllOrdersOfShop(req, res, next) {
    try {
      const { shopId } = req.params;
      const { status, sortBy, sortOrder } = req.query;
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

      const result = await ordersService.getAllOrdersOfShop(shopId, {
        page,
        limit,
        status,
        sortBy,
        sortOrder,
      });

      return res.json(result);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Confirm order with transactional consistency and delivery coverage check.
   * Idempotent: returns 200 if already confirmed.
   * 
   * @param {import('express').Request} req - Express request with params { orderId }
   * @param {import('express').Response} res - Express response
   * @param {import('express').NextFunction} next - Express next error handler
   */
  async confirmOrder(req, res, next) {
    try {
      const { orderId } = req.params;
      const userId = req.user?.id || req.user?._id;
      const userRole = req.user?.role;

      const order = await ordersService.confirmOrder(orderId, {
        userId,
        userRole,
      });

      return res.json({
        message: 'Order confirmed successfully',
        order,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Buyer confirms receipt of a delivered order.
   * 
   * @param {import('express').Request} req - Express request with params { orderId }
   * @param {import('express').Response} res - Express response
   * @param {import('express').NextFunction} next - Express next error handler
   */
  async confirmReceipt(req, res, next) {
    try {
      const { orderId } = req.params;
      const order = await ordersService.confirmReceipt(orderId, req.user);
      return res.json({
        success: true,
        message: 'Order receipt confirmed successfully',
        order,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Buyer confirms receipt of a consolidated order group.
   * 
   * @param {import('express').Request} req - Express request with params { orderGroupId }
   * @param {import('express').Response} res - Express response
   * @param {import('express').NextFunction} next - Express next error handler
   */
  async confirmReceiptGroup(req, res, next) {
    try {
      const { orderGroupId } = req.params;
      const order = await ordersService.confirmReceipt(orderGroupId, req.user);
      return res.json({
        success: true,
        message: 'Order group receipt confirmed successfully',
        order,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Update order status validated against fulfillment state machine transitions.
   * 
   * @param {import('express').Request} req - Express request with params { orderId } and body { status, reason }
   * @param {import('express').Response} res - Express response
   * @param {import('express').NextFunction} next - Express next error handler
   */
  async updateOrderStatus(req, res, next) {
    try {
      const { orderId } = req.params;
      const { status } = req.body;
      const userId = req.user?.id || req.user?._id;
      const userRole = req.user?.role;

      if (!status) {
        return res.status(400).json({ error: 'Status required' });
      }

      const order = await ordersService.updateOrderStatus(
        orderId,
        status,
        {
          userId,
          userRole,
          reason: req.body.reason,
        }
      );

      return res.json({
        message: 'Order status updated',
        order,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Verify buyer pickup code for in-store or localized order fulfillment.
   * 
   * @param {import('express').Request} req - Express request with params { orderId } and body { code }
   * @param {import('express').Response} res - Express response
   * @param {import('express').NextFunction} next - Express next error handler
   */
  async verifyPickup(req, res, next) {
    try {
      const actorId = req.user?.id || req.user?._id;
      const order = await ordersService.verifyPickup(req.params.orderId, req.body?.code, actorId);
      return res.json({ message: 'Pickup verified', order });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Get full chronological event timeline for an order.
   * 
   * @param {import('express').Request} req - Express request with params { orderId }
   * @param {import('express').Response} res - Express response
   * @param {import('express').NextFunction} next - Express next error handler
   */
  async getOrderTimeline(req, res, next) {
    try {
      const { orderId } = req.params;
      const timeline = await ordersService.getOrderTimeline(orderId);

      return res.json({
        orderId,
        timeline,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Bulk order status modification (accept, reject, ship multiple orders).
   * 
   * @param {import('express').Request} req - Express request with body { orderIds, action }
   * @param {import('express').Response} res - Express response
   * @param {import('express').NextFunction} next - Express next error handler
   */
  async bulkOrderAction(req, res, next) {
    try {
      const { orderIds, action } = req.body;
      const userId = req.user?.id || req.user?._id;
      const userRole = req.user?.role;

      if (!Array.isArray(orderIds) || orderIds.length === 0) {
        return res.status(400).json({ error: 'orderIds array required' });
      }

      if (!['ACCEPT', 'REJECT', 'SHIP'].includes(action)) {
        return res.status(400).json({ error: 'Invalid action' });
      }

      const result = await ordersService.bulkOrderAction(
        orderIds,
        action,
        {
          userId,
          userRole,
        }
      );

      return res.json({
        message: `Bulk ${action} completed`,
        ...result,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Cancel an order with specified cancellation reason.
   * 
   * @param {import('express').Request} req - Express request with params { orderId } and body { reason }
   * @param {import('express').Response} res - Express response
   * @param {import('express').NextFunction} next - Express next error handler
   */
  async cancelOrder(req, res, next) {
    try {
      const { orderId } = req.params;
      const userId = req.user?.id || req.user?._id;

      const order = await ordersService.cancelOrder(orderId, {
        userId,
        userRole: req.user?.role,
        reason: req.body?.reason || 'Cancelled by system',
      });

      return res.json({
        message: 'Order cancelled',
        order,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Get available non-reserved inventory stock for a product.
   * 
   * @param {import('express').Request} req - Express request with params { productId }
   * @param {import('express').Response} res - Express response
   * @param {import('express').NextFunction} next - Express next error handler
   */
  async getAvailableStock(req, res, next) {
    try {
      const { productId } = req.params;
      const available = await ordersService.getAvailableStock(productId);

      return res.json({
        productId,
        available,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Create checkout order from buyer cart.
   * POST /order/create-order
   * 
   * @param {import('express').Request} req - Express request with cart and checkout information
   * @param {import('express').Response} res - Express response
   * @param {import('express').NextFunction} next - Express next error handler
   */
  async createOrder(req, res, next) {
    try {
      const userId = req.user?.id || req.user?._id;
      const {
        cart, promoCode, shippingAddress, destination, deliveryZoneId,
        deliveryZoneName, portId, portName, sectorId, locationId, user, paymentInfo,
        fulfilmentType,
      } = req.body;

      if (!cart || !Array.isArray(cart) || cart.length === 0) {
        return res.status(400).json({ error: 'Cart is required' });
      }

      const orders = await ordersService.createOrder({
        // Only pass checkout fields; body-supplied totals, buyer ids, statuses,
        // and reservation data are never accepted as order authority.
        userId,
        cart,
        promoCode,
        shippingAddress,
        destination,
        deliveryZoneId,
        deliveryZoneName,
        portId,
        portName,
        sectorId,
        locationId,
        user,
        paymentInfo,
        fulfilmentType,
      });

      return res.status(201).json({
        success: true,
        message: 'Order created successfully',
        // Mongoose omits the transient one-time code because it is not a
        // persisted schema field. Add it only to this authenticated response.
        orders: orders.map((order) => ({
          ...(typeof order.toObject === 'function' ? order.toObject() : order),
          ...(order.pickupCode ? { pickupCode: order.pickupCode } : {}),
        }))
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Get all orders for an authenticated buyer.
   * GET /order/get-all-orders/user/:userId
   * 
   * @param {import('express').Request} req - Express request with params { userId }
   * @param {import('express').Response} res - Express response
   * @param {import('express').NextFunction} next - Express next error handler
   */
  async getBuyerOrders(req, res, next) {
    try {
      const { userId } = req.params;
      const { id: actorId, role } = req.user || {};

      // Authorization: buyer can only see own orders, admin sees all
      if (role === 'BUYER' && String(actorId) !== String(userId)) {
        return res.status(403).json({ error: 'You can only view your own orders', code: 'ORDER_ACCESS_DENIED' });
      }

      if (!['BUYER', 'ADMIN'].includes(role)) {
        return res.status(403).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      }

      const orders = await ordersService.getBuyerOrders(userId);

      return res.json({
        success: true,
        orders
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Get all orders for a seller's shop.
   * GET /order/get-all-orders/seller/:sellerId
   * 
   * @param {import('express').Request} req - Express request with params { sellerId }
   * @param {import('express').Response} res - Express response
   * @param {import('express').NextFunction} next - Express next error handler
   */
  async getSellerOrders(req, res, next) {
    try {
      const { id: actorId } = req.user || {};
      const sellerStatus = String(req.user?.roleStatuses?.SELLER || '').toUpperCase();
      const sellerActor = isSeller(req.user) || sellerStatus === 'ACTIVE';
      const adminActor = isAdmin(req.user);

      if (!sellerActor && !adminActor) {
        return res.status(403).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      }

      // Seller capabilities are valid actor roles even when BUYER remains the
      // token's primary role. Always scope seller results to the verified
      // gateway identity; never trust a profile/shop id supplied by the client.
      const sellerId = adminActor ? (req.params.sellerId || actorId) : actorId;

      const orders = await ordersService.getSellerOrders(sellerId);

      return res.json({
        success: true,
        orders
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Get detailed information about a specific order.
   * GET /order/order/:orderId
   * 
   * @param {import('express').Request} req - Express request with params { orderId }
   * @param {import('express').Response} res - Express response
   * @param {import('express').NextFunction} next - Express next error handler
   */
  async getOrderDetails(req, res, next) {
    try {
      const { orderId } = req.params;
      const { id: actorId, role } = req.user || {};

      const order = await ordersService.getOrderById(orderId);

      if (!order) {
        return res.status(404).json({ error: 'Order not found', code: 'ORDER_NOT_FOUND' });
      }

      // Authorization: buyer/seller/admin can view order if they own it
      const isBuyer = String(order.buyerId) === String(actorId);
      let isSellerOwner = String(order.sellerId) === String(actorId);
      const isAdminRole = role === 'ADMIN';

      if (!isSellerOwner && (role === 'SELLER' || isSeller(req.user) || req.user?.roleStatuses?.SELLER === 'ACTIVE')) {
        const shop = await shopRepository.findById(order.shopId);
        if (shop && (String(shop.ownerId) === String(actorId) || String(shop._id) === String(actorId))) {
          isSellerOwner = true;
        }
      }

      if (!isBuyer && !isSellerOwner && !isAdminRole) {
        return res.status(403).json({ error: 'You can only view your own orders', code: 'ORDER_ACCESS_DENIED' });
      }

      return res.json({
        success: true,
        order
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Get delivery linked to an order.
   * GET /order/:id/delivery
   * 
   * @param {import('express').Request} req - Express request with params { id }
   * @param {import('express').Response} res - Express response
   * @param {import('express').NextFunction} next - Express next error handler
   */
  async getOrderDelivery(req, res, next) {
    try {
      const orderId = req.params.id || req.params.orderId;
      const delivery = await orderDeliveryService.getByOrderId(orderId);
      return res.status(200).json({
        success: true,
        delivery: delivery || null,
        linked: Boolean(delivery),
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Approve refund for order (seller/business).
   * PUT /order/order-refund-success/:orderId
   * 
   * @param {import('express').Request} req - Express request with params { orderId }
   * @param {import('express').Response} res - Express response
   * @param {import('express').NextFunction} next - Express next error handler
   */
  async approveRefund(req, res, next) {
    try {
      const { orderId } = req.params;
      const { id: actorId, role } = req.user || {};
      const payload = req.body || {};

      const order = await ordersService.approveRefund(orderId, {
        userId: actorId,
        userRole: role,
        ...payload
      });

      return res.json({
        success: true,
        message: 'Refund approved successfully',
        order
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Request refund for order (buyer).
   * PUT /order/refund-order/:orderId
   * 
   * @param {import('express').Request} req - Express request with params { orderId }
   * @param {import('express').Response} res - Express response
   * @param {import('express').NextFunction} next - Express next error handler
   */
  async refundOrder(req, res, next) {
    try {
      const { orderId } = req.params;
      const { id: actorId, role } = req.user || {};
      const payload = req.body || {};

      if (role !== 'BUYER' && role !== 'ADMIN') {
        return res.status(403).json({ error: 'Only buyers can request refunds', code: 'BUYER_ONLY' });
      }

      const order = await ordersService.requestRefund(orderId, {
        userId: actorId,
        userRole: role,
        ...payload
      });

      return res.json({
        success: true,
        message: 'Refund requested successfully',
        order
      });
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new OrdersController();

