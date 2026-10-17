const { deliveryClient } = require('../../../app/clients/delivery.client');
const shopRepository = require('../repositories/shops.repository');

/**
 * Shop Delivery Coverage — WHICH DELIVERY ZONES A SHOP SERVES.
 *
 * Ownership rules:
 *   * Delivery owns the zone catalogue (definitions, status, lifecycle). This
 *     module only ever stores zone REFERENCES on the shop (ids + the validated
 *     name snapshot) and revalidates them against Delivery on every write.
 *   * Commerce owns the shop, so the shop's service areas live here — next to
 *     (but strictly separate from) the shop's physical `locationSnapshot`.
 *   * Checkout/cart validation is authoritative HERE: the frontend may hide or
 *     flag items, but an order is only created when every shop passes
 *     `assertShopsServeZone` for the ONE zone of the order.
 *
 * Failure codes (shared with the frontend):
 *   LOCATION_NOT_CONFIGURED  — the shop has no configured coverage at all
 *   SHOP_NOT_SERVING_ZONE    — coverage exists but excludes the selected zone
 *                              (or the coverage is paused)
 *   INVALID_DELIVERY_LOCATION— the buyer's zone is missing/unknown/inactive
 *   ZONE_MISMATCH            — cart-level: shops disagree about the zone
 */
class ZoneError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** A zone summary looked up from Delivery expires after this long. */
const ZONE_TTL_MS = 60 * 1000;
/** id -> { at, zone|null, authoritative } — never let a stale entry go dark. */
const zoneCache = new Map();

/**
 * Resolve one zone against Delivery (cached briefly).
 *
 * Returns `{ zone, authoritative }`:
 *   * authoritative true  — Delivery answered; `zone === null` means the id is
 *     genuinely unknown and the caller MUST fail with INVALID_DELIVERY_LOCATION.
 *   * authoritative false — Delivery could not be reached (transport failure).
 *     The id is neither confirmed nor refuted; callers proceed with the id the
 *     buyer's address carries (coverage checks still run in full) and the miss
 *     is logged. Failing closed here would take ALL checkouts down whenever the
 *     Delivery service restarts, while the zone rule itself stays enforced.
 */
async function resolveZone(zoneId, { force = false } = {}) {
  const id = String(zoneId || '').trim();
  if (!id) return { zone: null, authoritative: true };

  const cached = zoneCache.get(id);
  if (!force && cached && Date.now() - cached.at < ZONE_TTL_MS) {
    return { zone: cached.zone, authoritative: cached.authoritative };
  }

  let entry;
  try {
    const res = await deliveryClient.getZoneSummary(id);
    if (res.status === 0) {
      // Transport failure — unknown, not refuted.
      entry = { at: Date.now(), zone: cached ? cached.zone : null, authoritative: false };
    } else if (!res.ok || !res.body || !res.body.zone) {
      entry = { at: Date.now(), zone: null, authoritative: true };
    } else {
      entry = { at: Date.now(), zone: res.body.zone, authoritative: true };
    }
  } catch (err) {
    console.error('[coverage] zone lookup failed:', err.message);
    entry = { at: Date.now(), zone: cached ? cached.zone : null, authoritative: false };
  }
  zoneCache.set(id, entry);
  return { zone: entry.zone, authoritative: entry.authoritative };
}

/** Drop cached zone lookups (tests / after an admin edits a zone). */
function clearZoneCache() {
  zoneCache.clear();
}

/** Is a Delivery zone currently orderable? (active + LIVE + not disabled) */
function zoneOrderable(zone) {
  if (!zone) return false;
  if (zone.status && zone.status !== 'active') return false;
  if (zone.lifecycle && zone.lifecycle !== 'LIVE') return false;
  if (zone.serviceable === false) return false;
  if (zone.deliveryRules && zone.deliveryRules.serviceable === false) return false;
  return true;
}

/**
 * Normalized coverage view for one shop. An absent/empty block (every legacy
 * document) is UNCONFIGURED — never inferred, never guessed.
 */
function normalizeCoverage(shop) {
  const cov = shop && shop.deliveryCoverage;
  const zoneIds = (cov && Array.isArray(cov.zoneIds) ? cov.zoneIds : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  let status = (cov && cov.status) || 'UNCONFIGURED';
  if (!zoneIds.length) status = 'UNCONFIGURED';
  if (status !== 'ACTIVE' && status !== 'PAUSED') status = 'UNCONFIGURED';
  const zoneNames = (cov && Array.isArray(cov.zoneNames) ? cov.zoneNames : [])
    .filter((entry) => entry && entry.id)
    .map((entry) => ({ id: String(entry.id), name: String(entry.name || '') }));
  return {
    configured: status !== 'UNCONFIGURED' && zoneIds.length > 0,
    status,
    zoneIds,
    zoneNames,
    source: (cov && cov.source) || null,
    verifiedAt: (cov && cov.verifiedAt) || null,
    updatedAt: (cov && cov.updatedAt) || null,
  };
}

/** Display name for a zone id from the denormalized snapshot (fallback: id). */
function zoneDisplayName(coverage, zoneId) {
  const hit = coverage.zoneNames.find((entry) => entry.id === String(zoneId));
  return hit ? hit.name : '';
}

/**
 * Non-throwing eligibility verdict for ONE shop against the buyer's zone.
 * Used by cart validation, add-to-cart warnings and discovery payloads alike so
 * every surface reports the same code/message pair.
 *
 * @returns {{shopId, shopName, configured, status, zoneIds, zoneNames,
 *            servesZone, code, message}}
 */
function verdictForShop(shop, zoneId, zoneName) {
  const coverage = normalizeCoverage(shop);
  const shopName = (shop && shop.name) || 'This shop';
  const base = {
    shopId: shop ? String(shop._id) : '',
    shopName,
    configured: coverage.configured,
    status: coverage.status,
    zoneIds: coverage.zoneIds,
    zoneNames: coverage.zoneNames,
    servesZone: false,
    code: null,
    message: null,
  };

  if (!shop) {
    return { ...base, code: 'LOCATION_NOT_CONFIGURED', message: 'Shop not found — delivery coverage cannot be verified' };
  }
  if (!coverage.configured) {
    return {
      ...base,
      code: 'LOCATION_NOT_CONFIGURED',
      message: `${shopName} has no delivery coverage configured — it cannot be delivered to yet`,
    };
  }
  if (coverage.status !== 'ACTIVE') {
    return {
      ...base,
      code: 'SHOP_NOT_SERVING_ZONE',
      message: `${shopName} is temporarily not delivering to ${zoneName || 'your selected zone'}`,
    };
  }
  if (!zoneId) {
    return {
      ...base,
      code: 'INVALID_DELIVERY_LOCATION',
      message: 'No delivery zone selected',
    };
  }
  if (!coverage.zoneIds.includes(String(zoneId))) {
    const zones = coverage.zoneNames.map((entry) => entry.name).filter(Boolean).join(', ');
    return {
      ...base,
      code: 'SHOP_NOT_SERVING_ZONE',
      message: `${shopName} does not deliver to ${zoneName || 'your selected zone'}`
        + (zones ? ` (it serves: ${zones})` : ''),
    };
  }
  return { ...base, servesZone: true };
}

/**
 * AUTHORITATIVE checkout rule: every shop in the order must serve the order's
 * ONE delivery zone. Throws the most specific code available:
 *   * no zone / zone definitively unknown  → INVALID_DELIVERY_LOCATION
 *   * no shop configured                   → LOCATION_NOT_CONFIGURED
 *   * some pass, some fail                 → ZONE_MISMATCH (mixed cart)
 *   * a single failing shop                → that shop's specific code
 *
 * @param {Array} shops shop documents (or null for a vanished shop)
 * @param {{id, name}} zone the order's resolved delivery zone
 */
async function assertShopsServeZone(shops, zone) {
  if (!zone || !zone.id) {
    throw new ZoneError(
      'A valid delivery zone is required for this order',
      400,
      'INVALID_DELIVERY_LOCATION'
    );
  }
  const { zone: zoneDoc, authoritative } = await resolveZone(zone.id);
  if (authoritative && (!zoneDoc || !zoneOrderable(zoneDoc))) {
    throw new ZoneError(
      'The selected delivery zone is not available for delivery',
      400,
      'INVALID_DELIVERY_LOCATION'
    );
  }

  const verdicts = (shops || []).map((shop) => verdictForShop(shop, zone.id, zone.name));
  const failures = verdicts.filter((verdict) => !verdict.servesZone);
  if (!failures.length) return verdicts;

  const passing = verdicts.length - failures.length;
  if (passing > 0) {
    const names = failures.map((verdict) => verdict.shopName).join(', ');
    throw new ZoneError(
      `Some shops in this order do not deliver to ${zone.name}: ${names}. `
      + 'Remove those items or start a separate order for them.',
      400,
      'ZONE_MISMATCH'
    );
  }
  const first = failures[0];
  throw new ZoneError(first.message, 400, first.code || 'SHOP_NOT_SERVING_ZONE');
}

/**
 * Resolve the delivery zone an ORDER must record.
 *
 * Preference order:
 *   1. the explicit `destination.deliveryZoneId` (saved address / buyer
 *      selection) — validated against Delivery;
 *   2. otherwise, the zones covering the destination location (ancestor-aware,
 *      asked of Delivery) — first orderable zone wins.
 *
 * Never invents a zone: when neither yields one the caller gets
 * INVALID_DELIVERY_LOCATION and checkout is refused.
 */
async function resolveDestinationZone(destination = {}) {
  const explicit = String(destination.deliveryZoneId || '').trim();
  if (explicit) {
    const { zone, authoritative } = await resolveZone(explicit);
    if (authoritative && (!zone || !zoneOrderable(zone))) {
      throw new ZoneError(
        'The delivery zone for this address is not available',
        400,
        'INVALID_DELIVERY_LOCATION'
      );
    }
    return {
      id: explicit,
      name: (zone && zone.name) || String(destination.deliveryZoneName || '') || '',
      authoritative: Boolean(authoritative && zone),
    };
  }

  const locationId = destination.sectorId || destination.cityId || destination.locationId || null;
  if (!locationId) {
    throw new ZoneError(
      'No delivery zone covers this address — choose a delivery location first',
      400,
      'INVALID_DELIVERY_LOCATION'
    );
  }

  let zones = [];
  try {
    const res = await deliveryClient.getZonesForLocation(locationId);
    if (res.status === 0) {
      // Transport failure: Delivery is unreachable. Degrade to a best-effort
      // zone (the destination's sector) so checkout is not taken down by a
      // peer-service outage. The zone is unverified (authoritative: false).
      return { id: String(locationId), name: '', authoritative: false };
    }
    zones = (res.body && res.body.zones) || [];
  } catch (err) {
    if (err instanceof ZoneError) throw err;
    console.error('[coverage] zone-for-location lookup failed:', err.message);
    // Degraded: Delivery unreachable — best-effort zone from the destination.
    return { id: String(locationId), name: '', authoritative: false };
  }

  const orderable = zones.find(zoneOrderable);
  if (!orderable) {
    throw new ZoneError(
      'No delivery zone covers this address — delivery is not available here yet',
      400,
      'INVALID_DELIVERY_LOCATION'
    );
  }
  return {
    id: String(orderable._id),
    name: String(orderable.name || ''),
    authoritative: true,
  };
}

/**
 * PUBLIC payload projection: the location + coverage facts a buyer needs on a
 * card/detail page, with the "do you serve the selected zone?" answer when a
 * zone was supplied. No admin-only fields (verifiedBy etc.) are exposed.
 */
function publicDeliveryInfo(shop, selectedZoneId) {
  const snapshot = (shop && shop.locationSnapshot) || {};
  const coverage = normalizeCoverage(shop);
  const locationVerified = Boolean(
    shop && (snapshot.resolvedAt || snapshot.cityId || shop.sectorId || shop.locationId)
  );
  const selected = String(selectedZoneId || '').trim();
  return {
    locationVerified,
    regionName: snapshot.regionName || '',
    cityName: snapshot.cityName || '',
    areaName: snapshot.areaName || '',
    sectorName: snapshot.sectorName || '',
    address: snapshot.fullAddress || (shop && shop.address) || '',
    landmark: snapshot.landmark || '',
    coverageConfigured: coverage.configured,
    coverageStatus: coverage.status,
    zoneIds: coverage.zoneIds,
    zoneNames: coverage.zoneNames,
    servesSelectedZone: selected
      ? Boolean(coverage.configured && coverage.status === 'ACTIVE' && coverage.zoneIds.includes(selected))
      : null,
  };
}

/**
 * ADMIN write: set a shop's service areas. Zones are validated against
 * Delivery (the zone catalogue is not duplicated here) and the validated names
 * are denormalized into the payload so public reads stay local.
 *
 * Clearing the list returns the shop to UNCONFIGURED (checkout blocked) —
 * there is deliberately no "assume one zone" fallback.
 */
async function setCoverage(shopId, { zoneIds, status } = {}, admin = {}) {
  const shop = await shopRepository.findById(shopId);
  if (!shop) throw new ZoneError('Shop not found', 404, 'SHOP_NOT_FOUND');

  const ids = [...new Set((Array.isArray(zoneIds) ? zoneIds : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
  const now = new Date();
  const actor = admin && (admin.id || admin.adminId) ? String(admin.id || admin.adminId) : null;

  if (!ids.length) {
    shop.deliveryCoverage = {
      zoneIds: [],
      zoneNames: [],
      status: 'UNCONFIGURED',
      source: 'ADMIN',
      verifiedBy: actor,
      verifiedAt: now,
      updatedAt: now,
    };
    await shop.save();
    return shop;
  }

  let remoteZones = [];
  try {
    const res = await deliveryClient.getZoneSummaries(ids);
    if (res.status === 0) throw new Error('delivery unreachable');
    if (!res.ok) {
      throw new ZoneError('Delivery zone catalogue rejected the request', 400, 'INVALID_DELIVERY_LOCATION');
    }
    remoteZones = (res.body && res.body.zones) || [];
  } catch (err) {
    if (err instanceof ZoneError) throw err;
    console.error('[coverage] zone validation failed:', err.message);
    throw new ZoneError(
      'Delivery zone catalogue is unavailable — coverage was NOT saved',
      503,
      'DELIVERY_UNAVAILABLE'
    );
  }

  const found = new Map(remoteZones.map((zone) => [String(zone._id), zone]));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) {
    throw new ZoneError(
      `Unknown delivery zone(s): ${missing.join(', ')}`,
      400,
      'INVALID_DELIVERY_LOCATION'
    );
  }
  const notServiceable = ids
    .map((id) => found.get(id))
    .filter((zone) => !zoneOrderable(zone));
  if (notServiceable.length) {
    throw new ZoneError(
      `Zone(s) not currently serviceable: ${notServiceable.map((zone) => zone.name).join(', ')}`,
      400,
      'INVALID_DELIVERY_LOCATION'
    );
  }

  shop.deliveryCoverage = {
    zoneIds: ids,
    zoneNames: ids.map((id) => ({ id, name: String(found.get(id).name || '') })),
    status: status === 'PAUSED' ? 'PAUSED' : 'ACTIVE',
    source: 'ADMIN',
    verifiedBy: actor,
    verifiedAt: now,
    updatedAt: now,
  };
  await shop.save();
  return shop;
}

/** Normalized coverage for one shop id (or null when the shop is gone). */
async function getCoverage(shopId) {
  const shop = await shopRepository.findById(shopId);
  if (!shop) return null;
  return { shopId: String(shop._id), shopName: shop.name, ...normalizeCoverage(shop) };
}

/**
 * Attach a `shopDelivery` block (physical location + coverage + the answer for
 * the buyer's selected zone) to every product in a list/detail result. ONE
 * lookup per distinct shop and the SAME projection the public shop payloads
 * use, so product cards, shop pages, search results and the cart can never
 * disagree about a shop's eligibility.
 *
 * A product whose shop has vanished gets the "not configured" projection —
 * never an invented location.
 */
async function attachShopDeliveryContext(products, { zoneId = null } = {}) {
  const rows = Array.isArray(products) ? products : (products ? [products] : []);
  if (!rows.length) return products;

  const ids = [...new Set(rows
    .map((row) => String(row.shopId || (row.shop && row.shop._id) || ''))
    .filter(Boolean))];
  const shopDocs = ids.length ? await Promise.all(ids.map((id) => shopRepository.findById(id))) : [];
  const shopMap = new Map();
  shopDocs.forEach((shop, index) => {
    if (shop) shopMap.set(ids[index], shop);
  });

  for (const row of rows) {
    const sid = String(row.shopId || (row.shop && row.shop._id) || '');
    row.shopDelivery = publicDeliveryInfo(sid ? (shopMap.get(sid) || null) : null, zoneId);
  }
  return products;
}

module.exports = {
  ZoneError,
  resolveZone,
  resolveDestinationZone,
  clearZoneCache,
  zoneOrderable,
  normalizeCoverage,
  zoneDisplayName,
  verdictForShop,
  assertShopsServeZone,
  publicDeliveryInfo,
  attachShopDeliveryContext,
  setCoverage,
  getCoverage,
};


