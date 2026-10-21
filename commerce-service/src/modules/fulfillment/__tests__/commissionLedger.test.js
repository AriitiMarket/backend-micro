const test = require('node:test');
const assert = require('node:assert');
const commissionLedgerService = require('../services/commissionLedger.service');
const commissionLedgerRepository = require('../repositories/commissionLedger.repository');
const allocationRepository = require('../repositories/sellerAllocation.repository');
const settingsService = require('../../platform/services/settings.service');

test('CommissionLedgerService', async t => {
  const orderId = 'order123';
  const sellerId = 'seller123';

  const testCommissionData = {
    grossSubtotal: 1000,
    shippingFee: 50,
    taxAmount: 100,
    discountAmount: 50,
    commissionRate: 10,
    platformCommission: 100,
    netPayable: 900,
    allocationId: 'alloc123',
    reason: 'ORDER_CONFIRMED',
  };

  // Mock settingsService so resolveCommissionRate succeeds in tests
  settingsService.getPlatformSettings = () => Promise.resolve({
    commissionRate: 10,
    sellerCommissionVariations: [],
    categoryCommissions: [],
  });

  await t.test('logCommission logs commission calculation', async () => {
    const mockEntry = {
      _id: 'ledger123',
      orderId,
      sellerId,
      ...testCommissionData,
      timestamp: new Date(),
    };

    commissionLedgerRepository.create = () => Promise.resolve(mockEntry);

    const result = await commissionLedgerService.logCommission(
      orderId,
      sellerId,
      testCommissionData
    );

    assert.strictEqual(result.grossSubtotal, 1000);
    assert.strictEqual(result.platformCommission, 100);
    assert.strictEqual(result.netPayable, 900);
    assert.strictEqual(result.commissionRate, 10);
    assert.ok(result.timestamp);
  });

  await t.test('getCommissionHistory retrieves history for seller', async () => {
    const mockHistory = [
      { _id: 'ledger1', orderId: 'order1', platformCommission: 100, timestamp: new Date('2024-01-03') },
      { _id: 'ledger2', orderId: 'order2', platformCommission: 150, timestamp: new Date('2024-01-02') },
    ];

    commissionLedgerRepository.find = () => Promise.resolve(mockHistory);

    const result = await commissionLedgerService.getCommissionHistory(sellerId);
    assert.strictEqual(result.length, 2);
  });

  await t.test('getTotalCommissionForPeriod calculates totals', async () => {
    const mockEntries = [
      { orderId: 'order1', grossSubtotal: 1000, platformCommission: 100, netPayable: 900 },
      { orderId: 'order2', grossSubtotal: 2000, platformCommission: 200, netPayable: 1800 },
    ];

    commissionLedgerRepository.find = () => Promise.resolve(mockEntries);

    const result = await commissionLedgerService.getTotalCommissionForPeriod(sellerId);
    assert.strictEqual(result.totalCommission, 300);
    assert.strictEqual(result.totalGrossRevenue, 3000);
    assert.strictEqual(result.totalNetPayable, 2700);
    assert.strictEqual(result.orderCount, 2);
    assert.strictEqual(result.averageCommissionRate, 10);
  });

  await t.test('getTotalCommissionForPeriod returns zeros if no entries', async () => {
    commissionLedgerRepository.find = () => Promise.resolve([]);

    const result = await commissionLedgerService.getTotalCommissionForPeriod(sellerId);
    assert.strictEqual(result.totalCommission, 0);
    assert.strictEqual(result.orderCount, 0);
    assert.strictEqual(result.averageCommissionRate, 0);
  });

  await t.test('auditCommissions verifies commission integrity', async () => {
    const mockLedger = [
      { orderId: 'order1', platformCommission: 100 },
      { orderId: 'order2', platformCommission: 200 },
    ];

    const origGetHistory = commissionLedgerService.getCommissionHistory;
    commissionLedgerService.getCommissionHistory = () => Promise.resolve(mockLedger);

    const mockAllocations = [
      { orderId: 'order1' },
      { orderId: 'order2' },
    ];
    allocationRepository.find = () => Promise.resolve(mockAllocations);

    const origGetTotal = commissionLedgerService.getTotalCommissionForPeriod;
    commissionLedgerService.getTotalCommissionForPeriod = () => Promise.resolve({
      totalCommission: 300,
      totalGrossRevenue: 3000,
      orderCount: 2,
    });

    const result = await commissionLedgerService.auditCommissions(sellerId);
    assert.strictEqual(result.verified, true);
    assert.strictEqual(result.ledgerEntryCount, 2);
    assert.strictEqual(result.allocationCount, 2);
    assert.deepStrictEqual(result.issues, []);

    commissionLedgerService.getCommissionHistory = origGetHistory;
    commissionLedgerService.getTotalCommissionForPeriod = origGetTotal;
  });

  await t.test('auditCommissions detects missing ledger entries', async () => {
    const mockLedger = [{ orderId: 'order1' }];

    const origGetHistory = commissionLedgerService.getCommissionHistory;
    commissionLedgerService.getCommissionHistory = () => Promise.resolve(mockLedger);

    const mockAllocations = [
      { orderId: 'order1' },
      { orderId: 'order2' },
    ];
    allocationRepository.find = () => Promise.resolve(mockAllocations);

    const origGetTotal = commissionLedgerService.getTotalCommissionForPeriod;
    commissionLedgerService.getTotalCommissionForPeriod = () => Promise.resolve({});

    const result = await commissionLedgerService.auditCommissions(sellerId);
    assert.strictEqual(result.verified, false);
    assert.ok(result.issues.includes('1 allocations missing from ledger'));

    commissionLedgerService.getCommissionHistory = origGetHistory;
    commissionLedgerService.getTotalCommissionForPeriod = origGetTotal;
  });

  await t.test('getCommissionByReason breakdowns commission by reason', async () => {
    const mockEntries = [
      { reason: 'ORDER_CONFIRMED', platformCommission: 100 },
      { reason: 'ORDER_CONFIRMED', platformCommission: 150 },
      { reason: 'MANUAL_ADJUSTMENT', platformCommission: 50 },
    ];

    const origGetHistory = commissionLedgerService.getCommissionHistory;
    commissionLedgerService.getCommissionHistory = () => Promise.resolve(mockEntries);

    const result = await commissionLedgerService.getCommissionByReason(sellerId);
    assert.strictEqual(result.ORDER_CONFIRMED.count, 2);
    assert.strictEqual(result.ORDER_CONFIRMED.totalCommission, 250);
    assert.strictEqual(result.MANUAL_ADJUSTMENT.count, 1);
    assert.strictEqual(result.MANUAL_ADJUSTMENT.totalCommission, 50);

    commissionLedgerService.getCommissionHistory = origGetHistory;
  });
});
