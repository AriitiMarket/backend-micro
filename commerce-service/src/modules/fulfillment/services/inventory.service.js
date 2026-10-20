/**
 * FIX #2 & #3 & #9: Stock & Inventory Management System
 * Unified service for stock operations, reservations, and ledger
 * No duplication - single source of truth for inventory operations
 */

const mongoose = require('mongoose');
const productRepository = require('../../catalog/repositories/products.repository');
const inventoryLedgerRepository = require('../../catalog/repositories/inventoryLedger.repository');
const orderRepository = require('../repositories/orders.repository');
const { ORDER_STATUSES } = require('../constants/orderStatuses');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

class InventoryService {
  /**
   * Reserve stock for an order (creates ledger entry)
   * @param {string} productId
   * @param {number} quantity
   * @param {string} orderId
   * @param {string} type - 'STANDARD' | 'BACKORDER' | 'PREORDER'
   * @returns {Promise<Object>} reservation details
   */
  async reserveStock(productId, quantity, orderId, type = 'STANDARD') {
    // Standard checkout reservations are one conditional product update. This
    // is atomic across workers and also works on standalone MongoDB, where a
    // multi-document transaction cannot be started.
    if (type === 'STANDARD') {
      const product = await productRepository.reserveAvailable(productId, quantity);
      if (!product) {
        const current = await productRepository.findById(productId);
        if (!current) throw new ApiError('Product not found', 404);
        const available = Math.max(0, (Number(current.stock) || 0) - (Number(current.reserved) || 0));
        throw new ApiError(`Insufficient stock: ${available} available, ${quantity} requested`, 422);
      }

      try {
        const ledgerEntry = await inventoryLedgerRepository.create({
          productId: String(productId),
          orderId: String(orderId),
          type: 'RESERVE',
          quantity,
          reservationType: type,
          timestamp: new Date(),
        });
        return {
          reservationId: ledgerEntry._id,
          productId: String(productId),
          quantity,
          type,
          reserved: product.reserved,
          status: 'RESERVED',
        };
      } catch (err) {
        try { await productRepository.releaseReserved(productId, quantity); }
        catch (compensationError) {
          console.error(`Failed to compensate reservation for ${productId}:`, compensationError.message);
        }
        throw err;
      }
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const product = await productRepository.findById(productId, { session });
      if (!product) {
        if (session.inTransaction()) await session.abortTransaction();
        throw new ApiError('Product not found', 404);
      }

      const available = (product.stock || 0) - (product.reserved || 0);

      // Validate based on type
      if (type === 'STANDARD' && available < quantity) {
        if (session.inTransaction()) await session.abortTransaction();
        throw new ApiError(
          `Insufficient stock: ${available} available, ${quantity} requested`,
          422
        );
      }

      if (type === 'BACKORDER') {
        const backorderSpace = product.backorderLimit - (product.currentBackorders || 0);
        if (backorderSpace < quantity) {
          if (session.inTransaction()) await session.abortTransaction();
          throw new ApiError(
            `Backorder limit exceeded: ${backorderSpace} available, ${quantity} requested`,
            422
          );
        }
      }

      if (type === 'PREORDER') {
        const preorderSpace = (product.preorderStock || 0) - (product.currentPreorders || 0);
        if (preorderSpace < quantity) {
          if (session.inTransaction()) await session.abortTransaction();
          throw new ApiError(
            `Preorder limit exceeded: ${preorderSpace} available, ${quantity} requested`,
            422
          );
        }
      }

      // Update product reserved count
      if (type === 'STANDARD') {
        product.reserved = (product.reserved || 0) + quantity;
      } else if (type === 'BACKORDER') {
        product.currentBackorders = (product.currentBackorders || 0) + quantity;
      } else if (type === 'PREORDER') {
        product.currentPreorders = (product.currentPreorders || 0) + quantity;
      }

      await product.save({ session });

      // Create ledger entry
      const ledgerEntry = await inventoryLedgerRepository.create(
        {
          productId,
          orderId,
          type: 'RESERVE',
          quantity,
          reservationType: type,
          timestamp: new Date(),
        },
        { session }
      );

      await session.commitTransaction();

      return {
        reservationId: ledgerEntry._id,
        productId,
        quantity,
        type,
        reserved: product.reserved,
        status: 'RESERVED',
      };
    } catch (err) {
      if (session.inTransaction()) await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Convert reservation to sold (after payment success)
   * @param {string} productId
   * @param {number} quantity
   * @param {string} orderId
   * @returns {Promise<Object>}
   */
  async finalizeReservation(productId, quantity, orderId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const product = await productRepository.findById(productId, { session });
      if (!product) {
        if (session.inTransaction()) await session.abortTransaction();
        throw new ApiError('Product not found', 404);
      }

      // Move from reserved to sold (update stock)
      if (product.reserved < quantity) {
        if (session.inTransaction()) await session.abortTransaction();
        throw new ApiError('Reservation mismatch', 409);
      }

      product.reserved = (product.reserved || 0) - quantity;
      product.stock = Math.max(0, (product.stock || 0) - quantity);

      await product.save({ session });

      // Log movement
      await inventoryLedgerRepository.create(
        {
          productId,
          orderId,
          type: 'SELL',
          quantity,
          previousStock: product.stock + quantity,
          newStock: product.stock,
          timestamp: new Date(),
        },
        { session }
      );

      await session.commitTransaction();

      return {
        productId,
        quantity,
        stock: product.stock,
        reserved: product.reserved,
        status: 'SOLD',
      };
    } catch (err) {
      if (session.inTransaction()) await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Release reservation (on order cancellation)
   * @param {string} productId
   * @param {number} quantity
   * @param {string} orderId
   * @returns {Promise<Object>}
   */
  async releaseReservation(productId, quantity, orderId, options = {}) {
    // If session provided, use it; otherwise create new one
    const externalSession = options.session;
    if (!externalSession) {
      // Releasing is TOLERANT: the reservation is clamped at 0 instead of
      // failing when fewer units are reserved than requested. A cancel or a
      // refund releases what is there — a reservation that was already
      // released (or never taken) must not make the cancellation fail, and the
      // old exact behaviour made "cancel this order" impossible for any order
      // whose units had already moved.
      const product = await productRepository.releaseReserved(productId, quantity);
      if (!product) {
        const current = await productRepository.findById(productId);
        if (!current) throw new ApiError('Product not found', 404);
        throw new ApiError('Cannot release more than reserved', 422);
      }

      try {
        await inventoryLedgerRepository.create({
          productId: String(productId),
          orderId: String(orderId),
          type: 'RELEASE',
          quantity,
          timestamp: new Date(),
        });
        return {
          productId,
          quantity,
          reserved: product.reserved,
          status: 'RELEASED',
        };
      } catch (err) {
        try { await productRepository.findByIdAndUpdate(productId, { $inc: { reserved: quantity } }); }
        catch (compensationError) {
          console.error(`Failed to compensate reservation release for ${productId}:`, compensationError.message);
        }
        throw err;
      }
    }

    const session = externalSession || (await mongoose.startSession());

    if (!externalSession) {
      session.startTransaction();
    }

    try {
      const product = await productRepository.findById(productId, { session });
      if (!product) {
        if (!externalSession) if (session.inTransaction()) await session.abortTransaction();
        throw new ApiError('Product not found', 404);
      }

      // Clamped at 0 — see the note above: releasing is not allowed to fail
      // because the reservation is smaller than the quantity requested.
      product.reserved = Math.max(0, (product.reserved || 0) - quantity);
      await product.save({ session });

      await inventoryLedgerRepository.create(
        {
          productId,
          orderId,
          type: 'RELEASE',
          quantity,
          timestamp: new Date(),
        },
        { session }
      );

      if (!externalSession) {
        await session.commitTransaction();
      }

      return {
        productId,
        quantity,
        reserved: product.reserved,
        status: 'RELEASED',
      };
    } catch (err) {
      if (!externalSession) {
        if (session.inTransaction()) await session.abortTransaction();
      }
      throw err;
    } finally {
      if (!externalSession) {
        await session.endSession();
      }
    }
  }

  /**
   * Restore stock when return approved (FIX #3)
   * @param {string} productId
   * @param {number} quantity
   * @param {string} returnId
   * @returns {Promise<Object>}
   */
  async restoreStock(productId, quantity, returnId, options = {}) {
    const session = options.session || await mongoose.startSession();
    const ownsSession = !options.session;
    if (ownsSession) session.startTransaction();

    try {
      const product = await productRepository.findById(productId, { session });
      if (!product) {
        if (ownsSession) if (session.inTransaction()) await session.abortTransaction();
        throw new ApiError('Product not found', 404);
      }

      product.stock = (product.stock || 0) + quantity;
      await product.save({ session });

      await inventoryLedgerRepository.create(
        {
          productId,
          returnId,
          type: 'RESTORE',
          quantity,
          previousStock: product.stock - quantity,
          newStock: product.stock,
          timestamp: new Date(),
        },
        { session }
      );

      if (ownsSession) await session.commitTransaction();

      return {
        productId,
        quantity,
        stock: product.stock,
        status: 'RESTORED',
      };
    } catch (err) {
      if (ownsSession && session.inTransaction()) if (session.inTransaction()) await session.abortTransaction();
      throw err;
    } finally {
      if (ownsSession) await session.endSession();
    }
  }

  /**
   * Get inventory ledger for auditing
   * @param {string} productId
   * @param {Object} options - { limit, offset, startDate, endDate }
   * @returns {Promise<Array>}
   */
  async getInventoryLedger(productId, options = {}) {
    const { limit = 50, offset = 0, startDate, endDate } = options;

    const filter = { productId };
    if (startDate || endDate) {
      filter.timestamp = {};
      if (startDate) filter.timestamp.$gte = startDate;
      if (endDate) filter.timestamp.$lte = endDate;
    }

    return inventoryLedgerRepository.find({
      filter,
      limit,
      offset,
      sort: { timestamp: -1 },
    });
  }

  /**
   * Get available stock for display (stock - reserved)
   * @param {string} productId
   * @returns {Promise<number>}
   */
  async getAvailableStock(productId) {
    const product = await productRepository.findById(productId);
    if (!product) return 0;
    return Math.max(0, (product.stock || 0) - (product.reserved || 0));
  }

  /**
   * Deduct from actual inventory on payment confirmation
   * @param {string} productId
   * @param {number} quantity
   * @param {Object} options - { session }
   * @returns {Promise<Object>}
   */
  async deductFromInventory(productId, quantity, options = {}) {
    const externalSession = options.session;
    const session = externalSession || (await mongoose.startSession());
    
    if (!externalSession) {
      session.startTransaction();
    }

    try {
      const product = await productRepository.findById(productId, { session });
      if (!product) {
        if (!externalSession) if (session.inTransaction()) await session.abortTransaction();
        throw new ApiError('Product not found', 404);
      }

      if ((product.stock || 0) < quantity) {
        if (!externalSession) if (session.inTransaction()) await session.abortTransaction();
        throw new ApiError('Insufficient stock', 422);
      }

      product.stock = (product.stock || 0) - quantity;
      product.sold_out = (product.sold_out || 0) + quantity;
      
      await product.save({ session });

      await inventoryLedgerRepository.create(
        {
          productId,
          type: 'DEDUCT',
          quantity,
          previousStock: product.stock + quantity,
          newStock: product.stock,
          timestamp: new Date(),
        },
        { session }
      );

      if (!externalSession) {
        await session.commitTransaction();
      }

      return {
        productId,
        quantity,
        stock: product.stock,
        status: 'DEDUCTED',
      };
    } catch (err) {
      if (!externalSession) {
        if (session.inTransaction()) await session.abortTransaction();
      }
      throw err;
    } finally {
      if (!externalSession) {
        await session.endSession();
      }
    }
  }
}

module.exports = new InventoryService();
