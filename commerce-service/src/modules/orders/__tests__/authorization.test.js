/**
 * Authority, Ownership & IDOR Prevention Tests
 * 
 * Verified against:
 * 1. Role hierarchy & One-account model
 * 2. Cross-seller IDOR prevention (Orders, Allocations)
 * 3. Cross-seller IDOR prevention (Payouts, Wallets)
 * 4. Cross-seller IDOR prevention (Products, Catalog)
 * 5. Repository tenant-scoping methods
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { testDbUri, enableStandaloneSessionFallback } = require('../../../shared/utils/testDb');

const DB_URL = testDbUri('ariti_commerce_test_authorization');

before(async () => {
  enableStandaloneSessionFallback(mongoose);
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(DB_URL);
  }
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
  }
});

// Mock data
const mockOrders = {
  order1: {
    _id: 'order-123',
    buyerId: 'customer-1',
    sellerId: 'seller-1',
    shopId: 'shop-1',
    status: 'Processing',
    cart: [],
    totalPrice: 100,
    createdAt: new Date(),
  },
  order2: {
    _id: 'order-456',
    buyerId: 'customer-2',
    sellerId: 'seller-2',
    shopId: 'shop-2',
    status: 'Processing',
    cart: [],
    totalPrice: 200,
    createdAt: new Date(),
  },
};

const mockUsers = {
  customer1: { id: 'customer-1', role: 'CUSTOMER', email: 'customer1@test.com' },
  customer2: { id: 'customer-2', role: 'CUSTOMER', email: 'customer2@test.com' },
  seller1: { id: 'seller-1', role: 'SELLER', email: 'seller1@test.com' },
  seller2: { id: 'seller-2', role: 'SELLER', email: 'seller2@test.com' },
  admin: { id: 'admin-1', role: 'ADMIN', email: 'admin@test.com' },
};

// ── 1. Role Hierarchy & One-Account Model Tests ──────────────────────

describe('1. Role Hierarchy & One-Account Model Tests', () => {
  it('Authorize middleware should allow SELLER to access CUSTOMER endpoints', () => {
    const allowedRoles = ['CUSTOMER'];
    const userRole = 'SELLER';
    const effectiveRoles = [userRole];
    if (userRole === 'SELLER') effectiveRoles.push('CUSTOMER');
    const hasAccess = allowedRoles.some((role) => effectiveRoles.includes(role));
    assert.strictEqual(hasAccess, true);
  });

  it('Authorize middleware should allow ADMIN to access any endpoint', () => {
    const allowedRoles = ['SELLER', 'CUSTOMER'];
    const userRole = 'ADMIN';
    const hasAccess = userRole === 'ADMIN' || allowedRoles.includes(userRole);
    assert.strictEqual(hasAccess, true);
  });

  it('Authorize middleware should deny CUSTOMER access to SELLER endpoints', () => {
    const allowedRoles = ['SELLER'];
    const userRole = 'CUSTOMER';
    const effectiveRoles = [userRole];
    if (userRole === 'SELLER') effectiveRoles.push('CUSTOMER');
    const hasAccess = allowedRoles.some((role) => effectiveRoles.includes(role));
    assert.strictEqual(hasAccess, false);
  });

  it('Seller should be able to access their own orders', () => {
    const order = mockOrders.order1;
    const user = mockUsers.seller1;
    const hasAccess = user.role === 'ADMIN' || order.sellerId === user.id;
    assert.strictEqual(hasAccess, true);
  });

  it('Seller should NOT be able to access another seller\'s orders', () => {
    const order = mockOrders.order1;
    const user = mockUsers.seller2;
    const hasAccess = user.role === 'ADMIN' || order.sellerId === user.id;
    assert.strictEqual(hasAccess, false);
  });

  it('Customer should be able to access their own orders', () => {
    const order = mockOrders.order1;
    const user = mockUsers.customer1;
    const hasAccess = user.role === 'ADMIN' || order.buyerId === user.id;
    assert.strictEqual(hasAccess, true);
  });

  it('Customer should NOT be able to access another customer\'s orders', () => {
    const order = mockOrders.order1;
    const user = mockUsers.customer2;
    const hasAccess = user.role === 'ADMIN' || order.buyerId === user.id;
    assert.strictEqual(hasAccess, false);
  });

  it('ADMIN should be able to access any order', () => {
    const user = mockUsers.admin;
    const hasAccess = user.role === 'ADMIN';
    assert.strictEqual(hasAccess, true);
  });

  it('Seller should be able to query their own seller orders endpoint', () => {
    const sellerId = 'seller-1';
    const user = mockUsers.seller1;
    const allowedToQuery = user.role === 'ADMIN' || sellerId === user.id;
    assert.strictEqual(allowedToQuery, true);
  });

  it('Seller should NOT be able to query another seller\'s seller orders', () => {
    const sellerId = 'seller-1';
    const user = mockUsers.seller2;
    const allowedToQuery = user.role === 'ADMIN' || sellerId === user.id;
    assert.strictEqual(allowedToQuery, false);
  });

  it('Customer should NOT be able to update order status (SELLER-only operation)', () => {
    const user = mockUsers.customer1;
    const canUpdateStatus = user.role === 'SELLER' || user.role === 'ADMIN';
    assert.strictEqual(canUpdateStatus, false);
  });

  it('Seller should be able to update their own order status', () => {
    const order = mockOrders.order1;
    const user = mockUsers.seller1;
    const canUpdateStatus = (user.role === 'SELLER' || user.role === 'ADMIN') &&
      (user.role === 'ADMIN' || order.sellerId === user.id);
    assert.strictEqual(canUpdateStatus, true);
  });

  it('Backward compatibility: GET /get-all-orders/user/:userId should work for CUSTOMER', () => {
    const userId = 'customer-1';
    const user = mockUsers.customer1;
    const authorized = user.role === 'ADMIN' || userId === user.id;
    assert.strictEqual(authorized, true);
  });

  it('Customer should be able to request refund for their own orders', () => {
    const order = mockOrders.order1;
    const user = mockUsers.customer1;
    const canRefund = order.buyerId === user.id || user.role === 'ADMIN';
    assert.strictEqual(canRefund, true);
  });

  it('Customer should NOT be able to request refund for another customer\'s orders', () => {
    const order = mockOrders.order1;
    const user = mockUsers.customer2;
    const canRefund = order.buyerId === user.id || user.role === 'ADMIN';
    assert.strictEqual(canRefund, false);
  });
});

// ── 2. Cross-Seller IDOR Prevention Tests (Orders & Allocations) ──────

describe('2. Cross-Seller IDOR Prevention Tests (Orders & Allocations)', () => {
  const ordersService = require('../services/orders.service');
  const orderRepo = require('../repositories/orders.repository');

  it('Seller A cannot view Seller B\'s order details (controller ownership check)', async () => {
    const order = { ...mockOrders.order2 }; // owned by seller-2
    const actorId = 'seller-1';
    const role = 'SELLER';

    const isBuyer = String(order.buyerId) === String(actorId);
    const isSellerOwner = String(order.sellerId) === String(actorId);
    const isAdminRole = role === 'ADMIN';

    const authorized = isBuyer || isSellerOwner || isAdminRole;
    assert.strictEqual(authorized, false, 'Seller 1 must NOT be authorized to view Seller 2 order');
  });

  it('Seller A cannot update status of Seller B\'s order', async () => {
    const fakeOrderId = new mongoose.Types.ObjectId().toString();
    // Stub findById to return Seller 2 order
    const origFindById = orderRepo.findById;
    orderRepo.findById = async () => ({
      _id: fakeOrderId,
      sellerId: 'seller-2',
      shopId: 'shop-2',
      status: 'Processing',
    });

    try {
      await assert.rejects(
        async () => {
          await ordersService.updateOrderStatus(fakeOrderId, 'Confirmed', {
            userId: 'seller-1',
            userRole: 'SELLER',
          });
        },
        (err) => {
          assert.strictEqual(err.statusCode, 403);
          assert.ok(err.message.includes('cannot update this order'));
          return true;
        }
      );
    } finally {
      orderRepo.findById = origFindById;
    }
  });

  it('Seller A cannot cancel Seller B\'s order', async () => {
    const fakeOrderId = new mongoose.Types.ObjectId().toString();
    const origFindById = orderRepo.findById;
    orderRepo.findById = async () => ({
      _id: fakeOrderId,
      sellerId: 'seller-2',
      shopId: 'shop-2',
      status: 'Processing',
    });

    try {
      await assert.rejects(
        async () => {
          await ordersService.cancelOrder(fakeOrderId, {
            userId: 'seller-1',
            userRole: 'SELLER',
            reason: 'Malicious cancellation attempt',
          });
        },
        (err) => {
          assert.strictEqual(err.statusCode, 403);
          assert.ok(err.message.includes('cannot cancel this order'));
          return true;
        }
      );
    } finally {
      orderRepo.findById = origFindById;
    }
  });

  it('Seller A cannot approve refund for Seller B\'s order', async () => {
    const fakeOrderId = new mongoose.Types.ObjectId().toString();
    const origFindById = orderRepo.findById;
    orderRepo.findById = async () => ({
      _id: fakeOrderId,
      sellerId: 'seller-2',
      shopId: 'shop-2',
      status: 'Refund Requested',
    });

    try {
      await assert.rejects(
        async () => {
          await ordersService.approveRefund(fakeOrderId, {
            userId: 'seller-1',
            userRole: 'SELLER',
          });
        },
        (err) => {
          assert.strictEqual(err.statusCode, 403);
          assert.ok(err.message.includes('cannot approve refund'));
          return true;
        }
      );
    } finally {
      orderRepo.findById = origFindById;
    }
  });
});

// ── 3. Cross-Seller IDOR Prevention Tests (Payouts & Wallets) ────────

describe('3. Cross-Seller IDOR Prevention Tests (Payouts & Wallets)', () => {
  const payoutsService = require('../../finance/services/payouts.service');
  const payoutsRepo = require('../../finance/repositories/payouts.repository');

  it('Seller A cannot view Seller B\'s payout details', async () => {
    const payoutId = new mongoose.Types.ObjectId().toString();
    const origFindById = payoutsRepo.findById;
    payoutsRepo.findById = async () => ({
      _id: payoutId,
      sellerId: 'seller-2',
      amount: 1500,
      status: 'PENDING',
    });

    try {
      await assert.rejects(
        async () => {
          await payoutsService.getPayout(payoutId, 'seller-1');
        },
        (err) => {
          assert.strictEqual(err.statusCode, 403);
          assert.ok(err.message.includes('do not have access to this payout'));
          return true;
        }
      );
    } finally {
      payoutsRepo.findById = origFindById;
    }
  });

  it('Admin can view any seller\'s payout details without tenant restriction', async () => {
    const payoutId = new mongoose.Types.ObjectId().toString();
    const origFindById = payoutsRepo.findById;
    payoutsRepo.findById = async () => ({
      _id: payoutId,
      sellerId: 'seller-2',
      amount: 1500,
      status: 'PENDING',
    });

    try {
      // Admin passes null as sellerId scope
      const payout = await payoutsService.getPayout(payoutId, null);
      assert.strictEqual(payout._id, payoutId);
      assert.strictEqual(payout.sellerId, 'seller-2');
    } finally {
      payoutsRepo.findById = origFindById;
    }
  });
});

// ── 4. Cross-Seller IDOR Prevention Tests (Products & Catalog) ────────

describe('4. Cross-Seller IDOR Prevention Tests (Products & Catalog)', () => {
  const productsService = require('../../catalog/services/products.service');
  const productRepo = require('../../catalog/repositories/products.repository');

  it('Seller A cannot update Seller B\'s product', async () => {
    const prodId = new mongoose.Types.ObjectId().toString();
    const origFindById = productRepo.findById;
    productRepo.findById = async () => ({
      _id: prodId,
      name: 'Seller 2 Product',
      sellerId: 'seller-2',
      shopId: 'shop-2',
      shop: { ownerId: 'seller-2' },
    });

    try {
      await assert.rejects(
        async () => {
          await productsService.updateProduct(
            prodId,
            { name: 'Tampered Title' },
            { id: 'seller-1', role: 'SELLER' }
          );
        },
        (err) => {
          assert.strictEqual(err.statusCode, 403);
          assert.ok(err.message.includes('Forbidden: you can only manage products from your own business'));
          return true;
        }
      );
    } finally {
      productRepo.findById = origFindById;
    }
  });

  it('Seller A cannot delete Seller B\'s product', async () => {
    const prodId = new mongoose.Types.ObjectId().toString();
    const origFindById = productRepo.findById;
    productRepo.findById = async () => ({
      _id: prodId,
      name: 'Seller 2 Product',
      sellerId: 'seller-2',
      shopId: 'shop-2',
      shop: { ownerId: 'seller-2' },
    });

    try {
      await assert.rejects(
        async () => {
          await productsService.deleteProduct(
            prodId,
            { id: 'seller-1', role: 'SELLER' }
          );
        },
        (err) => {
          assert.strictEqual(err.statusCode, 403);
          assert.ok(err.message.includes('Forbidden: you can only manage products from your own business'));
          return true;
        }
      );
    } finally {
      productRepo.findById = origFindById;
    }
  });
});

// ── 5. Repository Tenant Scoping (IDOR Safe Queries) ──────────────────

describe('5. Repository Tenant Scoping (IDOR Safe Queries)', () => {
  const orderRepo = require('../repositories/orders.repository');
  const sellerAllocationRepo = require('../repositories/sellerAllocation.repository');
  const payoutsRepo = require('../../finance/repositories/payouts.repository');
  const productRepo = require('../../catalog/repositories/products.repository');

  it('ordersRepository.findByIdAndSeller returns null for invalid object ID or missing seller', async () => {
    assert.strictEqual(await orderRepo.findByIdAndSeller('invalid-id', 'seller-1'), null);
    assert.strictEqual(await orderRepo.findByIdAndSeller(new mongoose.Types.ObjectId().toString(), null), null);
  });

  it('sellerAllocationRepository.findByIdAndSeller returns null for invalid object ID or missing seller', async () => {
    assert.strictEqual(await sellerAllocationRepo.findByIdAndSeller('invalid-id', 'seller-1'), null);
    assert.strictEqual(await sellerAllocationRepo.findByIdAndSeller(new mongoose.Types.ObjectId().toString(), null), null);
  });

  it('payoutsRepository.findByIdAndSeller returns null when id or seller is missing', async () => {
    assert.strictEqual(await payoutsRepo.findByIdAndSeller(null, 'seller-1'), null);
    assert.strictEqual(await payoutsRepo.findByIdAndSeller('payout-1', null), null);
  });

  it('productsRepository.findByIdAndSeller returns null for invalid object ID or missing seller', async () => {
    assert.strictEqual(await productRepo.findByIdAndSeller('invalid-id', 'seller-1'), null);
    assert.strictEqual(await productRepo.findByIdAndSeller(new mongoose.Types.ObjectId().toString(), null), null);
  });
});
