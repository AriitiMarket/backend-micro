// Commerce Service -> Delivery Service client.
//
// DIRECT internal call over the private network (DELIVERY_SERVICE_URL), not via
// the API Gateway. Routing service-to-service traffic back through the public
// edge used to add a hop, re-enter the public surface and force every call to
// be signed as `gateway` — which destroyed caller attribution in the Delivery
// logs and made the gateway a single point of failure for internal traffic.
//
// Which surface is used, and why:
//
//   * `/internal/delivery/*` for everything that is genuinely internal. A
//     service call carries the cluster credential and NEVER a user identity, so
//     a route guarded by `authenticate` can never be called this way (this is
//     why the old handoff answered 401 and no order ever reached Delivery).
//   * `/internal/delivery/location/*` for the read-only geographic tree. These
//     mirror the public read handlers, but the public routes are off limits to a
//     peer service: gatewayOnly refuses a service caller outside /internal, since
//     it carries no user identity and a user-facing route can never be a
//     legitimate service call.
//
// Every call goes through the shared internal client, so this dependency has the
// same timeout, trace propagation, retry policy and structured logging as every
// other one.
//
// Methods that belonged to the admin/actor surface (createDelivery,
// updateDeliveryStatus, assignDelivery, initiateDelivery, automaticAssignment,
// getAssignment, validateAddress, ...) were removed: they are
// Delivery-side admin operations that require a real actor identity and had no
// caller in this service. Zone READS were later reintroduced (see the Zones
// section below) because checkout revalidation and admin coverage writes need
// the zone catalogue — reads only, never mutations.
const { createInternalClient } = require('../../shared/internal-client');
const { services } = require('../config/services');

const client = createInternalClient({
  name: services.self,
  baseUrl: services.delivery.url,
  timeoutMs: parseInt(process.env.DELIVERY_CALL_TIMEOUT_MS, 10) || 5000,
  // Safe retries only: the shared client applies them to idempotent methods and
  // never to a POST the caller did not declare idempotent.
  maxRetries: 1,
});

/** Expose the historical `{ status, body }` contract plus the richer fields. */
function toResult(res) {
  return {
    status: res.status,
    body: res.body,
    ok: res.ok,
    code: res.code,
    requestId: res.requestId,
  };
}

async function get(path, options) {
  return toResult(await client.requestOrThrow('GET', path, options));
}

async function post(path, body, options) {
  return toResult(await client.requestOrThrow('POST', path, Object.assign({}, options, { body })));
}

// --- Delivery requests (service-to-service handoff) ---

/**
 * Hand an order to the Delivery Service. Idempotent on Delivery's side (keyed
 * by orderId), which is why it is the one POST allowed a retry.
 */
async function createDeliveryRequest(data) {
  return post('/internal/delivery/request', data, { idempotent: true });
}

// --- Deliveries ---

/**
 * Fetch delivery details by associated order ID.
 * @param {string} orderId - Associated order identifier
 * @returns {Promise<{ status: number, body: any, ok: boolean, code: string, requestId: string }>}
 */
async function getDeliveryByOrderId(orderId) {
  return get('/internal/delivery/deliveries/order/' + encodeURIComponent(String(orderId)));
}

/**
 * Fetch milestone tracking history for a delivery.
 * @param {string} deliveryId - Delivery identifier
 * @returns {Promise<{ status: number, body: any, ok: boolean, code: string, requestId: string }>}
 */
async function getDeliveryHistory(deliveryId) {
  return get('/internal/delivery/deliveries/' + encodeURIComponent(String(deliveryId)) + '/history');
}

// --- Internal reads (bounded, aggregate-friendly) ---

/**
 * Fetch delivery operations dashboard metrics.
 * @param {object} [filter={}] - Query filter parameters
 * @returns {Promise<{ status: number, body: any, ok: boolean, code: string, requestId: string }>}
 */
async function getInternalOperationsDashboard(filter = {}) {
  return get('/internal/delivery/operations/dashboard', { query: filter });
}

/**
 * List internal deliveries with optional filters.
 * @param {object} [filter={}] - Query filter parameters (status, provider, date)
 * @returns {Promise<{ status: number, body: any, ok: boolean, code: string, requestId: string }>}
 */
async function listInternalDeliveries(filter = {}) {
  return get('/internal/delivery/deliveries', { query: filter });
}

async function getInternalLocationCounts() {
  return get('/internal/delivery/locations/counts');
}

/** Bulk delivery lookup for a bounded page of orders (avoids N+1 calls). */
async function getDeliveriesForOrders(orderIds = []) {
  return post('/internal/delivery/deliveries/by-orders', { orderIds }, { idempotent: true });
}

// --- Location hierarchy (Delivery owns geographic locations) ---

async function getLocation(id) {
  return get('/internal/delivery/location/' + encodeURIComponent(String(id)));
}

async function getChildren(parentId) {
  return get('/internal/delivery/location/' + encodeURIComponent(String(parentId)) + '/children');
}

async function getLocationHierarchy() {
  return get('/internal/delivery/location/hierarchy');
}

// --- Zones (Delivery owns the zone catalogue) -------------------------------
//
// Commerce never copies zone definitions: these reads are how it validates the
// buyer's delivery zone at checkout and the zone ids an admin writes into a
// shop's service areas. The public zone routes are user-facing/admin-gated and
// therefore off limits to a peer service (gatewayOnly) — the internal mirrors
// are the supported path.

/** One zone summary (null → the id is unknown to Delivery). */
async function getZoneSummary(id) {
  return get('/internal/delivery/zone/' + encodeURIComponent(String(id)));
}

/** Batch zone summaries for a comma-separated id list (coverage writes). */
async function getZoneSummaries(ids = []) {
  const list = (ids || []).map(String).filter(Boolean).join(',');
  return get('/internal/delivery/zone', { query: { ids: list } });
}

/**
 * Zones covering a location (ancestor-aware — a zone on the city covers its
 * neighbourhoods). Used to resolve a delivery zone for an address/destination
 * that does not carry one explicitly.
 */
async function getZonesForLocation(locationId) {
  return get('/internal/delivery/zone/location/' + encodeURIComponent(String(locationId)));
}

async function quoteDeliveryFee(zoneId, quantity, locationId) {
  return get('/internal/delivery/zone/fee-quote', { query: { zoneId: zoneId || undefined, locationId: locationId || undefined, quantity } });
}

module.exports = {
  deliveryClient: {
    createDeliveryRequest,
    getDeliveryByOrderId,
    getDeliveryHistory,
    getInternalOperationsDashboard,
    listInternalDeliveries,
    getInternalLocationCounts,
    getDeliveriesForOrders,
    getLocation,
    getChildren,
    getLocationHierarchy,
    getZoneSummary,
    getZoneSummaries,
    getZonesForLocation,
    quoteDeliveryFee,
  },
  // Exposed for health checks and diagnostics.
  deliveryClientInternals: client,
};
