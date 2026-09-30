const mongoose = require('mongoose');
const orderRepository = require('../repositories/orders.repository');
const productRepository = require('../../catalog/repositories/products.repository');
const stockMovementRepository = require('../../catalog/repositories/stockMovements.repository');
const orderDeliveryService = require('./orderDelivery.service');
const shopRepository = require('../../selling/repositories/shops.repository');
const { deliveryClient } = require('../../../app/clients/delivery.client');
const { ORDER_STATUSES, normalizeStatus, canTransition } = require('../constants/orderStatuses');
const { isProductPubliclyVisible } = require('../../../shared/utils/productVisibility');
const { normalizeRole } = require('../../../shared/utils/roles');

class ApiError extends Error { constructor(message, statusCode) { super(message); this.statusCode = statusCode; } }

/**
 * Publicly-orderable check shared by order creation: a product must pass ALL
 * admin-curated public gates — the kill-switch (isActive), the seller
 * lifecycle (status PUBLISHED, or absent on legacy documents), the shop's
 * `showOnPublic` allow, the shop's operational status (approved/active), an
 * active product category, and at least one available unit (stock − reserved
 * > 0). Drafts, deactivated products, finished stock, products of a shop the
 * admin removed from the public view, and products of a rejected/suspended
 * seller can never be ordered — even if a client holds a stale id.
 *
 * The rule lives in shared/utils/productVisibility so the storefront, the
 * catalog lists and this path can never drift apart again.
 */
async function assertOrderable(product) {
  if (!(await isProductPubliclyVisible(product))) {
    throw new ApiError(`Product "${product.name}" is no longer available`, 400);
  }
}

/**
 * Quantity for an INCOMING order line — strict.
 *
 * The client must send a whole number >= 1. `lineQty` below stays the
 * lenient reader for HISTORICAL rows, but using it on new input meant the
 * server invented a quantity for nonsense values (0, -5, "abc" were all stored
 * as 1, so a caller could "order" anything and receive a real, reserved order).
 */
function parseOrderQuantity(raw, label) {
  if (raw === undefined || raw === null || raw === '') {
    throw new ApiError(`Quantity is required for "${label}"`, 400);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ApiError(`Quantity for "${label}" must be a number`, 400);
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new ApiError(`Quantity for "${label}" must be a whole number of 1 or more`, 400);
  }
  return value;
}

/**
 * Canonical per-line quantity. Frontend writes `quantity`; legacy carts and
 * seeds may still carry `qty`. Never trust a non-numeric/zero client value —
 * fall back to 1 so stock math cannot go negative or become NaN.
 */
function lineQty(item) {
  const raw = item && item.quantity !== undefined && item.quantity !== null
    ? item.quantity
    : item && item.qty;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

/** Shipping rule shared with the checkout UI: 3% of subtotal, 2dp. */
function computeShipping(subtotal) {
  return Math.round(subtotal * 0.03 * 100) / 100;
}

class OrderService {
  async validateOrderOwnership(orderId, userId, userRole) {
    const order = await orderRepository.findById(orderId);
    if (!order) throw new ApiError('Order not found', 404);
    const role = normalizeRole(userRole);
    if (role === 'ADMIN') return order;
    if (role === 'SELLER') {
      if (order.sellerId !== userId) throw new ApiError('Forbidden: you can only access your own orders', 403);
      return order;
    }
    if (role === 'BUYER') {
      if (order.buyerId !== userId) throw new ApiError('Forbidden: you can only access your own orders', 403);
      return order;
    }
    throw new ApiError('Forbidden: invalid role', 403);
  }

  async validateSellerOwnership(sellerId, requestingUserId, requestingUserRole) {
    const role = normalizeRole(requestingUserRole);
    if (role === 'ADMIN') return;
    if (role !== 'SELLER') throw new ApiError('Forbidden: only sellers can query seller orders', 403);
    if (sellerId === requestingUserId) return; // the seller's own identity id

    // The seller UI passes the SHOP id (it manages orders per shop). Accept it
    // only when the requesting seller actually owns that shop — the query then
    // scopes to exactly that shop's orders.
    if (sellerId && mongoose.isValidObjectId(sellerId)) {
      const shop = await shopRepository.findById(sellerId);
      if (shop && String(shop.ownerId) === String(requestingUserId)) return;
    }
    throw new ApiError('Forbidden: you can only access your own seller orders', 403);
  }

  /**
   * Resolve a location ID to its full hierarchy path (region/area/sector) by
   * calling the Delivery Service's location endpoint.
   */
  async _resolveLocationHierarchy(locationId) {
    if (!locationId) return null;
    try {
      const locResult = await deliveryClient.getLocation(String(locationId));
      if (!locResult.body || !locResult.body.location) return null;
      const location = locResult.body.location;

      // Get ancestors to build the full path
      const ancestorsResult = await deliveryClient.getChildren(String(locationId));
      // We need to walk up the tree — use getLocation which returns the document,
      // then try to get the hierarchy path from the location data itself
      // The delivery service location has parentId; we'll fetch ancestors from hierarchy
      const hierarchyResult = await deliveryClient.getLocationHierarchy();
      const hierarchy = hierarchyResult.body && hierarchyResult.body.hierarchy ? hierarchyResult.body.hierarchy : [];

      // Walk the hierarchy tree to find this location's full path
      const path = this._findLocationPath(hierarchy, String(locationId));
      if (path) return path;

      // Fallback: at minimum return the location itself
      return {
        regionId: null, regionName: '',
        areaId: null, areaName: '',
        cityId: null, cityName: '',
        sectorId: location.type === 'sector' ? String(location._id) : null,
        sectorName: location.type === 'sector' ? location.name : '',
      };
    } catch (err) {
      console.error(`[order] Failed to resolve location hierarchy for ${locationId}:`, err.message);
      return null;
    }
  }

  /**
   * Walk a hierarchy tree to find the full path to a target location ID.
   */
  _findLocationPath(tree, targetId) {
    for (const node of tree) {
      const result = this._findInNode(node, targetId, []);
      if (result) return result;
    }
    return null;
  }

  _findInNode(node, targetId, ancestors) {
    const currentPath = [...ancestors, { id: String(node._id), name: node.name, type: node.type }];
    if (String(node._id) === targetId) {
      // Build the hierarchy from the path
      const result = {
        regionId: null, regionName: '',
        areaId: null, areaName: '',
        cityId: null, cityName: '',
        sectorId: null, sectorName: '',
      };
      for (const step of currentPath) {
        if (step.type === 'region') { result.regionId = step.id; result.regionName = step.name; }
        else if (step.type === 'area') { result.areaId = step.id; result.areaName = step.name; }
        else if (step.type === 'city') { result.cityId = step.id; result.cityName = step.name; }
        else if (step.type === 'sector') { result.sectorId = step.id; result.sectorName = step.name; }
        else if (step.type === 'community') { result.sectorId = step.id; result.sectorName = step.name; }
      }
      return result;
    }
    if (node.children && node.children.length > 0) {
      for (const child of node.children) {
        const found = this._findInNode(child, targetId, currentPath);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Build the destination snapshot from the customer-provided location data.
   * Accepts either pre-resolved IDs from the request body or resolves from hierarchy.
   */
  async _buildDestinationSnapshot(destination) {
    const snapshot = {
      regionId: destination.regionId || null,
      regionName: destination.regionName || '',
      areaId: destination.areaId || null,
      areaName: destination.areaName || '',
      cityId: destination.cityId || null,
      cityName: destination.cityName || '',
      sectorId: destination.sectorId || null,
      sectorName: destination.sectorName || '',
      fullAddress: destination.fullAddress || '',
      landmark: destination.landmark || '',
      building: destination.building || '',
      phone: destination.phone || '',
      additionalInstructions: destination.additionalInstructions || '',
      coordinates: {
        latitude: destination.coordinates?.latitude || null,
        longitude: destination.coordinates?.longitude || null,
      },
    };

    // If we have a sectorId but missing parent info, resolve from hierarchy
    if (snapshot.sectorId && (!snapshot.regionId || !snapshot.areaName)) {
      const resolved = await this._resolveLocationHierarchy(snapshot.sectorId);
      if (resolved) {
        snapshot.regionId = snapshot.regionId || resolved.regionId;
        snapshot.regionName = snapshot.regionName || resolved.regionName;
        snapshot.areaId = snapshot.areaId || resolved.areaId;
        snapshot.areaName = snapshot.areaName || resolved.areaName;
        snapshot.cityId = snapshot.cityId || resolved.cityId;
        snapshot.cityName = snapshot.cityName || resolved.cityName;
        snapshot.sectorName = snapshot.sectorName || resolved.sectorName;
      }
    }

    return snapshot;
  }

  /**
   * Resolve a shop's full location snapshot from its stored locationId/sectorId.
   * If the shop already has a locationSnapshot, use it. Otherwise resolve from hierarchy.
   */
  async _resolveShopOrigin(shop) {
    // If shop already has a resolved snapshot, use it directly
    if (shop.locationSnapshot && shop.locationSnapshot.resolvedAt) {
      return {
        regionId: shop.locationSnapshot.regionId || null,
        regionName: shop.locationSnapshot.regionName || '',
        areaId: shop.locationSnapshot.areaId || null,
        areaName: shop.locationSnapshot.areaName || '',
        cityId: shop.locationSnapshot.cityId || null,
        cityName: shop.locationSnapshot.cityName || '',
        sectorId: shop.locationSnapshot.sectorId || shop.sectorId || null,
        sectorName: shop.locationSnapshot.sectorName || '',
        fullAddress: shop.locationSnapshot.fullAddress || shop.address || '',
        landmark: shop.locationSnapshot.landmark || '',
        building: shop.locationSnapshot.building || '',
        contactPhone: shop.locationSnapshot.contactPhone || String(shop.phoneNumber || ''),
        coordinates: {
          latitude: shop.locationSnapshot.coordinates?.latitude || null,
          longitude: shop.locationSnapshot.coordinates?.longitude || null,
        },
      };
    }

    // Otherwise resolve from the shop's sectorId or locationId
    const locationId = shop.sectorId || shop.locationId;
    if (!locationId) {
      // No location data at all — return what we have from the shop address
      return {
        regionId: null, regionName: '',
        areaId: null, areaName: '',
        cityId: null, cityName: '',
        sectorId: null, sectorName: '',
        fullAddress: shop.address || '',
        landmark: '', building: '',
        contactPhone: String(shop.phoneNumber || ''),
        coordinates: { latitude: null, longitude: null },
      };
    }

    const resolved = await this._resolveLocationHierarchy(locationId);
    return {
      regionId: resolved?.regionId || null,
      regionName: resolved?.regionName || '',
      areaId: resolved?.areaId || null,
      areaName: resolved?.areaName || '',
      cityId: resolved?.cityId || null,
      cityName: resolved?.cityName || '',
      sectorId: resolved?.sectorId || null,
      sectorName: resolved?.sectorName || '',
      fullAddress: shop.address || '',
      landmark: '', building: '',
      contactPhone: String(shop.phoneNumber || ''),
      coordinates: { latitude: null, longitude: null },
    };
  }

  async createOrder(payload) {
    // `totalPrice` from the client is deliberately ignored: every line is
    // re-priced from the Product collection and the total is recomputed here.
    const { cart, shippingAddress, user, paymentInfo, destination, requestId } = payload;
    // COD is currently the only configured buyer settlement rail. Never trust
    // a client-provided payment status when creating an order.
    const paymentMethod = String(paymentInfo && paymentInfo.method || 'COD').trim().toUpperCase();
    if (paymentMethod !== 'COD') {
      throw new ApiError(`Payment method "${paymentMethod}" is not currently available`, 400);
    }
    const safePaymentInfo = { type: 'Cash on Delivery', method: 'COD', status: 'PENDING' };
    const buyerId = user && (user._id || user.id) || null;

    if (!Array.isArray(cart) || cart.length === 0) {
      throw new ApiError('Cart items are required', 400);
    }

    // Validate + merge the incoming lines BEFORE touching the catalog.
    // Duplicate lines for the same product are summed into one line: two lines
    // used to reserve the product twice, and when the second reservation
    // exceeded stock the checkout failed (leaking a half-built order).
    const mergedCart = [];
    const indexByProduct = new Map();
    for (const rawItem of cart) {
      // Prefer productId: cart lines may carry a line-level `_id` that is not
      // the catalog id. Legacy payloads only have `_id`/`id`.
      const rawId = rawItem && (rawItem.productId || rawItem._id || rawItem.id);
      if (!rawId) throw new ApiError('Cart item is missing a product id', 400);
      const key = String(rawId);
      const quantity = parseOrderQuantity(
        rawItem.quantity !== undefined && rawItem.quantity !== null ? rawItem.quantity : rawItem.qty,
        rawItem.name || key
      );
      const existingIndex = indexByProduct.get(key);
      if (existingIndex === undefined) {
        indexByProduct.set(key, mergedCart.length);
        mergedCart.push({ _id: key, quantity });
      } else {
        mergedCart[existingIndex].quantity += quantity;
      }
    }

    // Re-price every line from the catalog (server is the source of truth).
    const pricedItems = [];
    for (const item of mergedCart) {
      const productId = item._id;
      const product = await productRepository.findById(productId);
      if (!product) throw new ApiError(`Product not found: ${productId}`, 404);
      // Async gate: a rejected/suspended shop, an inactive category, a draft or
      // a deactivated product must stop an order here even when the client
      // holds a stale id. (Missing `await` would turn the guard into a no-op.)
      await assertOrderable(product);
      const qty = item.quantity;
      const unitPrice = Number(product.discountPrice);
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
        throw new ApiError(`Product "${product.name}" has an invalid price`, 400);
      }
      pricedItems.push({
        _id: String(product._id),
        productId: String(product._id),
        name: product.name,
        description: product.description || '',
        images: product.images || [],
        category: product.category || '',
        shopId: product.shopId,
        sellerId: product.sellerId || null,
        shop: product.shop || undefined,
        discountPrice: unitPrice,
        price: unitPrice,
        originalPrice: Number(product.originalPrice) > 0 ? Number(product.originalPrice) : unitPrice,
        currency: product.currency || 'ETB',
        quantity: qty,
        qty, // legacy key so older order readers keep working
        subtotal: unitPrice * qty,
        isReviewed: false,
      });
    }

    // Validate inventory availability against the re-priced lines
    await this.validateInventoryAvailability(pricedItems);

    // Validate destination
    if (!destination || !destination.sectorId || !destination.fullAddress) {
      throw new ApiError('Delivery destination is required: sectorId, fullAddress, and phone are mandatory', 400);
    }

    // Location snapshot (historical, immutable after order creation)
    const destinationSnapshot = await this._buildDestinationSnapshot(destination);

    // Group cart items by shopId
    const shopItemsMap = new Map();
    for (const item of pricedItems) {
      const shopId = item.shopId;
      if (!shopItemsMap.has(shopId)) shopItemsMap.set(shopId, []);
      shopItemsMap.get(shopId).push(item);
    }

    // Resolve all shops in parallel
    const shopIds = [...shopItemsMap.keys()];
    const shops = await Promise.all(shopIds.map(id => shopRepository.findById(id)));
    const shopMap = new Map();
    shops.forEach((shop, i) => { if (shop) shopMap.set(shopIds[i], shop); });

    // Build seller shipments and resolve origins in parallel
    const shipmentPromises = [...shopItemsMap.entries()].map(async ([shopId, items]) => {
      const shop = shopMap.get(shopId);
      let sellerId = items[0] && (items[0].sellerId || items[0].shop?.ownerId) || null;
      if (!sellerId && shop) sellerId = shop.ownerId;

      const origin = shop ? await this._resolveShopOrigin(shop) : {
        regionId: null, regionName: '', areaId: null, areaName: '',
        cityId: null, cityName: '', sectorId: null, sectorName: '',
        fullAddress: '', landmark: '', building: '', contactPhone: '',
        coordinates: { latitude: null, longitude: null },
      };

      const shipmentSubtotal = items.reduce((sum, item) => sum + item.subtotal, 0);

      return {
        sellerId: sellerId || '',
        businessId: shop?.ownerId || null,
        shopId,
        shopName: shop?.name || '',
        items,
        subtotal: shipmentSubtotal,
        currency: items[0]?.currency || 'ETB',
        origin,
      };
    });

    const sellerShipments = await Promise.all(shipmentPromises);

    const orders = [];
    // orderId -> the units that order actually managed to reserve.
    const reservations = new Map();
    try {
      for (const shipment of sellerShipments) {
        // Each order is invoiced for ITS OWN items only: one checkout can span
        // several sellers, and the checkout total is by definition the sum of
        // these orders. (A single cart-wide total used to be copied into every
        // order, so a 2-shop checkout displayed the whole amount on both.)
        const shipmentShipping = computeShipping(shipment.subtotal);
        const order = await orderRepository.create({
          cart: shipment.items,
          shippingAddress,
          user,
          // --- money (per seller/shop, server-computed) ---
          subtotal: shipment.subtotal,
          shippingFee: shipmentShipping,
          currency: shipment.currency || 'ETB',
          totalPrice: Math.round((shipment.subtotal + shipmentShipping) * 100) / 100,
          paymentInfo: safePaymentInfo,
          buyerId,
          sellerId: shipment.sellerId,
          requestId: requestId || null,
          destination: destinationSnapshot,
          sellerShipments: [shipment],
          status: ORDER_STATUSES.PROCESSING,
          paymentStatus: 'PENDING',
          paidAt: null,
          sectorId: destinationSnapshot.sectorId,
          locationId: destinationSnapshot.sectorId, // legacy compat
        });

        // Tracked BEFORE reserving, so a failure on this very order is rolled
        // back as well (the old code deleted the row in its catch block only
        // after `orders.push`, and crashed while doing it).
        orders.push(order);

        // ORDER ↔ DELIVERY bridge: written inside the checkout boundary so an
        // order can never exist without its delivery link (that would be the
        // "two sources of truth" this table is here to prevent).
        await orderDeliveryService.linkForOrder(order, shipment, destinationSnapshot);

        const reservedLines = [];
        reservations.set(String(order._id), reservedLines);
        await this.reserveInventory(shipment.items, order._id, reservedLines);
      }
    } catch (err) {
      // All-or-nothing: a checkout that fails for one seller must not leave the
      // other sellers' orders committed while the buyer receives an error.
      await this._compensateFailedCheckout(orders, reservations, err);
      throw err;
    }

    return orders;
  }

  /**
   * Create an order straight from a Request Management agreement — no cart.
   *
   * Flow: buyer requests → seller reviews → they talk → they agree on product,
   * quantity and price → the platform creates a normal Order. The buyer must
   * NOT be pushed through a cart: the agreement IS the purchase order.
   *
   * What this order keeps from the agreement: buyer, seller, agreed product
   * (catalogue link when one is known, otherwise its agreed name), quantity,
   * agreed unit price, total and the `requestId` reference. The catalogue
   * price is deliberately NOT re-applied — the negotiated price is the deal.
   *
   * Everything after this point is the ordinary pipeline: Payment → Delivery
   * (the admin/delivery coordinator assigns a provider to this order exactly
   * like any other), seller settlement, tracking.
   *
   * Agreement lines are marked `stockManaged: false`: a request often targets
   * items the shop does not hold yet, and stock must never block a deal the
   * two sides already signed. Every stock operation (reserve / deduct /
   * release / restock) skips such lines, so inventory is never touched twice
   * or inflated for these orders.
   */
  async createAgreementOrder(payload) {
    const { lines, user, destination, requestId = null, shopId = null, sellerId = null } = payload;
    if (!Array.isArray(lines) || lines.length === 0) throw new ApiError('Agreed items are required', 400);
    const buyerId = (user && (user._id || user.id)) || null;

    const items = lines.map((line) => {
      const name = String(line.name || '').trim();
      if (!name) throw new ApiError('Each agreed item needs a name', 400);
      const quantity = parseOrderQuantity(
        line.quantity !== undefined && line.quantity !== null ? line.quantity : line.qty,
        name
      );
      const unitPrice = Number(line.unitPrice !== undefined ? line.unitPrice : line.price);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        throw new ApiError(`Agreed price for "${name}" is invalid`, 400);
      }
      return {
        // The catalogue link is informational (product pages, admin views);
        // an agreement works fine without one.
        ...(line.productId ? { _id: String(line.productId), productId: String(line.productId) } : {}),
        name,
        description: line.description || '',
        images: line.images || [],
        category: line.category || '',
        shopId: line.shopId || shopId || null,
        sellerId: line.sellerId || sellerId || null,
        discountPrice: unitPrice,
        price: unitPrice,
        originalPrice: unitPrice,
        currency: 'ETB',
        quantity,
        qty: quantity, // legacy key so older order readers keep working
        subtotal: unitPrice * quantity,
        isReviewed: false,
        stockManaged: false,
      };
    });

    if (!destination || !destination.sectorId || !destination.fullAddress) {
      throw new ApiError('Delivery destination is required: sectorId, fullAddress, and phone are mandatory', 400);
    }
    const destinationSnapshot = await this._buildDestinationSnapshot(destination);

    // The agreement is always against one shop (the request addresses it, or
    // the seller's own shop once they claim an open request).
    let shop = shopId ? await shopRepository.findById(shopId) : null;
    if (!shop && sellerId) {
      const owned = await shopRepository.find({ filter: { ownerId: String(sellerId) } });
      shop = owned[0] || null;
    }
    if (!shop) throw new ApiError("The seller's shop is required to create this order", 400);

    const origin = await this._resolveShopOrigin(shop);
    const subtotal = items.reduce((sum, item) => sum + item.subtotal, 0);
    const shipping = computeShipping(subtotal);
    const shipment = {
      sellerId: String(shop.ownerId || sellerId || ''),
      businessId: shop.ownerId || null,
      shopId: String(shop._id),
      shopName: shop.name || '',
      items,
      subtotal,
      currency: 'ETB',
      origin,
    };

    const order = await orderRepository.create({
      cart: items,
      shippingAddress: destination,
      user,
      subtotal,
      shippingFee: shipping,
      currency: 'ETB',
      totalPrice: Math.round((subtotal + shipping) * 100) / 100,
      paymentInfo: { type: 'Cash on Delivery', method: 'COD', status: 'PENDING' },
      buyerId,
      sellerId: shipment.sellerId,
      requestId: requestId || null,
      destination: destinationSnapshot,
      sellerShipments: [shipment],
      status: ORDER_STATUSES.PROCESSING,
      paymentStatus: 'PENDING',
      paidAt: null,
      sectorId: destinationSnapshot.sectorId,
      locationId: destinationSnapshot.sectorId, // legacy compat
    });

    // Same boundary rule as checkout: an order without its ORDER ↔ DELIVERY
    // link is the "two sources of truth" this table exists to prevent, so a
    // failure here removes the order again instead of half-committing it.
    try {
      await orderDeliveryService.linkForOrder(order, shipment, destinationSnapshot);
    } catch (err) {
      await orderRepository.deleteById(order._id);
      throw err;
    }

    return order;
  }

  /**
   * Undo a partially built checkout.
   *
   * Orders are created (and stock reserved) one seller at a time, so when a
   * later seller fails, every order created so far is rolled back: the units
   * THAT ORDER actually reserved are released (`reservations`), its ledger rows
   * removed, then the row deleted.
   *
   * Releasing from the cart contents instead would be wrong: when two buyers
   * race, the loser's cart does not represent what it holds, so it would steal
   * the winner's reservation. `reservations` is the record of what was really
   * taken, line by line, before the failure.
   */
  async _compensateFailedCheckout(orders, reservations, cause) {
    if (!orders || orders.length === 0) return;
    console.warn(`[orders] rolling back ${orders.length} order(s) after: ${cause && cause.message}`);
    for (const order of orders) {
      try {
        const held = (reservations && reservations.get(String(order._id))) || [];
        for (const line of held) {
          await productRepository.releaseReserved(line.productId, line.quantity);
        }
        await stockMovementRepository.deleteByOrder(order._id);
        await orderDeliveryService.removeByOrderId(order._id);
        await orderRepository.deleteById(order._id);
      } catch (compensationError) {
        console.error(`[orders] compensation failed for order ${order._id}:`, compensationError.message);
      }
    }
  }

  getUserOrders(userId) {
    return orderRepository.findByUser(userId).then((orders) => this.withDeliverySummaries(orders));
  }
  /**
   * Orders for one seller. Accepts EITHER the seller's identity id (matches
   * `order.sellerId`) OR one of their shop ids (matches the embedded
   * `sellerShipments.shopId`) — the business UI scopes by shop, while analytics
   * and seeds attribute by identity id. Both shapes are authorized upstream in
   * `validateSellerOwnership`.
   */
  getSellerOrders(sellerIdOrShopId) {
    return orderRepository.findBySellerOrShop(sellerIdOrShopId).then((orders) => this.withDeliverySummaries(orders));
  }
  getOrderById(orderId) { return orderRepository.findById(orderId); }

  /**
   * Attach the delivery-owned summary (`deliveryStatus`, `deliveryId`) to every
   * order in a list.
   *
   * ONE batched query on the ORDER ↔ DELIVERY bridge — never a per-order call
   * and never a cross-service request. A failure here must not break the list:
   * the orders are what the caller asked for, the delivery summary is an
   * enrichment, so a lookup error is logged and the rows are returned as-is.
   * The extra fields are additive, so every existing client keeps working.
   */
  async withDeliverySummaries(orders) {
    const docs = (orders || []).map((order) => (typeof order?.toObject === 'function' ? order.toObject() : order));
    if (!docs.length) return docs;
    try {
      const summaries = await orderDeliveryService.getSummariesByOrderIds(docs.map((order) => String(order._id)));
      const byOrderId = new Map((summaries || []).map((row) => [String(row.orderId), row]));
      return docs.map((order) => {
        const link = byOrderId.get(String(order._id));
        return {
          ...order,
          deliveryStatus: link ? link.status || null : null,
          deliveryId: link ? link.deliveryId || null : null,
        };
      });
    } catch (err) {
      console.error('[orders] delivery summary lookup failed:', err.message);
      return docs;
    }
  }

  async updateOrderStatus(orderId, { status }) {
    const order = await orderRepository.findById(orderId);
    if (!order) throw new ApiError('Order not found', 404);
    // Both sides are normalized: stored documents may still carry the legacy
    // 'PENDING'/'CONFIRMED' spellings, and older clients send legacy values.
    const nextStatus = status ? normalizeStatus(status) : null;
    if (nextStatus && normalizeStatus(order.status) !== nextStatus && !canTransition(order.status, nextStatus)) {
      throw new ApiError(`Cannot transition from "${order.status}" to "${status}"`, 400);
    }
    order.status = nextStatus || order.status;
    if (order.status === ORDER_STATUSES.DELIVERED) {
      order.deliveredAt = Date.now();
    }
    await order.save();
    if (normalizeStatus(order.status) === ORDER_STATUSES.CONFIRMED) {
      const shipment = (order.sellerShipments || [])[0];
      if (shipment) {
        await orderDeliveryService.queueHandoff(order._id);
        this._createDeliveryRequest(order, shipment, order.destination || {}).catch((err) => {
          console.error(`[commerce] Delivery request failed for confirmed order ${order._id}:`, err.message || err);
        });
      }
    }
    return order;
  }

  async refundOrder(orderId, { status }, requester) {
    const order = await orderRepository.findById(orderId);
    if (!order) throw new ApiError('Order not found', 404);
    if (requester && requester.role !== 'ADMIN') {
      if (order.buyerId !== requester.id) {
        throw new ApiError('Forbidden: you can only refund your own orders', 403);
      }
    }
    const nextStatus = normalizeStatus(status || ORDER_STATUSES.REFUND_REQUESTED);
    // State machine: e.g. only Delivered → Refund Requested (or re-request after
    // Rejected). Same-status is treated as idempotent, not a violation.
    if (nextStatus !== normalizeStatus(order.status) && !canTransition(order.status, nextStatus)) {
      throw new ApiError(`Cannot transition from "${order.status}" to "${nextStatus}"`, 400);
    }
    order.status = nextStatus;
    await order.save();
    return order;
  }

  async refundSuccess(orderId, { status }) {
    const order = await orderRepository.findById(orderId);
    if (!order) throw new ApiError('Order not found', 404);
    const previousStatus = normalizeStatus(order.status);
    const nextStatus = status ? normalizeStatus(status) : order.status;
    if (status && nextStatus !== previousStatus && !canTransition(order.status, nextStatus)) {
      throw new ApiError(`Cannot transition from "${order.status}" to "${nextStatus}"`, 400);
    }
    order.status = nextStatus;
    // Restock only on the FIRST transition into Refund Success — a retried
    // refundSuccess call (same status) must not return the units twice.
    const successful = order.status === ORDER_STATUSES.REFUND_SUCCESS;
    const firstTransition = successful && previousStatus !== ORDER_STATUSES.REFUND_SUCCESS;
    if (firstTransition) {
      for (const item of order.cart) {
        if (item && item.stockManaged === false) continue;
        const productId = item._id || item.id;
        const qty = lineQty(item);
        const before = await productRepository.findById(productId);
        const updated = await productRepository.returnStock(productId, qty);
        if (updated) {
          await stockMovementRepository.create({
            productId,
            shopId: updated.shopId,
            sellerId: updated.sellerId,
            type: 'refund',
            quantity: qty,
            stockBefore: before ? before.stock : 0,
            stockAfter: updated.stock,
            orderId: order._id.toString(),
            note: `Refund processed for order`,
          });
        }
      }
    }
    await order.save();
    return order;
  }

  async validateInventoryAvailability(cart) {
    const items = [];
    for (const item of cart) {
      // Agreement lines (Request → Order) are not stock-managed — see
      // `createAgreementOrder`. Nothing to validate for them.
      if (item && item.stockManaged === false) continue;
      const productId = item._id || item.id;
      const qty = lineQty(item);
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

  async reserveInventory(cart, orderId, tracker = null) {
    const movements = [];
    for (const item of cart) {
      if (item && item.stockManaged === false) continue;
      const productId = item._id || item.id;
      const qty = lineQty(item);
      const product = await productRepository.findById(productId);
      if (!product) throw new ApiError(`Cannot reserve: product not found`, 404);
      const stockBefore = product.reserved || 0;
      // Atomic conditional reserve: only succeeds when stock - reserved >= qty,
      // so concurrent orders cannot oversell the same available units.
      const updated = await productRepository.reserveAvailable(productId, qty);
      if (!updated) {
        const availableStock = (product.stock || 0) - (product.reserved || 0);
        throw new ApiError(`Insufficient stock for "${product.name}". Available: ${availableStock}, requested: ${qty}`, 400);
      }
      const movement = await stockMovementRepository.create({
        productId,
        shopId: product.shopId,
        sellerId: product.sellerId,
        type: 'order_placed',
        quantity: -qty,
        stockBefore,
        stockAfter: updated.reserved,
        orderId: orderId ? orderId.toString() : null,
        note: `${qty} units reserved for order`
      });
      movements.push(movement);
      // Report exactly what THIS call managed to reserve, so a failed checkout
      // can release precisely those units (and nothing belonging to another
      // order that happened to reserve between the two attempts).
      if (tracker) tracker.push({ productId: String(productId), quantity: qty });
    }
    return movements;
  }

  async deductInventoryOnPayment(cart, orderId) {
    const movements = [];
    for (const item of cart) {
      if (item && item.stockManaged === false) continue;
      const productId = item._id || item.id;
      const qty = lineQty(item);
      const productBefore = await productRepository.findById(productId);
      if (!productBefore) throw new ApiError(`Cannot deduct: product not found`, 404);

      // Per-line idempotency: the movement written for this order+product is
      // the marker — a retry after a partial failure must not deduct twice.
      const already = await stockMovementRepository.existsConfirmedForOrder(orderId, productId);
      if (already) continue;

      // Conditional deduct: requires enough stock AND consumes this order's own
      // reservation (clamped at 0 if it was already released). The old
      // `stock - reserved < qty` pre-check wrongly rejected confirmations whose
      // own reservation consumed the availability.
      const updated = await productRepository.deductReserved(productId, qty);
      if (!updated) {
        throw new ApiError(
          `Payment confirmation failed: insufficient stock for "${productBefore.name}"`,
          400
        );
      }

      try {
        const movement = await stockMovementRepository.create({
          productId,
          shopId: productBefore.shopId,
          sellerId: productBefore.sellerId,
          type: 'order_confirmed',
          quantity: -qty,
          stockBefore: productBefore.stock,
          stockAfter: updated.stock,
          orderId: orderId ? orderId.toString() : null,
          note: `Payment confirmed: ${qty} units deducted from stock`,
        });
        movements.push(movement);
      } catch (err) {
        // Compensate the deduct so a retry can cleanly re-attempt this line.
        // (Mongo standalone has no transactions; reserved may drift upward,
        // which is the conservative direction — never causes an oversell.)
        try {
          await productRepository.compensateDeduct(productId, qty);
        } catch (e) {
          console.error('[deductInventoryOnPayment] compensation failed:', e.message);
        }
        throw err;
      }
    }
    return movements;
  }

  async releaseInventory(cart, orderId, reason = '') {
    const movements = [];
    for (const item of cart) {
      if (item && item.stockManaged === false) continue;
      const productId = item._id || item.id;
      const qty = lineQty(item);
      const productBefore = await productRepository.findById(productId);
      if (!productBefore) throw new ApiError(`Cannot release: product not found`, 404);
      const reservedBefore = productBefore.reserved || 0;
      if (reservedBefore < qty) {
        console.warn(`Warning: reserved stock (${reservedBefore}) less than release qty (${qty}) for ${productId}`);
      }
      // Atomic release clamped at 0 (pipeline update) — no read-modify-write race.
      const updated = await productRepository.releaseReserved(productId, qty);
      if (updated) {
        const movement = await stockMovementRepository.create({
          productId,
          shopId: productBefore.shopId,
          sellerId: productBefore.sellerId,
          type: 'order_cancelled',
          quantity: qty,
          stockBefore: reservedBefore,
          stockAfter: updated.reserved,
          orderId: orderId ? orderId.toString() : null,
          note: `Reservation released: ${qty} units (${reason})`
        });
        movements.push(movement);
      }
    }
    return movements;
  }

  async cancelOrder(orderId, reason = 'Customer requested') {
    const order = await orderRepository.findById(orderId);
    if (!order) throw new ApiError('Order not found', 404);
    const cancellableStatuses = [ORDER_STATUSES.PROCESSING, ORDER_STATUSES.CONFIRMED];
    if (!cancellableStatuses.includes(normalizeStatus(order.status))) {
      throw new ApiError(`Cannot cancel order in status "${order.status}". Only Processing or Confirmed orders can be cancelled.`, 400);
    }
    // Atomic claim: flips status→Cancelled + sets cancelledAt exactly once.
    // Races with claimPaymentConfirmation resolve correctly on both sides:
    //  - cancel wins first  → claim sees Cancelled and returns null;
    //  - claim wins first   → this returns the pre-doc with paymentStatus
    //                         CONFIRMED, so we restock instead of release.
    // Returns null when the order left the cancellable window between the
    // read above and this update (or a concurrent cancel already won).
    const previous = await orderRepository.claimCancellation(orderId);
    if (!previous) {
      throw new ApiError(`Cannot cancel order in status "${order.status}". Only Processing or Confirmed orders can be cancelled.`, 400);
    }
    const paid = previous.paymentStatus === 'CONFIRMED';
    if (previous.cart && previous.cart.length > 0) {
      if (paid) {
        // Stock was already DEDUCTED at payment confirmation — cancelling must
        // RETURN the units. Releasing the reservation here would be a no-op
        // (it was consumed by the deduct) and the units would be lost forever.
        await this._restockConfirmedOrder(previous.cart, orderId, reason);
      } else {
        await this.releaseInventory(previous.cart, orderId, reason);
      }
    }
    // Status/cancelledAt already set by the atomic claim; only reconcile the
    // payment flag (CONFIRMED → REFUNDED, anything else forced back to PENDING).
    await orderRepository.updateFields(orderId, {
      paymentStatus: paid ? 'REFUNDED' : 'PENDING',
    });
    return orderRepository.findById(orderId);
  }

  /**
   * Return units for a cancelled order that was already paid/confirmed:
   * increments stock (sold_out clamped at 0) and writes `refund` movements.
   */
  async _restockConfirmedOrder(cart, orderId, reason = '') {
    const movements = [];
    for (const item of cart) {
      if (item && item.stockManaged === false) continue;
      const productId = item._id || item.id;
      const qty = lineQty(item);
      const before = await productRepository.findById(productId);
      const updated = await productRepository.returnStock(productId, qty);
      if (updated) {
        const movement = await stockMovementRepository.create({
          productId,
          shopId: (before && before.shopId) || updated.shopId,
          sellerId: (before && before.sellerId) || updated.sellerId,
          type: 'refund',
          quantity: qty,
          stockBefore: before ? before.stock : 0,
          stockAfter: updated.stock,
          orderId: orderId ? orderId.toString() : null,
          note: `Cancelled after payment confirmation — ${qty} unit(s) returned (${reason})`,
        });
        movements.push(movement);
      }
    }
    return movements;
  }

  /**
   * Atomic payment-confirmation claim (delegates to the repository's
   * conditional flip PENDING→CONFIRMED; null = lost race / cancelled).
   */
  claimPaymentConfirmation(orderId) {
    return orderRepository.claimPaymentConfirmation(orderId);
  }

  /** Undo a failed claim so the client can retry confirmation. */
  rollbackPaymentConfirmation(orderId, paymentStatus, status) {
    return orderRepository.rollbackPaymentConfirmation(orderId, paymentStatus, status);
  }

  async getInventoryAvailability(productId) {
    const product = await productRepository.findById(productId);
    if (!product) throw new ApiError('Product not found', 404);
    // Public endpoint: a product that fails any public gate (deactivated,
    // seller-drafted, shop hidden/removed, inactive category) must 404, not
    // leak exact stock.
    if (!(await isProductPubliclyVisible(product))) throw new ApiError('Product not found', 404);
    const stock = product.stock || 0;
    const reserved = product.reserved || 0;
    const available = Math.max(0, stock - reserved);
    return {
      productId: product._id.toString(),
      productName: product.name,
      stock, reserved, available,
      lowStockThreshold: product.lowStockThreshold || 5,
      isLowStock: available <= (product.lowStockThreshold || 5)
    };
  }

  /**
   * Create a delivery request in the Delivery Service with complete
   * pickup + destination information.
   */
  async _createDeliveryRequest(order, shipment, destinationSnapshot) {
    const requestData = {
      orderId: order._id.toString(),
      sellerId: shipment.sellerId || '',
      buyerId: order.buyerId || '',

      // Location IDs for filtering
      pickupLocationId: shipment.origin.sectorId || shipment.origin.cityId || shipment.origin.areaId || null,
      destinationLocationId: destinationSnapshot.sectorId || destinationSnapshot.cityId || destinationSnapshot.areaId || null,

      // Complete customer destination
      deliveryAddress: {
        regionId: destinationSnapshot.regionId || null,
        regionName: destinationSnapshot.regionName || '',
        areaId: destinationSnapshot.areaId || null,
        areaName: destinationSnapshot.areaName || '',
        cityId: destinationSnapshot.cityId || null,
        cityName: destinationSnapshot.cityName || '',
        sectorId: destinationSnapshot.sectorId || null,
        sectorName: destinationSnapshot.sectorName || '',
        locationId: destinationSnapshot.sectorId || null,
        addressDetail: destinationSnapshot.fullAddress || '',
        landmark: destinationSnapshot.landmark || '',
        building: destinationSnapshot.building || '',
        contactName: order.user?.name || '',
        contactPhone: destinationSnapshot.phone || '',
        additionalInstructions: destinationSnapshot.additionalInstructions || '',
        coordinates: destinationSnapshot.coordinates || { latitude: null, longitude: null },
      },

      // Complete seller pickup
      pickupAddress: {
        regionId: shipment.origin.regionId || null,
        regionName: shipment.origin.regionName || '',
        areaId: shipment.origin.areaId || null,
        areaName: shipment.origin.areaName || '',
        cityId: shipment.origin.cityId || null,
        cityName: shipment.origin.cityName || '',
        sectorId: shipment.origin.sectorId || null,
        sectorName: shipment.origin.sectorName || '',
        shopId: shipment.shopId || '',
        shopName: shipment.shopName || '',
        businessId: shipment.businessId || null,
        addressDetail: shipment.origin.fullAddress || '',
        landmark: shipment.origin.landmark || '',
        building: shipment.origin.building || '',
        contactName: shipment.sellerName || '',
        contactPhone: shipment.origin.contactPhone || '',
        coordinates: shipment.origin.coordinates || { latitude: null, longitude: null },
      },

      items: shipment.items.map(item => ({
        name: item.name || '',
        weight: item.weight || 0,
        quantity: lineQty(item),
        value: item.discountPrice || item.price || 0,
      })),
      totalValue: shipment.subtotal || 0,
      paymentMethod: order.paymentInfo?.method || 'COD',
      paymentAmount: order.totalPrice,
      totalWeight: shipment.items.reduce((sum, item) => sum + ((item.weight || 0) * lineQty(item)), 0),
      specialInstructions: destinationSnapshot.additionalInstructions || '',
    };

    const result = await deliveryClient.createDeliveryRequest(requestData);
    if (result.status >= 200 && result.status < 300) {
      console.log(`[commerce] Delivery request created for order ${order._id}`);
      // Record the request on the ORDER ↔ DELIVERY bridge so the delivery link
      // can be resolved without asking the Delivery Service for its ids.
      const requestId = result.body && result.body.request && (result.body.request._id || result.body.request.id);
      if (requestId) await orderDeliveryService.attachRequest(order._id, requestId);
    } else {
      console.warn(`[commerce] Delivery request returned status ${result.status} for order ${order._id}`);
    }
    return result;
  }

  /**
   * Retry committed order handoffs whose delivery-service acknowledgement was lost.
   *
   * Delivery validates the handoff (it refuses an order with no destination, no
   * pickup, a negative quantity, an impossible coordinate, …), so a 4xx answer is
   * PERMANENT: the same order data will be refused forever. Such a handoff is
   * marked abandoned — with the reason — instead of being retried on every pass;
   * only a 5xx / unreachable answer is a transient failure worth retrying.
   */
  async recoverDeliveryHandoffs(limit = 100) {
    const links = await orderDeliveryService.findWithoutDeliveryRequest(limit);
    let recovered = 0;
    let abandoned = 0;
    for (const link of links) {
      try {
        const order = await orderRepository.findById(link.orderId);
        if (!order || ['Cancelled', 'CANCELLED'].includes(String(order.status))) {
          await orderDeliveryService.markHandoffAbandoned(link.orderId);
          abandoned += 1;
          continue;
        }
        if (normalizeStatus(order.status) !== ORDER_STATUSES.CONFIRMED) {
          await orderDeliveryService.waitForOrderApproval(link.orderId);
          continue;
        }
        const shipment = (order.sellerShipments || [])[0];
        if (!shipment) continue;
        const result = await this._createDeliveryRequest(order, shipment, order.destination || {});
        if (result?.status >= 200 && result.status < 300) {
          recovered += 1;
          continue;
        }
        if (result && result.status >= 400 && result.status < 500) {
          // The delivery service rejected the order data itself: retrying cannot
          // change the answer, so stop and leave an operator-visible trail.
          const reason = (result.body && result.body.message) || `Delivery refused the handoff (${result.status})`;
          console.warn(`[commerce] Delivery handoff abandoned for order ${link.orderId}: ${reason}`);
          await orderDeliveryService.markHandoffAbandoned(link.orderId);
          abandoned += 1;
        }
      } catch (err) {
        console.warn(`[commerce] Delivery handoff retry failed for order ${link.orderId}:`, err.message || err);
      }
    }
    return { attempted: links.length, recovered, abandoned };
  }
}

module.exports = new OrderService();
