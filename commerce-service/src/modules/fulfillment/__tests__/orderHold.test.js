/**
 * ORDER HOLD SERVICE TESTS
 * Unit tests for order hold/pause functionality
 */

const mongoose = require('mongoose');
const orderHoldService = require('../services/orderHold.service');
const orderHoldRepository = require('../repositories/orderHold.repository');
const orderRepository = require('../repositories/orders.repository');

describe('OrderHoldService', () => {
  const orderId = 'order123';
  const sellerId = 'seller123';
  const userId = 'admin123';
  const testOrder = { _id: orderId, sellerId, cart: [], totalPrice: 100 };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('holdOrder()', () => {
    it('should put order on hold with reason', async () => {
      jest.spyOn(orderRepository, 'findById').mockResolvedValueOnce(testOrder);
      jest.spyOn(orderHoldRepository, 'findByOrderId').mockResolvedValueOnce(null);

      const mockHold = {
        _id: 'hold123',
        orderId,
        reason: 'Payment verification',
        holdByRole: 'ADMIN',
        heldByUserId: userId,
        heldAt: new Date(),
        releasedAt: null,
      };

      jest.spyOn(orderHoldRepository, 'create').mockResolvedValueOnce(mockHold);

      const result = await orderHoldService.holdOrder(
        orderId,
        'Payment verification',
        'ADMIN',
        userId
      );

      expect(result.reason).toBe('Payment verification');
      expect(result.holdByRole).toBe('ADMIN');
      expect(result.releasedAt).toBeNull();
      expect(orderRepository.findById).toHaveBeenCalledWith(orderId);
    });

    it('should throw 404 if order not found', async () => {
      jest.spyOn(orderRepository, 'findById').mockResolvedValueOnce(null);

      await expect(
        orderHoldService.holdOrder(orderId, 'reason', 'ADMIN', userId)
      ).rejects.toThrow('Order not found');
    });

    it('should throw 409 if order already on hold', async () => {
      jest.spyOn(orderRepository, 'findById').mockResolvedValueOnce(testOrder);

      const activeHold = { _id: 'hold1', orderId, releasedAt: null };
      jest.spyOn(orderHoldRepository, 'findByOrderId').mockResolvedValueOnce(activeHold);

      await expect(
        orderHoldService.holdOrder(orderId, 'reason', 'ADMIN', userId)
      ).rejects.toThrow('Order is already on hold');
    });

    it('should support SELLER and SYSTEM hold roles', async () => {
      jest.spyOn(orderRepository, 'findById').mockResolvedValueOnce(testOrder);
      jest.spyOn(orderHoldRepository, 'findByOrderId').mockResolvedValueOnce(null);

      // Test SELLER
      jest.spyOn(orderHoldRepository, 'create').mockResolvedValueOnce({
        holdByRole: 'SELLER',
      });

      await orderHoldService.holdOrder(orderId, 'reason', 'SELLER', userId);

      expect(orderHoldRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ holdByRole: 'SELLER' }),
        expect.any(Object)
      );

      // Test SYSTEM
      jest.spyOn(orderHoldRepository, 'create').mockResolvedValueOnce({
        holdByRole: 'SYSTEM',
      });

      await orderHoldService.holdOrder(orderId, 'reason', 'SYSTEM', userId);

      expect(orderHoldRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ holdByRole: 'SYSTEM' }),
        expect.any(Object)
      );
    });
  });

  describe('releaseHold()', () => {
    it('should release active hold with reason', async () => {
      const activeHold = {
        _id: 'hold123',
        orderId,
        reason: 'Payment verification',
        releasedAt: null,
      };

      jest.spyOn(orderHoldRepository, 'findByOrderId').mockResolvedValueOnce(activeHold);

      const releasedHold = {
        ...activeHold,
        releasedAt: new Date(),
        releaseReason: 'Payment confirmed',
        releasedByUserId: userId,
      };

      jest.spyOn(orderHoldRepository, 'update').mockResolvedValueOnce(releasedHold);

      const result = await orderHoldService.releaseHold(
        orderId,
        'Payment confirmed',
        userId
      );

      expect(result.releasedAt).toBeDefined();
      expect(result.releaseReason).toBe('Payment confirmed');
      expect(result.releasedByUserId).toBe(userId);
    });

    it('should throw 409 if order not on hold', async () => {
      jest.spyOn(orderHoldRepository, 'findByOrderId').mockResolvedValueOnce(null);

      await expect(
        orderHoldService.releaseHold(orderId, 'reason', userId)
      ).rejects.toThrow('Order is not on hold');
    });

    it('should throw 409 if hold already released', async () => {
      const releasedHold = {
        _id: 'hold123',
        orderId,
        releasedAt: new Date('2024-01-01'),
      };

      jest.spyOn(orderHoldRepository, 'findByOrderId').mockResolvedValueOnce(releasedHold);

      await expect(
        orderHoldService.releaseHold(orderId, 'reason', userId)
      ).rejects.toThrow('Order is not on hold');
    });
  });

  describe('getHoldStatus()', () => {
    it('should return hold status for active hold', async () => {
      const now = new Date();
      const holdTime = new Date(now.getTime() - 5 * 60000); // 5 minutes ago

      const activeHold = {
        _id: 'hold123',
        orderId,
        reason: 'Payment verification',
        heldAt: holdTime,
        holdByRole: 'ADMIN',
        releasedAt: null,
      };

      jest.spyOn(orderHoldRepository, 'findByOrderId').mockResolvedValueOnce(activeHold);

      const result = await orderHoldService.getHoldStatus(orderId);

      expect(result).toBeDefined();
      expect(result.reason).toBe('Payment verification');
      expect(result.heldByRole).toBe('ADMIN');
      expect(result.durationMinutes).toBeCloseTo(5, 0);
    });

    it('should return null if no active hold', async () => {
      jest.spyOn(orderHoldRepository, 'findByOrderId').mockResolvedValueOnce(null);

      const result = await orderHoldService.getHoldStatus(orderId);

      expect(result).toBeNull();
    });

    it('should return null if hold is released', async () => {
      const releasedHold = {
        _id: 'hold123',
        orderId,
        releasedAt: new Date(),
      };

      jest.spyOn(orderHoldRepository, 'findByOrderId').mockResolvedValueOnce(releasedHold);

      const result = await orderHoldService.getHoldStatus(orderId);

      expect(result).toBeNull();
    });
  });

  describe('getHoldHistory()', () => {
    it('should return all hold records for order', async () => {
      const holds = [
        { _id: 'hold1', orderId, reason: 'First hold', releasedAt: new Date() },
        { _id: 'hold2', orderId, reason: 'Second hold', releasedAt: null },
      ];

      jest.spyOn(orderHoldRepository, 'findAll').mockResolvedValueOnce(holds);

      const result = await orderHoldService.getHoldHistory(orderId);

      expect(result).toHaveLength(2);
      expect(orderHoldRepository.findAll).toHaveBeenCalledWith({
        orderId,
      });
    });
  });

  describe('getHeldOrdersBySeller()', () => {
    it('should return currently held orders for seller', async () => {
      const sellerHolds = [
        { _id: 'hold1', orderId: 'order1', reason: 'Hold 1', heldAt: new Date() },
        { _id: 'hold2', orderId: 'order2', reason: 'Hold 2', heldAt: new Date() },
      ];

      jest.spyOn(orderHoldRepository, 'findByRole').mockResolvedValueOnce(sellerHolds);

      const sellerOrders = [
        { _id: 'order1', sellerId },
        { _id: 'order2', sellerId },
      ];

      jest.spyOn(orderRepository, 'findBySellerOrShop').mockResolvedValueOnce(sellerOrders);

      const result = await orderHoldService.getHeldOrdersBySeller(sellerId);

      expect(result).toHaveLength(2);
      expect(result[0].orderId).toBe('order1');
      expect(result[0].reason).toBe('Hold 1');
      expect(result[0].durationMinutes).toBeDefined();
    });

    it('should filter to only seller\'s orders', async () => {
      const holds = [
        { _id: 'hold1', orderId: 'order1' },
        { _id: 'hold2', orderId: 'order_other' },
      ];

      jest.spyOn(orderHoldRepository, 'findByRole').mockResolvedValueOnce(holds);

      const sellerOrders = [{ _id: 'order1', sellerId }]; // Only one is seller's

      jest.spyOn(orderRepository, 'findBySellerOrShop').mockResolvedValueOnce(sellerOrders);

      const result = await orderHoldService.getHeldOrdersBySeller(sellerId);

      expect(result).toHaveLength(1);
      expect(result[0].orderId).toBe('order1');
    });

    it('should return empty array if no holds', async () => {
      jest.spyOn(orderHoldRepository, 'findByRole').mockResolvedValueOnce(null);

      const result = await orderHoldService.getHeldOrdersBySeller(sellerId);

      expect(result).toEqual([]);
    });
  });
});
