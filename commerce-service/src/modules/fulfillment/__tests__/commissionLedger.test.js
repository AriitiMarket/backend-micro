/**
 * COMMISSION LEDGER SERVICE TESTS
 * Unit tests for commission calculation audit trail
 */

const commissionLedgerService = require('../services/commissionLedger.service');
const commissionLedgerRepository = require('../repositories/commissionLedger.repository');
const allocationRepository = require('../repositories/sellerAllocation.repository');

describe('CommissionLedgerService', () => {
  const orderId = 'order123';
  const sellerId = 'seller123';

  const testCommissionData = {
    grossSubtotal: 1000,
    shippingFee: 50,
    taxAmount: 100,
    discountAmount: 50,
    commissionRate: 10,
    platformCommission: 100, // 10% of 1000
    netPayable: 900, // 1000 - 100
    allocationId: 'alloc123',
    reason: 'ORDER_CONFIRMED',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('logCommission()', () => {
    it('should log commission calculation', async () => {
      const mockEntry = {
        _id: 'ledger123',
        orderId,
        sellerId,
        ...testCommissionData,
        timestamp: new Date(),
      };

      jest.spyOn(commissionLedgerRepository, 'create').mockResolvedValueOnce(mockEntry);

      const result = await commissionLedgerService.logCommission(
        orderId,
        sellerId,
        testCommissionData
      );

      expect(result.grossSubtotal).toBe(1000);
      expect(result.platformCommission).toBe(100);
      expect(result.netPayable).toBe(900);
      expect(result.commissionRate).toBe(10);
      expect(result.timestamp).toBeDefined();
    });

    it('should include all breakdown fields', async () => {
      jest.spyOn(commissionLedgerRepository, 'create').mockResolvedValueOnce({});

      await commissionLedgerService.logCommission(
        orderId,
        sellerId,
        testCommissionData
      );

      expect(commissionLedgerRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          grossSubtotal: 1000,
          shippingFee: 50,
          taxAmount: 100,
          discountAmount: 50,
          commissionRate: 10,
          platformCommission: 100,
          netPayable: 900,
        }),
        expect.any(Object)
      );
    });

    it('should support custom reason and metadata', async () => {
      jest.spyOn(commissionLedgerRepository, 'create').mockResolvedValueOnce({});

      const customData = {
        ...testCommissionData,
        reason: 'MANUAL_ADJUSTMENT',
        metadata: { adjustedBy: 'admin123', note: 'Loyalty discount' },
      };

      await commissionLedgerService.logCommission(orderId, sellerId, customData);

      expect(commissionLedgerRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'MANUAL_ADJUSTMENT',
          metadata: { adjustedBy: 'admin123', note: 'Loyalty discount' },
        }),
        expect.any(Object)
      );
    });
  });

  describe('getCommissionHistory()', () => {
    it('should retrieve commission history for seller', async () => {
      const mockHistory = [
        {
          _id: 'ledger1',
          orderId: 'order1',
          platformCommission: 100,
          timestamp: new Date('2024-01-03'),
        },
        {
          _id: 'ledger2',
          orderId: 'order2',
          platformCommission: 150,
          timestamp: new Date('2024-01-02'),
        },
      ];

      jest.spyOn(commissionLedgerRepository, 'find').mockResolvedValueOnce(mockHistory);

      const result = await commissionLedgerService.getCommissionHistory(sellerId);

      expect(result).toHaveLength(2);
      expect(commissionLedgerRepository.find).toHaveBeenCalledWith({
        filter: { sellerId },
        limit: 50,
        offset: 0,
        sort: { timestamp: -1 },
      });
    });

    it('should support date range filtering', async () => {
      jest.spyOn(commissionLedgerRepository, 'find').mockResolvedValueOnce([]);

      const startDate = '2024-01-01';
      const endDate = '2024-01-31';

      await commissionLedgerService.getCommissionHistory(sellerId, {
        startDate,
        endDate,
      });

      expect(commissionLedgerRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: expect.objectContaining({
            timestamp: {
              $gte: new Date(startDate),
              $lte: new Date(endDate),
            },
          }),
        })
      );
    });

    it('should support pagination', async () => {
      jest.spyOn(commissionLedgerRepository, 'find').mockResolvedValueOnce([]);

      await commissionLedgerService.getCommissionHistory(sellerId, {
        limit: 25,
        offset: 75,
      });

      expect(commissionLedgerRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 25, offset: 75 })
      );
    });
  });

  describe('getTotalCommissionForPeriod()', () => {
    it('should calculate total commission and revenue for period', async () => {
      const mockEntries = [
        {
          orderId: 'order1',
          grossSubtotal: 1000,
          platformCommission: 100,
          netPayable: 900,
        },
        {
          orderId: 'order2',
          grossSubtotal: 2000,
          platformCommission: 200,
          netPayable: 1800,
        },
      ];

      jest.spyOn(commissionLedgerService, 'getCommissionHistory')
        .mockResolvedValueOnce(mockEntries);

      const result = await commissionLedgerService.getTotalCommissionForPeriod(sellerId);

      expect(result.totalCommission).toBe(300); // 100 + 200
      expect(result.totalGrossRevenue).toBe(3000); // 1000 + 2000
      expect(result.totalNetPayable).toBe(2700); // 900 + 1800
      expect(result.orderCount).toBe(2);
      expect(result.averageCommissionRate).toBe(10); // 300 / 3000 * 100
    });

    it('should return zeros if no entries', async () => {
      jest.spyOn(commissionLedgerService, 'getCommissionHistory')
        .mockResolvedValueOnce([]);

      const result = await commissionLedgerService.getTotalCommissionForPeriod(sellerId);

      expect(result.totalCommission).toBe(0);
      expect(result.orderCount).toBe(0);
      expect(result.averageCommissionRate).toBe(0);
    });

    it('should include detailed breakdown', async () => {
      const mockEntries = [
        {
          orderId: 'order1',
          grossSubtotal: 1000,
          platformCommission: 100,
          netPayable: 900,
          timestamp: new Date('2024-01-01'),
        },
      ];

      jest.spyOn(commissionLedgerService, 'getCommissionHistory')
        .mockResolvedValueOnce(mockEntries);

      const result = await commissionLedgerService.getTotalCommissionForPeriod(sellerId);

      expect(result.breakdown).toBeDefined();
      expect(result.breakdown[0].orderId).toBe('order1');
      expect(result.breakdown[0].commission).toBe(100);
    });
  });

  describe('auditCommissions()', () => {
    it('should verify commission integrity', async () => {
      const mockLedger = [
        { orderId: 'order1', platformCommission: 100 },
        { orderId: 'order2', platformCommission: 200 },
      ];

      jest.spyOn(commissionLedgerService, 'getCommissionHistory')
        .mockResolvedValueOnce(mockLedger);

      const mockAllocations = [
        { orderId: 'order1' },
        { orderId: 'order2' },
      ];

      jest.spyOn(allocationRepository, 'find').mockResolvedValueOnce(mockAllocations);

      jest.spyOn(commissionLedgerService, 'getTotalCommissionForPeriod')
        .mockResolvedValueOnce({
          totalCommission: 300,
          totalGrossRevenue: 3000,
          orderCount: 2,
        });

      const result = await commissionLedgerService.auditCommissions(sellerId);

      expect(result.verified).toBe(true);
      expect(result.ledgerEntryCount).toBe(2);
      expect(result.allocationCount).toBe(2);
      expect(result.issues).toEqual([]);
    });

    it('should detect missing ledger entries', async () => {
      const mockLedger = [{ orderId: 'order1' }]; // Only one

      jest.spyOn(commissionLedgerService, 'getCommissionHistory')
        .mockResolvedValueOnce(mockLedger);

      const mockAllocations = [
        { orderId: 'order1' },
        { orderId: 'order2' }, // Order2 missing from ledger
      ];

      jest.spyOn(allocationRepository, 'find').mockResolvedValueOnce(mockAllocations);

      jest.spyOn(commissionLedgerService, 'getTotalCommissionForPeriod')
        .mockResolvedValueOnce({});

      const result = await commissionLedgerService.auditCommissions(sellerId);

      expect(result.verified).toBe(false);
      expect(result.issues).toContain('1 allocations missing from ledger');
    });

    it('should return no ledger entries when none exist', async () => {
      jest.spyOn(commissionLedgerService, 'getCommissionHistory')
        .mockResolvedValueOnce([]);

      const result = await commissionLedgerService.auditCommissions(sellerId);

      expect(result.verified).toBe(false);
      expect(result.ledgerEntryCount).toBe(0);
      expect(result.issues).toContain('No ledger entries found');
    });
  });

  describe('getCommissionByReason()', () => {
    it('should breakdown commission by reason', async () => {
      const mockEntries = [
        { reason: 'ORDER_CONFIRMED', platformCommission: 100 },
        { reason: 'ORDER_CONFIRMED', platformCommission: 150 },
        { reason: 'MANUAL_ADJUSTMENT', platformCommission: 50 },
      ];

      jest.spyOn(commissionLedgerService, 'getCommissionHistory')
        .mockResolvedValueOnce(mockEntries);

      const result = await commissionLedgerService.getCommissionByReason(sellerId);

      expect(result.ORDER_CONFIRMED.count).toBe(2);
      expect(result.ORDER_CONFIRMED.totalCommission).toBe(250);
      expect(result.MANUAL_ADJUSTMENT.count).toBe(1);
      expect(result.MANUAL_ADJUSTMENT.totalCommission).toBe(50);
    });

    it('should handle unknown reasons', async () => {
      const mockEntries = [
        { reason: 'UNKNOWN_REASON', platformCommission: 100 },
      ];

      jest.spyOn(commissionLedgerService, 'getCommissionHistory')
        .mockResolvedValueOnce(mockEntries);

      const result = await commissionLedgerService.getCommissionByReason(sellerId);

      expect(result.UNKNOWN_REASON).toBeDefined();
    });
  });
});
