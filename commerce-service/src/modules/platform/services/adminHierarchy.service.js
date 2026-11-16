'use strict';

/**
 * Admin Hierarchy Service
 * Manages platform geographic hierarchy scoping, tree building with rolled-up metrics,
 * and platform-level totals.
 */

const shopRepo = require('../../selling/repositories/shops.repository');
const sellerAppRepo = require('../../selling/repositories/sellerApplications.repository');
const orderRepo = require('../../orders/repositories/orders.repository');
const sectorRepo = require('../../selling/repositories/sectors.repository');
const { deliveryClient } = require('../../../app/clients/delivery.client');
const hierarchyScope = require('../../../shared/utils/hierarchyScope');

function toCountMap(rows) {
  const out = {};
  for (const row of rows) {
    if (row && row._id !== null && row._id !== undefined) out[String(row._id)] = row.count;
  }
  return out;
}

async function safe(label, promise) {
  try {
    return { ok: true, data: await promise };
  } catch (err) {
    return { ok: false, data: null, error: `${label}: ${err.message}` };
  }
}

function nameKey(value) {
  return String(value || '').trim().toLowerCase();
}

class AdminHierarchyService {
  async expandLocationIds(ids) {
    return hierarchyScope.expandLocationIds(ids);
  }

  async resolveHierarchyScope(filters = {}) {
    return hierarchyScope.resolveHierarchyScope(filters);
  }

  async getPlatformTotalsForHierarchy() {
    const [businesses, activeBusinesses, shops, activeShops, orders, sectors, activeSectors] =
      await Promise.all([
        sellerAppRepo.count({}),
        sellerAppRepo.count({ status: 'APPROVED' }),
        shopRepo.count({}),
        shopRepo.count({ status: { $in: ['ACTIVE', 'APPROVED'] } }),
        orderRepo.count({}),
        sectorRepo.count({}),
        sectorRepo.countActive(),
      ]);

    return {
      name: 'Platform',
      totals: { businesses, activeBusinesses, shops, activeShops, orders, sectors, activeSectors },
    };
  }

  async getHierarchy(filters = {}) {
    const { includeInactive = false } = filters;

    const hierarchyResult = await safe('delivery hierarchy', deliveryClient.getLocationHierarchy());
    if (!hierarchyResult.ok) {
      return {
        platform: await this.getPlatformTotalsForHierarchy(),
        regions: [],
        degraded: true,
        error: hierarchyResult.error,
      };
    }

    const rawRoots = Array.isArray(hierarchyResult.data.body?.hierarchy)
      ? hierarchyResult.data.body.hierarchy
      : [];

    const [shopsByLocation, applicationsByRegion, applicationsByCity, ordersBySeller, shopsForOwners] =
      await Promise.all([
        shopRepo.countByField('locationId'),
        sellerAppRepo.countByField('location.region'),
        sellerAppRepo.countByField('location.city'),
        orderRepo.countByField('sellerId'),
        shopRepo.listOwnerLocationPairs(),
      ]);

    const shopLocationCounts = toCountMap(shopsByLocation);
    const businessRegionCounts = toCountMap(applicationsByRegion);
    const businessCityCounts = toCountMap(applicationsByCity);
    const sellerOrderCounts = toCountMap(ordersBySeller);

    const ordersByLocation = {};
    for (const shop of shopsForOwners) {
      if (!shop.locationId || !shop.ownerId) continue;
      const orderCount = sellerOrderCounts[String(shop.ownerId)] || 0;
      if (!orderCount) continue;
      const key = String(shop.locationId);
      ordersByLocation[key] = (ordersByLocation[key] || 0) + orderCount;
    }

    const buildNode = (node) => {
      const id = String(node._id);
      const type = node.type;
      const isActive = node.isActive !== false;

      const direct = {
        shops: shopLocationCounts[id] || 0,
        orders: ordersByLocation[id] || 0,
        businesses: 0,
      };

      if (type === 'region') direct.businesses = businessRegionCounts[nameKey(node.name)] || 0;
      if (type === 'city') direct.businesses = businessCityCounts[nameKey(node.name)] || 0;

      const children = (node.children || [])
        .filter((child) => includeInactive || child.isActive !== false)
        .map(buildNode);

      const metrics = {
        shops: direct.shops,
        orders: direct.orders,
        businesses: direct.businesses,
        children: children.length,
        activeChildren: children.filter((child) => child.isActive).length,
      };

      for (const child of children) {
        metrics.shops += child.metrics.shops;
        metrics.orders += child.metrics.orders;
        metrics.businesses += child.metrics.businesses;
      }

      return { id, name: node.name, type, code: node.code || null, isActive, parentId: node.parentId || null, direct, metrics, children };
    };

    const regions = rawRoots
      .filter((root) => includeInactive || root.isActive !== false)
      .map(buildNode);

    return {
      platform: await this.getPlatformTotalsForHierarchy(),
      regions,
      levels: ['platform', 'region', 'city', 'area', 'sector'],
      generatedAt: new Date().toISOString(),
    };
  }
}

module.exports = new AdminHierarchyService();
