const zonesRepo = require('../repositories/zones.repository');
const locationsService = require('./locations.service');
const portsRepo = require('../../operations/repositories/ports.repository');
const DeliveryFeeSettings = require('../models/DeliveryFeeSettings');

function validateQuantityFees(quantityFees) {
  if (quantityFees === undefined) return;
  if (!Array.isArray(quantityFees)) throw Object.assign(new Error('Quantity fees must be a list'), { status: 422 });
  const normalized = quantityFees.map((band, index) => {
    const minQty = Number(band.minQty);
    const maxQty = band.maxQty == null || band.maxQty === '' ? null : Number(band.maxQty);
    const fee = Number(band.fee);
    if (!Number.isSafeInteger(minQty) || minQty < 1) throw Object.assign(new Error(`Rule ${index + 1}: minimum quantity must be a positive whole number`), { status: 422 });
    if (maxQty !== null && (!Number.isSafeInteger(maxQty) || maxQty < minQty)) throw Object.assign(new Error(`Rule ${index + 1}: maximum quantity must be greater than or equal to minimum`), { status: 422 });
    if (!Number.isFinite(fee) || fee < 0 || Math.round(fee * 100) !== fee * 100) throw Object.assign(new Error(`Rule ${index + 1}: fee must be nonnegative with at most 2 decimals`), { status: 422 });
    return { ...band, minQty, maxQty, fee };
  });
  const active = normalized.filter((band) => band.enabled !== false).sort((a, b) => a.minQty - b.minQty);
  for (let i = 1; i < active.length; i += 1) {
    const previousEnd = active[i - 1].maxQty ?? Infinity;
    if (active[i].minQty <= previousEnd) throw Object.assign(new Error(`Quantity fee rules overlap at quantity ${active[i].minQty}`), { status: 409, code: 'FEE_RULE_OVERLAP' });
  }
}

async function createZone(data) {
  validateQuantityFees(data.deliveryRules?.quantityFees);
  if (data.code) {
    const existing = await zonesRepo.findByCode(data.code);
    if (existing) throw Object.assign(new Error('Zone code already exists'), { status: 409 });
  }
  if (data.locationIds && data.locationIds.length > 0) {
    for (const locId of data.locationIds) {
      const loc = await locationsService.getLocation(locId);
      if (!loc.isActive) throw Object.assign(new Error(`Location ${locId} is inactive`), { status: 400 });
    }
  }
  return zonesRepo.create(data);
}

async function getZone(id) {
  const zone = await zonesRepo.findById(id);
  if (!zone) throw Object.assign(new Error('Zone not found'), { status: 404 });
  return zone;
}

async function updateZone(id, fields) { 
  validateQuantityFees(fields.deliveryRules?.quantityFees);
  await getZone(id); 
  return zonesRepo.updateFields(id, fields); 
}

async function deleteZone(id) {
  await getZone(id);
  return zonesRepo.deleteZone(id);
}

async function getZones(filter = {}, options = {}) { return zonesRepo.findAll(filter, options); }
async function countZones(filter = {}) { return zonesRepo.count(filter); }
async function getActiveZones() { return zonesRepo.findActive(); }

async function addLocationToZone(zoneId, locationId) {
  await getZone(zoneId);
  const loc = await locationsService.getLocation(locationId);
  if (!loc.isActive) throw Object.assign(new Error('Location is inactive'), { status: 400 });
  return zonesRepo.addLocation(zoneId, locationId);
}

async function removeLocationFromZone(zoneId, locationId) { await getZone(zoneId); return zonesRepo.removeLocation(zoneId, locationId); }

/**
 * Depth-limited BFS collecting every ACTIVE descendant of a location id.
 * Used to answer "which zones cover this city?" when a zone was configured
 * against a neighbourhood inside the city instead of the city node itself.
 * A depth cap keeps a pathological/cyclic tree from hanging the request.
 */
async function descendantLocationIds(rootId, maxDepth = 6) {
  const ids = new Set([String(rootId)]);
  let frontier = [String(rootId)];
  for (let depth = 0; depth < maxDepth && frontier.length; depth += 1) {
    const next = [];
    for (const id of frontier) {
      let children = [];
      try {
        children = await locationsService.getChildren(id);
      } catch {
        children = []; // a vanished parent just stops this branch
      }
      for (const child of children) {
        const cid = String(child._id);
        if (!ids.has(cid)) {
          ids.add(cid);
          next.push(cid);
        }
      }
    }
    frontier = next;
  }
  return ids;
}

/**
 * The full geographic scope a location node implies: the node itself, everything
 * beneath it (a city covers its neighbourhoods) and its ancestors (a zone
 * configured on the region also serves the cities inside it).
 */
async function locationScopeIds(locationId) {
  const scope = new Set([String(locationId)]);
  try {
    for (const id of await descendantLocationIds(locationId)) scope.add(id);
  } catch { /* scope still holds the node itself */ }
  try {
    const ancestors = await locationsService.getAncestors(locationId);
    for (const ancestor of ancestors) scope.add(String(ancestor._id));
  } catch { /* scope still holds the node itself */ }
  return scope;
}

/**
 * Zones serving a location — the ONE eligibility read for "does delivery reach
 * here?".
 *
 * Matching order:
 *   1. zones that list the location explicitly (`Zone.locationIds`), and
 *   2. if none, zones that cover an ANCESTOR of the location. A zone configured
 *      on "Harar" must also serve "Jugol (a sector under Harar)" — the direct
 *      lookup alone made every child location answer "not covered" even though
 *      its city was inside the zone.
 *
 * Only active zones are ever returned: an inactive/suspended zone must not keep
 * validating addresses or orders.
 */
async function findZoneForLocation(locationId) {
  if (!locationId) return [];
  const direct = await zonesRepo.findByLocationId(locationId);
  if (direct.length > 0) return direct;

  let ancestors = [];
  try {
    ancestors = await locationsService.getAncestors(locationId);
  } catch {
    return []; // unknown location id — no coverage to report
  }
  if (!ancestors.length) return [];
  const ancestorIds = new Set(ancestors.map((loc) => String(loc._id)));
  const active = await zonesRepo.findActive();
  return active.filter((zone) =>
    (zone.locationIds || []).some((id) => ancestorIds.has(String(id))));
}

async function checkCoverage(locationId) {
  const zones = await findZoneForLocation(locationId);
  return { covered: zones.length > 0, zones: zones.map((z) => ({ id: z._id, name: z.name, code: z.code })) };
}

/**
 * Public projection of the zone catalogue for the marketplace location
 * selector. Minimal fields only (no operational rules, ports, providers or
 * geometry) and only active, serviceable zones — the selector must never offer
 * a zone a buyer cannot actually order into.
 *
 * With `cityId`, the list is narrowed to zones whose coverage scope (the city
 * itself, its descendants or its ancestors) intersects the city, so the buyer
 * sees exactly the zones that can serve their selected city.
 */
async function getPublicZones({ cityId } = {}) {
  const zones = await zonesRepo.findActive();
  const serviceable = zones.filter((z) => z.deliveryRules && z.deliveryRules.serviceable !== false);

  let scope = null;
  if (cityId) {
    scope = await locationScopeIds(cityId);
  }

  return serviceable
    .filter((z) => !scope || (z.locationIds || []).some((id) => scope.has(String(id))))
    .map((z) => ({
      _id: z._id,
      name: z.name,
      code: z.code,
      status: z.status,
      lifecycle: z.lifecycle || 'LIVE',
      portId: z.portId ? String(z.portId) : null,
      portName: z.portName || '',
      locationIds: (z.locationIds || []).map(String),
      deliveryFee: z.deliveryRules ? (z.deliveryRules.deliveryFee ?? 0) : 0,
      estimatedDeliveryTime: z.deliveryRules ? z.deliveryRules.estimatedDeliveryTime : null,
      // The buyer's delivery/pickup/COD promises must come from the zone's own
      // rules, never from a hardcoded panel in the storefront.
      codAvailable: z.deliveryRules ? z.deliveryRules.codAvailable !== false : false,
      pickupAvailable: z.deliveryRules ? Boolean(z.deliveryRules.pickupAvailable) : false,
      freeDeliveryThreshold: z.deliveryRules ? (z.deliveryRules.freeDeliveryThreshold ?? null) : null,
    }));
}

/**
 * Minimal zone lookup used by Commerce through the internal surface to
 * validate a zone id (checkout revalidation, coverage writes). Returns null
 * for an unknown id instead of throwing so callers decide the error code.
 */
async function getZoneSummary(id) {
  if (!id) return null;
  const zone = await zonesRepo.findById(id).catch(() => null);
  if (!zone) return null;
  return {
    _id: String(zone._id),
    name: zone.name,
    code: zone.code,
    status: zone.status,
    lifecycle: zone.lifecycle || 'LIVE',
    serviceable: Boolean(zone.deliveryRules && zone.deliveryRules.serviceable !== false),
  };
}

/** Batch variant of `getZoneSummary` (coverage writes validate many at once). */
async function getZoneSummaries(ids = []) {
  const unique = [...new Set((ids || []).map(String).filter(Boolean))];
  if (!unique.length) return [];
  const zones = await zonesRepo.findAll({ _id: { $in: unique } });
  return (zones || []).map((zone) => ({
    _id: String(zone._id),
    name: zone.name,
    code: zone.code,
    status: zone.status,
    lifecycle: zone.lifecycle || 'LIVE',
    serviceable: Boolean(zone.deliveryRules && zone.deliveryRules.serviceable !== false),
  }));
}

/** Quote the server-owned zone schedule. Missing bands use the configured
 * platform default; zones without bands retain their legacy flat fee. */
async function quoteDeliveryFee({ zoneId, locationId, quantity } = {}) {
  const qty = Number(quantity);
  if (!Number.isSafeInteger(qty) || qty < 1) {
    throw Object.assign(new Error('Quantity must be a positive whole number'), { status: 422, code: 'INVALID_QUANTITY' });
  }
  const settings = await DeliveryFeeSettings.findOneAndUpdate(
    { key: 'platform' },
    { $setOnInsert: { defaultFee: Number(process.env.DELIVERY_DEFAULT_FEE_ETB ?? 150), delivererShareRate: Number(process.env.DELIVERER_SHARE_PERCENT ?? 80) } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
  const defaultFee = Number(settings.defaultFee);
  if (!Number.isFinite(defaultFee) || defaultFee < 0) throw new Error('Invalid configured delivery default fee');
  let zone = zoneId ? await zonesRepo.findById(zoneId).catch(() => null) : null;
  if (locationId) {
    const covering = await findZoneForLocation(locationId);
    if (zoneId && !covering.some((candidate) => String(candidate._id) === String(zoneId))) {
      throw Object.assign(new Error('Selected delivery zone does not cover this address'), { status: 422, code: 'ZONE_ADDRESS_MISMATCH' });
    }
    if (!zone && covering.length) zone = covering[0];
  }
  if (zoneId && (!zone || zone.status !== 'active' || zone.deliveryRules?.serviceable === false)) {
    throw Object.assign(new Error('Delivery is not available in this zone'), { status: 422, code: 'ZONE_NOT_SERVICEABLE' });
  }
  const bands = (zone?.deliveryRules?.quantityFees || []).filter((band) => band.enabled !== false);
  const match = bands.find((band) => qty >= band.minQty && (band.maxQty == null || qty <= band.maxQty));
  const fee = match
    ? Number(match.fee)
    : (bands.length ? defaultFee : (zone ? Number(zone.deliveryRules?.deliveryFee || 0) : defaultFee));
  const shareRate = Number(settings.delivererShareRate);
  if (!Number.isFinite(shareRate) || shareRate < 0 || shareRate > 100) throw new Error('Invalid DELIVERER_SHARE_PERCENT configuration');
  return {
    fee: Math.round(fee * 100) / 100,
    ruleId: match ? String(match._id) : (zone && !bands.length ? String(zone._id) : null),
    zoneId: zone ? String(zone._id) : null,
    quantity: qty,
    source: match ? 'quantity_band' : (zone && !bands.length ? 'zone_flat' : 'default'),
    delivererShareRate: shareRate,
    // The zone's own promises travel with the quote, so the storefront shows
    // the SAME delivery time / COD / pickup facts the checkout was priced
    // against — one server-owned answer instead of a second hardcoded one.
    estimatedDeliveryTime: zone?.deliveryRules?.estimatedDeliveryTime ?? null,
    codAvailable: zone?.deliveryRules ? zone.deliveryRules.codAvailable !== false : false,
    pickupAvailable: zone?.deliveryRules ? Boolean(zone.deliveryRules.pickupAvailable) : false,
  };
}

async function getDeliveryFeeSettings() {
  return DeliveryFeeSettings.findOneAndUpdate(
    { key: 'platform' },
    { $setOnInsert: { defaultFee: Number(process.env.DELIVERY_DEFAULT_FEE_ETB ?? 150), delivererShareRate: Number(process.env.DELIVERER_SHARE_PERCENT ?? 80) } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

async function updateDeliveryFeeSettings(fields = {}) {
  const update = {};
  for (const key of ['defaultFee', 'delivererShareRate', 'minimumPayout', 'holdHours']) {
    if (fields[key] === undefined) continue;
    const value = Number(fields[key]);
    if (!Number.isFinite(value) || value < 0 || (key === 'delivererShareRate' && value > 100) || ((key === 'minimumPayout' || key === 'holdHours') && Math.round(value * 100) !== value * 100)) {
      throw Object.assign(new Error(`${key} is invalid`), { status: 422, code: 'INVALID_FEE_SETTING' });
    }
    update[key] = value;
  }
  if (!Object.keys(update).length) throw Object.assign(new Error('At least one setting is required'), { status: 422 });
  return DeliveryFeeSettings.findOneAndUpdate(
    { key: 'platform' },
    { $set: update, $setOnInsert: { key: 'platform' } },
    { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true },
  );
}

async function getZoneStats() {
  const allZones = await zonesRepo.findAll({});
  const activeZones = allZones.filter(z => z.status === 'active');
  const serviceableZones = allZones.filter(z => z.deliveryRules?.serviceable);
  const unassignedZones = allZones.filter(z => !z.locationIds || z.locationIds.length === 0);
  
  return {
    totalZones: allZones.length,
    activeZones: activeZones.length,
    serviceableZones: serviceableZones.length,
    unassignedZones: unassignedZones.length,
    zonesWithActiveRoutes: 0, // Will be calculated with route integration
  };
}

/** Centralized zone resolution: by explicit zoneId, else by location. */
async function resolveDeliveryArea({ zoneId, locationId } = {}) {
  if (zoneId) {
    const zone = await getZone(zoneId).catch(() => null);
    return zone || null;
  }
  if (locationId) {
    const zones = await findZoneForLocation(locationId);
    return zones && zones.length > 0 ? zones[0] : null;
  }
  return null;
}

/**
 * One serviceability verdict for the whole module — Requests, Deliveries and
 * Controllers must NOT reimplement these checks.
 */
function getZoneRequestability(zone, now = new Date()) {
  if (!zone) return { serviceable: false, reason: 'ZONE_NOT_FOUND' };
  if (zone.status === 'inactive' || zone.status === 'suspended') return { serviceable: false, reason: 'ZONE_NOT_AVAILABLE' };
  const lifecycle = zone.lifecycle || 'LIVE';
  if (lifecycle === 'PAUSED') return { serviceable: false, reason: 'ZONE_PAUSED' };
  if (lifecycle === 'DRAFT') return { serviceable: false, reason: 'ZONE_NOT_READY' };
  if (lifecycle === 'READY') return { serviceable: false, reason: 'ZONE_NOT_LIVE' };
  if (zone.deliveryRules && zone.deliveryRules.serviceable === false) return { serviceable: false, reason: 'SERVICE_NOT_AVAILABLE' };
  const hours = zone.operationalRules?.operatingHours;
  if (hours && hours.open && hours.close) {
    const hh = now.getHours() * 60 + now.getMinutes();
    const [oh, om] = hours.open.split(':').map(Number);
    const [ch, cm] = hours.close.split(':').map(Number);
    if (Number.isFinite(oh) && Number.isFinite(ch) && (hh < oh * 60 + om || hh > ch * 60 + cm)) {
      return { serviceable: false, reason: 'OUTSIDE_SERVICE_HOURS' };
    }
  }
  return { serviceable: true, reason: null };
}

/**
 * The Port that serves a Zone. One rule, used by every caller: a Zone may hold
 * several known local points, and the first ACTIVE one is the one that serves
 * new deliveries (the customer never picks a port).
 */
async function resolveZonePort(zoneId) {
  if (!zoneId) return null;
  const ports = await portsRepo.findActiveByZoneId(zoneId);
  return ports && ports.length > 0 ? ports[0] : null;
}

async function assertZoneRequestable(zone, now = new Date()) {
  const verdict = getZoneRequestability(zone, now);
  if (!verdict.serviceable) {
    throw Object.assign(new Error(`Zone not serviceable: ${verdict.reason}`), { status: 400, code: verdict.reason });
  }
  return verdict;
}

module.exports = {
  createZone, getZone, updateZone, deleteZone, getZones, countZones, getActiveZones, getZoneStats,
  addLocationToZone, removeLocationFromZone, findZoneForLocation, checkCoverage,
  resolveDeliveryArea, getZoneRequestability, assertZoneRequestable, resolveZonePort,
  getPublicZones, getZoneSummary, getZoneSummaries, quoteDeliveryFee, getDeliveryFeeSettings, updateDeliveryFeeSettings, descendantLocationIds, locationScopeIds,
};
