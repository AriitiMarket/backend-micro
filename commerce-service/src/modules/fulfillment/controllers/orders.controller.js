/**
 * Orders Controller
 * Integrates all fixes: pagination, ACID transactions, state machine,
 * delivery coverage, idempotency, and bulk actions
 */

const ordersService = require('../services/orders.service');
const orderStateService = require('../services/orderState.service');
const returnsService = require('../services/returns.service');

class OrdersController {
  /**
   * Get all orders for a shop (with pagination)
   * FIX #7: Server-side pagination
   */
  async getAllOrdersOfShop(req, res, next) {
    try {
      const { shopId } = req.params;
      const { page, limit, status, sortBy, sortOrder } = req.query;

      const result = await ordersService.getAllOrdersOfShop(shopId, {
        page: parseInt(page) || 1,
        limit: parseInt(limit) || 20,
        status,
        sortBy,
        sortOrder,
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  /**
   * Confirm order (FIX #1, #10, #12)
   * - ACID transaction
   * - Idempotent (returns 200 if already confirmed)
   * - Checks delivery coverage
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

      res.json({
        message: 'Order confirmed successfully',
        order,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Update order status (FIX #4, #8)
   * - State machine validation
   * - Timeline tracking
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

      res.json({
        message: 'Order status updated',
        order,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Get order timeline (FIX #8)
   */
  async getOrderTimeline(req, res, next) {
    try {
      const { orderId } = req.params;
      const timeline = await ordersService.getOrderTimeline(orderId);

      res.json({
        orderId,
        timeline,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Bulk order action (FIX #14 backend)
   * Accept/reject/ship multiple orders at once
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

      res.json({
        message: `Bulk ${action} completed`,
        ...result,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Cancel order
   */
  async cancelOrder(req, res, next) {
    try {
      const { orderId } = req.params;
      const userId = req.user?.id || req.user?._id;

      const order = await ordersService.cancelOrder(orderId, {
        userId,
        reason: req.body.reason || 'Cancelled by system',
      });

      res.json({
        message: 'Order cancelled',
        order,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Get available stock for product
   */
  async getAvailableStock(req, res, next) {
    try {
      const { productId } = req.params;
      const available = await ordersService.getAvailableStock(productId);

      res.json({
        productId,
        available,
      });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new OrdersController();
