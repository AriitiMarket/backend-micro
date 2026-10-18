/**
 * ORDER NOTES SERVICE TESTS
 * Unit tests for buyer-seller messaging functionality
 */

const mongoose = require('mongoose');
const orderNotesService = require('../services/orderNotes.service');
const orderNotesRepository = require('../repositories/orderNotes.repository');
const orderRepository = require('../repositories/orders.repository');
const Order = require('../models/Orders');
const OrderNote = require('../models/OrderNote');

describe('OrderNotesService', () => {
  let testOrder, testNote;
  const buyerId = 'buyer123';
  const sellerId = 'seller123';
  const orderId = new mongoose.Types.ObjectId().toString();

  beforeAll(async () => {
    // Mock order for testing
    testOrder = {
      _id: orderId,
      buyerId,
      sellerId,
      cart: [],
      totalPrice: 100,
    };
  });

  describe('createNote()', () => {
    it('should create note when order exists and user has access (buyer)', async () => {
      jest.spyOn(orderRepository, 'findById').mockResolvedValueOnce(testOrder);
      jest.spyOn(orderNotesRepository, 'create').mockResolvedValueOnce({
        _id: 'note123',
        orderId,
        userId: buyerId,
        userRole: 'BUYER',
        message: 'Test message',
        isPinned: false,
      });

      const result = await orderNotesService.createNote(
        orderId,
        buyerId,
        'BUYER',
        'Test message'
      );

      expect(result.userId).toBe(buyerId);
      expect(result.message).toBe('Test message');
      expect(result.userRole).toBe('BUYER');
      expect(orderRepository.findById).toHaveBeenCalledWith(orderId);
    });

    it('should create note when user is seller', async () => {
      jest.spyOn(orderRepository, 'findById').mockResolvedValueOnce(testOrder);
      jest.spyOn(orderNotesRepository, 'create').mockResolvedValueOnce({
        _id: 'note124',
        orderId,
        userId: sellerId,
        userRole: 'SELLER',
        message: 'Seller message',
      });

      const result = await orderNotesService.createNote(
        orderId,
        sellerId,
        'SELLER',
        'Seller message'
      );

      expect(result.userRole).toBe('SELLER');
    });

    it('should throw 404 if order not found', async () => {
      jest.spyOn(orderRepository, 'findById').mockResolvedValueOnce(null);

      await expect(
        orderNotesService.createNote(orderId, buyerId, 'BUYER', 'Test')
      ).rejects.toThrow('Order not found');
    });

    it('should throw 403 if user not buyer or seller', async () => {
      jest.spyOn(orderRepository, 'findById').mockResolvedValueOnce(testOrder);

      await expect(
        orderNotesService.createNote(orderId, 'unauthorized', 'BUYER', 'Test')
      ).rejects.toThrow('You do not have access to this order');
    });

    it('should support pinned option', async () => {
      jest.spyOn(orderRepository, 'findById').mockResolvedValueOnce(testOrder);
      jest.spyOn(orderNotesRepository, 'create').mockResolvedValueOnce({
        _id: 'note125',
        isPinned: true,
      });

      const result = await orderNotesService.createNote(
        orderId,
        buyerId,
        'BUYER',
        'Important',
        { isPinned: true }
      );

      expect(result.isPinned).toBe(true);
    });

    it('should support internal flag', async () => {
      jest.spyOn(orderRepository, 'findById').mockResolvedValueOnce(testOrder);
      jest.spyOn(orderNotesRepository, 'create').mockResolvedValueOnce({
        _id: 'note126',
        isInternal: true,
      });

      const result = await orderNotesService.createNote(
        orderId,
        buyerId,
        'BUYER',
        'Internal note',
        { isInternal: true }
      );

      expect(result.isInternal).toBe(true);
    });
  });

  describe('getNotes()', () => {
    it('should retrieve notes for order sorted by pinned then newest', async () => {
      const mockNotes = [
        { _id: 'note1', message: 'Pinned', isPinned: true, createdAt: new Date('2024-01-02') },
        { _id: 'note2', message: 'Recent', isPinned: false, createdAt: new Date('2024-01-03') },
        { _id: 'note3', message: 'Old', isPinned: false, createdAt: new Date('2024-01-01') },
      ];

      jest.spyOn(orderNotesRepository, 'find').mockResolvedValueOnce(mockNotes);

      const result = await orderNotesService.getNotes(orderId);

      expect(result).toHaveLength(3);
      expect(result[0].isPinned).toBe(true); // Pinned first
      expect(orderNotesRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: { orderId },
          sort: { isPinned: -1, createdAt: -1 },
        })
      );
    });

    it('should support pagination', async () => {
      jest.spyOn(orderNotesRepository, 'find').mockResolvedValueOnce([]);

      await orderNotesService.getNotes(orderId, { limit: 10, offset: 20 });

      expect(orderNotesRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10, offset: 20 })
      );
    });

    it('should return empty array if no notes', async () => {
      jest.spyOn(orderNotesRepository, 'find').mockResolvedValueOnce(null);

      const result = await orderNotesService.getNotes(orderId);

      expect(result).toEqual([]);
    });
  });

  describe('getNoteCount()', () => {
    it('should count notes for order', async () => {
      jest.spyOn(orderNotesRepository, 'countByFilter').mockResolvedValueOnce(5);

      const result = await orderNotesService.getNoteCount(orderId);

      expect(result).toBe(5);
      expect(orderNotesRepository.countByFilter).toHaveBeenCalledWith({
        orderId,
      });
    });
  });

  describe('setPinned()', () => {
    it('should pin note', async () => {
      jest.spyOn(orderNotesRepository, 'update').mockResolvedValueOnce({
        _id: 'note1',
        isPinned: true,
      });

      const result = await orderNotesService.setPinned('note1', true);

      expect(result.isPinned).toBe(true);
      expect(orderNotesRepository.update).toHaveBeenCalledWith('note1', {
        isPinned: true,
      });
    });

    it('should unpin note', async () => {
      jest.spyOn(orderNotesRepository, 'update').mockResolvedValueOnce({
        _id: 'note1',
        isPinned: false,
      });

      const result = await orderNotesService.setPinned('note1', false);

      expect(result.isPinned).toBe(false);
    });

    it('should throw 404 if note not found', async () => {
      jest.spyOn(orderNotesRepository, 'update').mockResolvedValueOnce(null);

      await expect(orderNotesService.setPinned('notfound', true)).rejects.toThrow(
        'Note not found'
      );
    });
  });

  describe('deleteNote()', () => {
    it('should delete own note', async () => {
      jest.spyOn(orderNotesRepository, 'findById').mockResolvedValueOnce({
        _id: 'note1',
        userId: buyerId,
      });

      jest.spyOn(orderNotesRepository, 'update').mockResolvedValueOnce({
        _id: 'note1',
        deletedAt: new Date(),
      });

      const result = await orderNotesService.deleteNote('note1', buyerId);

      expect(result.deletedAt).toBeDefined();
    });

    it('should not allow deleting others\' notes', async () => {
      jest.spyOn(orderNotesRepository, 'findById').mockResolvedValueOnce({
        _id: 'note1',
        userId: 'other-user',
      });

      await expect(orderNotesService.deleteNote('note1', buyerId)).rejects.toThrow(
        'You can only delete your own notes'
      );
    });

    it('should throw 404 if note not found', async () => {
      jest.spyOn(orderNotesRepository, 'findById').mockResolvedValueOnce(null);

      await expect(orderNotesService.deleteNote('notfound', buyerId)).rejects.toThrow(
        'Note not found'
      );
    });
  });

  describe('getNotesForDisplay()', () => {
    it('should return notes without deleted ones', async () => {
      jest.spyOn(orderNotesService, 'getNotes').mockResolvedValueOnce([
        { _id: 'note1', message: 'Visible', userRole: 'BUYER', deletedAt: null },
        { _id: 'note2', message: 'Deleted', userRole: 'SELLER', deletedAt: new Date() },
        { _id: 'note3', message: 'Visible 2', userRole: 'BUYER', deletedAt: null },
      ]);

      const result = await orderNotesService.getNotesForDisplay(orderId);

      expect(result).toHaveLength(2);
      expect(result[0].message).toBe('Visible');
      expect(result[1].message).toBe('Visible 2');
    });

    it('should format notes with author role', async () => {
      jest.spyOn(orderNotesService, 'getNotes').mockResolvedValueOnce([
        { _id: 'note1', message: 'Test', userRole: 'BUYER', createdAt: new Date() },
      ]);

      const result = await orderNotesService.getNotesForDisplay(orderId);

      expect(result[0].author).toBe('Buyer');
      expect(result[0].authorRole).toBe('BUYER');
    });
  });
});
