/**
 * ORDER NOTES SERVICE
 * Buyer-seller messaging within order context
 * 
 * Reuses patterns from:
 * - orders.service.js (class structure, error handling)
 * - allocation.service.js (session support)
 * - returns.service.js (repository integration)
 */

const mongoose = require('mongoose');
const OrderNote = require('../models/OrderNote');
const orderRepository = require('../repositories/orders.repository');
const orderNotesRepository = require('../repositories/orderNotes.repository');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

class OrderNotesService {
  /**
   * Create note on order (buyer or seller)
   * @param {string} orderId
   * @param {string} userId - Creator ID
   * @param {string} userRole - 'BUYER' or 'SELLER'
   * @param {string} message - Note content
   * @param {Object} options - { isPinned, isInternal }
   * @returns {Promise<Object>} created note
   */
  async createNote(orderId, userId, userRole, message, options = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Verify order exists
      const order = await orderRepository.findById(orderId);
      if (!order) {
        await session.abortTransaction();
        throw new ApiError('Order not found', 404);
      }

      // Verify user has access (buyer or seller of order)
      const isBuyer = String(order.buyerId) === String(userId);
      const isSeller = String(order.sellerId) === String(userId);
      
      if (!isBuyer && !isSeller) {
        await session.abortTransaction();
        throw new ApiError('You do not have access to this order', 403);
      }

      // Create note
      const note = await orderNotesRepository.create(
        {
          orderId: String(orderId),
          userId: String(userId),
          userRole,
          message,
          isPinned: options.isPinned || false,
          isInternal: options.isInternal || false,
          createdAt: new Date(),
        },
        { session }
      );

      await session.commitTransaction();
      return note;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Get all notes on order (sorted by pinned, then newest)
   * @param {string} orderId
   * @param {Object} options - { limit, offset }
   * @returns {Promise<Array>}
   */
  async getNotes(orderId, options = {}) {
    const { limit = 50, offset = 0 } = options;

    const notes = await orderNotesRepository.find(
      {
        filter: { orderId: String(orderId) },
        limit,
        offset,
        sort: { isPinned: -1, createdAt: -1 },
      }
    );

    return notes || [];
  }

  /**
   * Get count of notes
   * @param {string} orderId
   * @returns {Promise<number>}
   */
  async getNoteCount(orderId) {
    return orderNotesRepository.countByFilter({ orderId: String(orderId) });
  }

  /**
   * Pin/unpin note
   * @param {string} noteId
   * @param {boolean} isPinned
   * @returns {Promise<Object>}
   */
  async setPinned(noteId, isPinned) {
    const note = await orderNotesRepository.update(
      noteId,
      { isPinned: Boolean(isPinned) }
    );

    if (!note) {
      throw new ApiError('Note not found', 404);
    }

    return note;
  }

  /**
   * Delete note (soft delete - mark as deleted)
   * @param {string} noteId
   * @param {string} userId - Deleter (must be creator)
   * @returns {Promise<Object>}
   */
  async deleteNote(noteId, userId) {
    const note = await orderNotesRepository.findById(noteId);

    if (!note) {
      throw new ApiError('Note not found', 404);
    }

    if (String(note.userId) !== String(userId)) {
      throw new ApiError('You can only delete your own notes', 403);
    }

    return orderNotesRepository.update(noteId, { deletedAt: new Date() });
  }

  /**
   * Get notes for order with buyer/seller info (for UI)
   * @param {string} orderId
   * @returns {Promise<Array>}
   */
  async getNotesForDisplay(orderId) {
    const notes = await this.getNotes(orderId, { limit: 100 });
    
    // Filter out deleted notes
    return notes.filter(n => !n.deletedAt).map(n => ({
      id: n._id,
      message: n.message,
      author: n.userRole === 'BUYER' ? 'Buyer' : 'Seller',
      authorRole: n.userRole,
      createdAt: n.createdAt,
      isPinned: n.isPinned,
      isInternal: n.isInternal,
    }));
  }
}

module.exports = new OrderNotesService();
