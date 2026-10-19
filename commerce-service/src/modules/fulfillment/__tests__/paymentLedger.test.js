/**
 * PAYMENT LEDGER SERVICE TESTS
 * Unit tests for immutable payment audit trail
 */

const paymentLedgerService = require('../services/paymentLedger.service');
const paymentLedgerRepository = require('../repositories/paymentLedger.repository');
const paymentRepository = require('../repositories/payments.repository');

describe('PaymentLedgerService', () => {
  const paymentId = 'payment123';
  const orderId = 'order123';
  const userId = 'user123';
  const sellerId = 'seller123';

  const testPayment = {
    _id: paymentId,
    orderId,
    userId,
    sellerId,
    amount: 100,
    currency: 'ETB',
    status: 'PENDING',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('logPaymentChange()', () => {
    it('should log payment status transition', async () => {
      jest.spyOn(paymentRepository, 'findById').mockResolvedValueOnce(testPayment);

      const mockEntry = {
        _id: 'ledger123',
        paymentId,
        orderId,
        userId,
        sellerId,
        oldStatus: 'PENDING',
        newStatus: 'COMPLETED',
        amount: 100,
        currency: 'ETB',
        actor: 'SYSTEM',
        timestamp: new Date(),
      };

      jest.spyOn(paymentLedgerRepository, 'create').mockResolvedValueOnce(mockEntry);

      const result = await paymentLedgerService.logPaymentChange(
        paymentId,
        'PENDING',
        'COMPLETED',
        { actor Type: 'SYSTEM' }
      );

      expect(result.oldStatus).toBe('PENDING');
      expect(result.newStatus).toBe('COMPLETED');
      expect(result.amount).toBe(100);
      expect(paymentRepository.findById).toHaveBeenCalledWith(paymentId);
    });

    it('should include context data', async () => {
      jest.spyOn(paymentRepository, 'findById').mockResolvedValueOnce(testPayment);
      jest.spyOn(paymentLedgerRepository, 'create').mockResolvedValueOnce({});

      const context = {
        userId: 'admin123',
        actorType: 'ADMIN',
        reason: 'Manual approval',
        transactionId: 'txn_123',
        providerResponse: { status: 'success' },
      };

      await paymentLedgerService.logPaymentChange(
        paymentId,
        'PENDING',
        'COMPLETED',
        context
      );

      expect(paymentLedgerRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: 'admin123',
          actorType: 'ADMIN',
          reason: 'Manual approval',
          transactionId: 'txn_123',
          providerResponse: { status: 'success' },
        }),
        expect.any(Object)
      );
    });

    it('should throw 404 if payment not found', async () => {
      jest.spyOn(paymentRepository, 'findById').mockResolvedValueOnce(null);

      await expect(
        paymentLedgerService.logPaymentChange(paymentId, 'PENDING', 'COMPLETED')
      ).rejects.toThrow('Payment not found');
    });
  });

  describe('getPaymentHistory()', () => {
    it('should retrieve payment history sorted by timestamp', async () => {
      const mockHistory = [
        {
          _id: 'ledger3',
          oldStatus: 'PROCESSING',
          newStatus: 'COMPLETED',
          timestamp: new Date('2024-01-03'),
        },
        {
          _id: 'ledger2',
          oldStatus: 'PENDING',
          newStatus: 'PROCESSING',
          timestamp: new Date('2024-01-02'),
        },
        {
          _id: 'ledger1',
          oldStatus: 'UNKNOWN',
          newStatus: 'PENDING',
          timestamp: new Date('2024-01-01'),
        },
      ];

      jest.spyOn(paymentLedgerRepository, 'find').mockResolvedValueOnce(mockHistory);

      const result = await paymentLedgerService.getPaymentHistory(paymentId);

      expect(result).toHaveLength(3);
      expect(paymentLedgerRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: { paymentId },
          sort: { timestamp: -1 },
        })
      );
    });

    it('should support pagination', async () => {
      jest.spyOn(paymentLedgerRepository, 'find').mockResolvedValueOnce([]);

      await paymentLedgerService.getPaymentHistory(paymentId, {
        limit: 25,
        offset: 50,
      });

      expect(paymentLedgerRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 25, offset: 50 })
      );
    });
  });

  describe('getOrderPaymentHistory()', () => {
    it('should get payment history for order', async () => {
      const mockHistory = [
        { oldStatus: 'PENDING', newStatus: 'COMPLETED' },
      ];

      jest.spyOn(paymentLedgerRepository, 'find').mockResolvedValueOnce(mockHistory);

      const result = await paymentLedgerService.getOrderPaymentHistory(orderId);

      expect(result).toHaveLength(1);
      expect(paymentLedgerRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ filter: { orderId } })
      );
    });
  });

  describe('auditPayment()', () => {
    it('should verify payment integrity', async () => {
      jest.spyOn(paymentRepository, 'findById').mockResolvedValueOnce({
        ...testPayment,
        status: 'COMPLETED',
      });

      const mockLedger = [
        {
          paymentId,
          oldStatus: 'PENDING',
          newStatus: 'COMPLETED',
          amount: 100,
        },
      ];

      jest.spyOn(paymentLedgerService, 'getPaymentHistory').mockResolvedValueOnce(mockLedger);

      const result = await paymentLedgerService.auditPayment(paymentId);

      expect(result.verified).toBe(true);
      expect(result.statusMatches).toBe(true);
      expect(result.amountsConsistent).toBe(true);
      expect(result.issues).toEqual([]);
    });

    it('should detect status mismatch', async () => {
      jest.spyOn(paymentRepository, 'findById').mockResolvedValueOnce({
        ...testPayment,
        status: 'COMPLETED',
      });

      const mockLedger = [
        { oldStatus: 'PENDING', newStatus: 'FAILED', amount: 100 },
      ];

      jest.spyOn(paymentLedgerService, 'getPaymentHistory').mockResolvedValueOnce(mockLedger);

      const result = await paymentLedgerService.auditPayment(paymentId);

      expect(result.verified).toBe(false);
      expect(result.statusMatches).toBe(false);
      expect(result.issues).toContain('Status mismatch between payment and ledger');
    });

    it('should detect amount variance', async () => {
      jest.spyOn(paymentRepository, 'findById').mockResolvedValueOnce({
        ...testPayment,
        amount: 100,
      });

      const mockLedger = [
        { oldStatus: 'PENDING', newStatus: 'COMPLETED', amount: 100 },
        { oldStatus: 'COMPLETED', newStatus: 'COMPLETED', amount: 150 }, // Different amount
      ];

      jest.spyOn(paymentLedgerService, 'getPaymentHistory').mockResolvedValueOnce(mockLedger);

      const result = await paymentLedgerService.auditPayment(paymentId);

      expect(result.amountsConsistent).toBe(false);
      expect(result.issues).toContain('Amount variance in ledger');
    });

    it('should throw 404 if payment not found', async () => {
      jest.spyOn(paymentRepository, 'findById').mockResolvedValueOnce(null);

      await expect(paymentLedgerService.auditPayment(paymentId)).rejects.toThrow(
        'Payment not found'
      );
    });
  });

  describe('getFailedPayments()', () => {
    it('should retrieve failed payments from last 7 days by default', async () => {
      const mockFailed = [
        { _id: 'ledger1', newStatus: 'FAILED', amount: 100 },
        { _id: 'ledger2', newStatus: 'FAILED', amount: 50 },
      ];

      jest.spyOn(paymentLedgerRepository, 'find').mockResolvedValueOnce(mockFailed);

      const result = await paymentLedgerService.getFailedPayments();

      expect(result).toHaveLength(2);
      expect(paymentLedgerRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: expect.objectContaining({ newStatus: 'FAILED' }),
        })
      );
    });

    it('should support custom period', async () => {
      jest.spyOn(paymentLedgerRepository, 'find').mockResolvedValueOnce([]);

      await paymentLedgerService.getFailedPayments({ days: 30 });

      expect(paymentLedgerRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: expect.objectContaining({ newStatus: 'FAILED' }),
        })
      );
    });
  });

  describe('getLedgerStats()', () => {
    it('should calculate statistics for period', async () => {
      const mockTransitions = [
        { newStatus: 'COMPLETED', amount: 100, actorType: 'SYSTEM' },
        { newStatus: 'COMPLETED', amount: 200, actorType: 'SYSTEM' },
        { newStatus: 'FAILED', amount: 50, actorType: 'ADMIN' },
      ];

      jest.spyOn(paymentLedgerService, 'getPaymentTransitionsByPeriod')
        .mockResolvedValueOnce(mockTransitions);

      const result = await paymentLedgerService.getLedgerStats({});

      expect(result.totalTransitions).toBe(3);
      expect(result.totalAmount).toBe(350);
      expect(result.byStatus.COMPLETED).toBe(2);
      expect(result.byStatus.FAILED).toBe(1);
      expect(result.byActor.SYSTEM).toBe(2);
      expect(result.byActor.ADMIN).toBe(1);
    });
  });
});
