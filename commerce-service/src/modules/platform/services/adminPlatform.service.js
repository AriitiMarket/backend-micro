'use strict';

/**
 * Admin Platform Service — the Commerce half of the Platform Admin Control
 * Center.
 *
 * Facade aggregating:
 * - AdminHierarchyService: Geo/location scoping and administrative tree
 * - AdminBusinessesService: Seller applications, shop management, and ownership hydration
 * - AdminOrdersService: Operational stages, lifecycle mapping, and cross-service delivery tracking
 * - AdminAnalyticsService: Platform statistics, dispute counts, pending actions, and growth analytics
 */

const adminHierarchyService = require('./adminHierarchy.service');
const adminBusinessesService = require('./adminBusinesses.service');
const adminOrdersService = require('./adminOrders.service');
const adminAnalyticsService = require('./adminAnalytics.service');

const APPLICATION_STATUSES = ['DRAFT', 'PENDING_REVIEW', 'MORE_INFORMATION_REQUIRED', 'APPROVED', 'REJECTED', 'SUSPENDED'];
const SHOP_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'SUSPENDED', 'INACTIVE'];
const OPEN_DISPUTE_STATUSES = ['open', 'in_progress', 'under_investigation'];

class AdminPlatformService {
  // -------------------------------------------------------------------------
  // Hierarchy & Scope Resolution
  // -------------------------------------------------------------------------

  async expandLocationIds(ids) {
    return adminHierarchyService.expandLocationIds(ids);
  }

  async resolveHierarchyScope(filters = {}) {
    return adminHierarchyService.resolveHierarchyScope(filters);
  }

  async getHierarchy(filters = {}) {
    return adminHierarchyService.getHierarchy(filters);
  }

  async getPlatformTotalsForHierarchy() {
    return adminHierarchyService.getPlatformTotalsForHierarchy();
  }

  // -------------------------------------------------------------------------
  // Businesses & Shops
  // -------------------------------------------------------------------------

  async getBusinesses(filters = {}) {
    return adminBusinessesService.getBusinesses(filters);
  }

  toBusinessDto(app) {
    return adminBusinessesService.toBusinessDto(app);
  }

  async resolveOwnerDisplay(ownerId) {
    return adminBusinessesService.resolveOwnerDisplay(ownerId);
  }

  async getBusinessDetail(applicationId) {
    return adminBusinessesService.getBusinessDetail(applicationId);
  }

  emptyShopPage(page, limit) {
    return adminBusinessesService.emptyShopPage(page, limit);
  }

  async resolveOwnerByEmail(email) {
    return adminBusinessesService.resolveOwnerByEmail(email);
  }

  async expandOwnerSearch(search) {
    return adminBusinessesService.expandOwnerSearch(search);
  }

  async hydrateOwnership(ownerIds = [], applicationIds = []) {
    return adminBusinessesService.hydrateOwnership(ownerIds, applicationIds);
  }

  async getShops(filters = {}) {
    return adminBusinessesService.getShops(filters);
  }

  async approveBusiness(applicationId, adminId, adminNotes, adminName = 'Admin') {
    return adminBusinessesService.approveBusiness(applicationId, adminId, adminNotes, adminName);
  }

  async rejectBusiness(applicationId, adminId, rejectionReason, adminName = 'Admin') {
    return adminBusinessesService.rejectBusiness(applicationId, adminId, rejectionReason, adminName);
  }

  // -------------------------------------------------------------------------
  // Orders & Operational Stages
  // -------------------------------------------------------------------------

  toOrderRow(order, delivery) {
    return adminOrdersService.toOrderRow(order, delivery);
  }

  async collectScopedOrders(query, cap) {
    return adminOrdersService.collectScopedOrders(query, cap);
  }

  async buildOrderSearch(search) {
    return adminOrdersService.buildOrderSearch(search);
  }

  async hydrateOrderRows(rows = []) {
    return adminOrdersService.hydrateOrderRows(rows);
  }

  async getOrders(filters = {}) {
    return adminOrdersService.getOrders(filters);
  }

  stageDefinitions() {
    return adminOrdersService.stageDefinitions();
  }

  async resolveDeliveries(orderIds = []) {
    return adminOrdersService.resolveDeliveries(orderIds);
  }

  async getOrderPickupDeliveryLifecycle(orderId) {
    return adminOrdersService.getOrderPickupDeliveryLifecycle(orderId);
  }

  async getOperationsOverview() {
    return adminOrdersService.getOperationsOverview();
  }

  async getOperationsOrders(stage, filters = {}) {
    return adminOrdersService.getOperationsOrders(stage, filters);
  }

  // -------------------------------------------------------------------------
  // Platform Stats, Growth & Pending Actions
  // -------------------------------------------------------------------------

  async getPlatformStats(filters = {}) {
    return adminAnalyticsService.getPlatformStats(filters);
  }

  async countDisputes() {
    return adminAnalyticsService.countDisputes();
  }

  async getPendingActions(options = {}) {
    return adminAnalyticsService.getPendingActions(options);
  }

  async getGrowthAnalytics(filters = {}) {
    return adminAnalyticsService.getGrowthAnalytics(filters);
  }

  toGrowthBucket(row, key, isCurrentWindow, businessByBucket, shopByBucket) {
    return adminAnalyticsService.toGrowthBucket(row, key, isCurrentWindow, businessByBucket, shopByBucket);
  }

  emptyGrowth(options) {
    return adminAnalyticsService.emptyGrowth(options);
  }

  async logAuditAction(entry = {}) {
    return adminAnalyticsService.logAuditAction(entry);
  }
}

module.exports = new AdminPlatformService();
module.exports.AdminPlatformService = AdminPlatformService;
module.exports.APPLICATION_STATUSES = APPLICATION_STATUSES;
module.exports.SHOP_STATUSES = SHOP_STATUSES;
module.exports.OPEN_DISPUTE_STATUSES = OPEN_DISPUTE_STATUSES;
