/**
 * Zone delivery rules — the storefront's source of truth.
 *
 * The buyer's delivery options (delivery / pickup / cash on delivery), the
 * delivery TIME and the free-delivery threshold are all zone rules that the
 * delivery admin edits. They travel with the zone's public projection and
 * with the checkout fee quote, so the cart, the checkout and the storefront's
 * availability panel all show the SAME server-owned answer instead of a
 * hardcoded promise.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../../..');

const zones = [];
let feeSettings = { _id: 'settings-1', key: 'platform', defaultFee: 150, delivererShareRate: 80, minimumPayout: 0, holdHours: 24 };

function stub(relPath, exports) {
  const resolved = require.resolve(path.join(ROOT, relPath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stub('src/modules/locations-expansion/repositories/zones.repository.js', {
  async findActive() { return zones.filter((z) => z.status === 'active'); },
  async findAll(filter = {}) {
    return zones.filter((z) => {
      if (filter._id?.$in) return filter._id.$in.map(String).includes(String(z._id));
      return true;
    });
  },
  async findById(id) { return zones.find((z) => String(z._id) === String(id)) || null; },
  async findByCode(code) { return zones.find((z) => z.code === code) || null; },
  // A location is covered by the zones that list it. The seeded zone covers
  // 'loc-1' and nothing else.
  async findByLocationId(locationId) { return zones.filter((z) => (z.locationIds || []).map(String).includes(String(locationId))); },
  async create(data) { const doc = { _id: `zone-${zones.length + 1}`, ...data }; zones.push(doc); return doc; },
  async updateFields(id, fields) { const z = zones.find((x) => String(x._id) === String(id)); if (z) Object.assign(z, fields); return z; },
  async count() { return zones.length; },
  async findAllByLocationIds() { return []; },
});
stub('src/modules/locations-expansion/services/locations.service.js', {
  async getLocation() { return null; },
  async getLocations() { return []; },
  async getChildren() { return []; },
  async findById() { return null; },
  async locationScopeIds() { return new Set(); },
  async descendantLocationIds() { return new Set(); },
  async getLocationStats() { return {}; },
  async createLocation() { return null; },
  async updateLocation() { return null; },
  async deleteLocation() { return null; },
  async getAncestors() { return []; },
  async searchLocations() { return []; },
});
stub('src/modules/operations/repositories/ports.repository.js', {
  async findAll() { return []; },
  async findByZone() { return []; },
  async findById() { return null; },
  async create() { return null; },
  async updateFields() { return null; },
  async count() { return 0; },
});
stub('src/modules/locations-expansion/models/DeliveryFeeSettings.js', {
  async findOneAndUpdate(_filter, update) {
    if (update?.$setOnInsert) Object.assign(feeSettings, update.$setOnInsert);
    if (update?.$set) Object.assign(feeSettings, update.$set);
    return feeSettings;
  },
});

const zonesService = require(path.join(ROOT, 'src/modules/locations-expansion/services/zones.service.js'));

function seedZone(overrides = {}) {
  const zone = {
    _id: `zone-${zones.length + 1}`,
    name: 'Central',
    code: `ZC${zones.length + 1}`,
    status: 'active',
    lifecycle: 'LIVE',
    locationIds: ['loc-1'],
    deliveryRules: {
      serviceable: true,
      deliveryFee: 120,
      quantityFees: [],
      freeDeliveryThreshold: 1000,
      estimatedDeliveryTime: '2-3 days',
      minimumOrder: null,
      codAvailable: true,
      pickupAvailable: false,
    },
    ...overrides,
  };
  zones.push(zone);
  return zone;
}

beforeEach(() => {
  zones.length = 0;
  feeSettings = { _id: 'settings-1', key: 'platform', defaultFee: 150, delivererShareRate: 80, minimumPayout: 0, holdHours: 24 };
});

describe('zone delivery rules', () => {
  it('the public zone list carries the delivery rules the storefront shows', async () => {
    seedZone();
    const [zone] = await zonesService.getPublicZones();

    assert.equal(zone.estimatedDeliveryTime, '2-3 days');
    assert.equal(zone.codAvailable, true);
    assert.equal(zone.pickupAvailable, false);
    assert.equal(zone.freeDeliveryThreshold, 1000);
    assert.equal(zone.deliveryFee, 120);
  });

  it('a non-serviceable zone is never offered to the storefront', async () => {
    seedZone({ deliveryRules: { serviceable: false, deliveryFee: 100, estimatedDeliveryTime: '1 day', codAvailable: true, pickupAvailable: true } });
    const list = await zonesService.getPublicZones();
    assert.equal(list.length, 0);
  });

  it('an inactive zone is never offered to the storefront', async () => {
    seedZone({ status: 'inactive' });
    const list = await zonesService.getPublicZones();
    assert.equal(list.length, 0);
  });

  it('the fee quote carries the same rules, so price and promise come from one answer', async () => {
    const zone = seedZone();
    const quote = await zonesService.quoteDeliveryFee({ zoneId: zone._id, quantity: 1 });

    assert.equal(quote.fee, 120);
    assert.equal(quote.estimatedDeliveryTime, '2-3 days');
    assert.equal(quote.codAvailable, true);
    assert.equal(quote.pickupAvailable, false);
  });

  it('the fee quote prices by quantity band and still carries the rules', async () => {
    const zone = seedZone({
      deliveryRules: {
        serviceable: true,
        deliveryFee: 120,
        quantityFees: [
          { minQty: 1, maxQty: 2, fee: 100 },
          { minQty: 3, maxQty: null, fee: 180 },
        ],
        estimatedDeliveryTime: 'same day',
        codAvailable: false,
        pickupAvailable: true,
      },
    });

    const small = await zonesService.quoteDeliveryFee({ zoneId: zone._id, quantity: 2 });
    assert.equal(small.fee, 100);
    assert.equal(small.source, 'quantity_band');

    const large = await zonesService.quoteDeliveryFee({ zoneId: zone._id, quantity: 5 });
    assert.equal(large.fee, 180);

    // The rules travel with every quote, whatever the band.
    assert.equal(large.estimatedDeliveryTime, 'same day');
    assert.equal(large.codAvailable, false);
    assert.equal(large.pickupAvailable, true);
  });

  it('a zone that does not cover the address is refused (422)', async () => {
    const zone = seedZone();
    await assert.rejects(
      () => zonesService.quoteDeliveryFee({ zoneId: zone._id, locationId: 'somewhere-else', quantity: 1 }),
      (err) => err.status === 422,
    );
  });

  it('a quantity that is not a positive whole number is refused (422)', async () => {
    const zone = seedZone();
    for (const quantity of [0, -1, 1.5, 'abc']) {
      await assert.rejects(
        () => zonesService.quoteDeliveryFee({ zoneId: zone._id, quantity }),
        (err) => err.status === 422 && err.code === 'INVALID_QUANTITY',
        `quantity ${quantity} must be refused`,
      );
    }
  });
});
