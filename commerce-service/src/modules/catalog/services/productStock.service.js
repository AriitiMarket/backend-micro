'use strict';

/**
 * Product Stock Service
 * Handles restock, stock adjustment with reserve guards, and stock movement history.
 */

const productRepository = require('../repositories/products.repository');
const stockMovementRepository = require('../repositories/stockMovements.repository');
const shopRepository = require('../../selling/repositories/shops.repository');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

function assertStockNotBelowReserved(nextStock, reserved = 0) {
  const reservedNow = Number(reserved) || 0;
  if (Number(nextStock) < reservedNow) {
    throw new ApiError(
      `Stock cannot be lower than the ${reservedNow} unit(s) currently reserved for open orders`,
      400
    );
  }
}

class ProductStockService {
  async assertOwnership(product, requester) {
    if (!requester) throw new ApiError('Authentication required', 401);
    if (requester.role === 'ADMIN' || (Array.isArray(requester.capabilities) && requester.capabilities.includes('ADMIN'))) {
      return;
    }
    const shop = product.shopId ? await shopRepository.findById(product.shopId) : null;
    if (shop) {
      const isOwner =
        String(shop.ownerId) === String(requester.id) ||
        (requester.shopId && String(shop._id) === String(requester.shopId));
      if (!isOwner) throw new ApiError('Forbidden: you can only manage products from your own business', 403);
      return;
    }

    const snapshotOwner = product.shop && product.shop.ownerId ? String(product.shop.ownerId) : null;
    const isOwner =
      (product.sellerId && String(product.sellerId) === String(requester.id)) ||
      (snapshotOwner === String(requester.id));
    if (!isOwner) throw new ApiError('Forbidden: you can only manage products from your own business', 403);
  }

  async restockProduct(id, quantity, note, requester) {
    const product = await productRepository.findById(id);
    if (!product) throw new ApiError('Product not found', 404);
    await this.assertOwnership(product, requester);

    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty <= 0) throw new ApiError('Quantity must be a positive whole number', 400);

    const stockBefore = product.stock || 0;
    const updated = await productRepository.updateStock(id, qty);

    await stockMovementRepository.create({
      productId: id,
      shopId: product.shopId,
      sellerId: product.sellerId,
      type: 'restock',
      quantity: qty,
      stockBefore,
      stockAfter: updated.stock,
      note: note || `Restocked ${qty} units`,
    });

    return updated;
  }

  async adjustStock(id, newQuantity, note, requester) {
    const product = await productRepository.findById(id);
    if (!product) throw new ApiError('Product not found', 404);
    await this.assertOwnership(product, requester);

    const target = Number(newQuantity);
    if (!Number.isFinite(target) || target < 0 || !Number.isInteger(target)) {
      throw new ApiError('Stock must be a whole number greater than or equal to 0', 400);
    }
    assertStockNotBelowReserved(target, product.reserved);

    const stockBefore = product.stock || 0;
    const delta = target - stockBefore;
    if (delta === 0) return product;

    const updated = await productRepository.updateStock(id, delta);

    await stockMovementRepository.create({
      productId: id,
      shopId: product.shopId,
      sellerId: product.sellerId,
      type: 'adjustment',
      quantity: delta,
      stockBefore,
      stockAfter: updated.stock,
      note: note || `Adjusted from ${stockBefore} to ${target}`,
    });

    return updated;
  }

  async getStockHistory(id, limit = 50, requester = null) {
    const product = await productRepository.findById(id);
    if (!product) throw new ApiError('Product not found', 404);
    await this.assertOwnership(product, requester);
    const movements = await stockMovementRepository.findByProduct(id, limit);
    return movements;
  }
}

module.exports = new ProductStockService();
module.exports.assertStockNotBelowReserved = assertStockNotBelowReserved;
