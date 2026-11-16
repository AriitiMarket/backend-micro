'use strict';

/**
 * Order Inventory Service
 * Manages cart-line stock eligibility, inventory validation, reservations, and payment deduction.
 */

const mongoose = require('mongoose');
const productRepository = require('../../catalog/repositories/products.repository');
const inventoryService = require('./inventory.service');
const orderRepository = require('../repositories/orders.repository');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

class OrderInventoryService {
  /**
   * Is this cart line backed by a catalogue product (and therefore by stock)?
   * Agreement lines have no product behind them (negotiated), so stock is skipped.
   */
  isStockManagedLine(line) {
    if (!line) return false;
    if (line.stockManaged === false) return false;
    return Boolean(line.productId || line._id || line.id);
  }

  /** The catalogue product id of a stock-managed line, or null. */
  lineProductId(line) {
    if (!this.isStockManagedLine(line)) return null;
    return String(line.productId || line._id || line.id);
  }

  /** The quantity of a cart line. */
  lineQuantity(line) {
    return Number(line?.quantity ?? line?.qty ?? 0) || 0;
  }

  /**
   * Check that every stock-managed line of a cart can still be supplied.
   */
  async validateInventoryAvailability(cart) {
    const items = [];
    for (const item of cart || []) {
      if (!this.isStockManagedLine(item)) continue;
      const productId = this.lineProductId(item);
      const qty = this.lineQuantity(item);
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
   */
  async reserveInventory(cart, orderId, tracker = null) {
    const movements = [];
    for (const item of cart || []) {
      if (!this.isStockManagedLine(item)) continue;
      const productId = this.lineProductId(item);
      const qty = this.lineQuantity(item);
      movements.push(await inventoryService.reserveStock(productId, qty, orderId, 'STANDARD'));
    }
    return movements;
  }

  /**
   * Release the reservation of every stock-managed line of a cart.
   */
  async releaseInventory(cart, orderId, reason = '') {
    const movements = [];
    for (const item of cart || []) {
      if (!this.isStockManagedLine(item)) continue;
      const productId = this.lineProductId(item);
      const qty = this.lineQuantity(item);
      movements.push(await inventoryService.releaseReservation(productId, qty, orderId));
    }
    return movements;
  }

  /**
   * Reserve inventory for agreement/request orders
   */
  async reserveInventoryForOrder(productId, quantity, orderId, type = 'STANDARD') {
    return inventoryService.reserveStock(productId, quantity, orderId, type);
  }

  /**
   * Deduct stock on payment confirmation
   */
  async deductInventoryOnPayment(cartOrOrderId, maybeOrderId) {
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

      const movements = [];
      for (const item of order.cart || []) {
        if (!this.isStockManagedLine(item)) continue;
        const productId = this.lineProductId(item);
        const qty = this.lineQuantity(item);
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
}

module.exports = new OrderInventoryService();
