/**
 * Shop Delivery Coverage service tests.
 *
 * The Delivery client and shop repository are stubbed (monkeypatched) so the
 * suite never depends on another service being up — the REAL coverage logic
 * runs, so a broken link between layers fails here.
 */
const assert = require('assert');
const { describe, it, before, afterEach } = require('node:test');

const shopCoverageService = require('../services/shopCoverage.service');

let deliveryClient;
let shopRepository;

const TEST_ZONE_ID = 'zone-harar-city';
const TEST_ZONE = {
  _id: TEST_ZONE_ID,
  name: 'Harar City Zone',
  code: 'HZ-CITY',
  status: 'active',
  lifecycle: 'LIVE',
  serviceable: true,
};

function stubShop(overrides = {}) {
  const shop = {
    _id: 'shop-harar',
    name: 'Harar Electronics',
    status: 'APPROVED',
    locationSnapshot: {
      cityId: 'city-harar', cityName: 'Harar',
      sectorId: 'sector-jugol', sectorName: 'Jugol',
      fullAddress: 'Jugol area, Harar',
    },
    deliveryCoverage: {
      zoneIds: [TEST_ZONE_ID],
      zoneNames: [{ id: TEST_ZONE_ID, name: 'Harar City Zone' }],
      status: 'ACTIVE',
    },
    updatedAt: new Date(),
    ...overrides,
  };
  // Fake Mongoose save — `shopCoverage.service` persists through `shop.save()`.
  shop.save = async () => {
    shop.updatedAt = new Date();
    return shop;
  };
  return shop;
}

async function stubClients() {
  deliveryClient = require('../../../app/clients/delivery.client').deliveryClient;
  shopRepository = require('../repositories/shops.repository');

  deliveryClient.getZoneSummary = async (id) => ({
    status: 200, ok: true,
    body: { zone: String(id) === String(TEST_ZONE_ID) ? TEST_ZONE : null },
  });
  deliveryClient.getZonesForLocation = async () => ({
    status: 200, ok: true,
    body: { zones: [TEST_ZONE] },
  });
  deliveryClient.getZoneSummaries = async (input) => {
    // Real call passes an array (mapped to ?ids=) or { query: { ids } }; accept
    // both spellings so the suite is insensitive to route-shape drift.
    let ids = [];
    if (Array.isArray(input)) ids = input;
    else if (input && typeof input === 'object') {
      const fromQuery = input.query && input.query.ids;
      if (fromQuery) ids = String(fromQuery).split(',');
    }
    return {
      status: 200, ok: true,
      body: { zones: ids.map((id) => String(id) === String(TEST_ZONE_ID) ? TEST_ZONE : null).filter(Boolean) },
    };
  };
  shopRepository.findById = async () => stubShop();
}

describe('Shop Delivery Coverage', () => {
  before(async () => { await stubClients(); });
  afterEach(async () => { await stubClients(); });

  it('normalizes a legacy shop without coverage as UNCONFIGURED', () => {
    const cov = shopCoverageService.normalizeCoverage(stubShop({ deliveryCoverage: undefined }));
    assert.equal(cov.configured, false);
    assert.equal(cov.status, 'UNCONFIGURED');
    assert.deepEqual(cov.zoneIds, []);
  });

  it('normalizes an ACTIVE shop covering one zone', () => {
    const cov = shopCoverageService.normalizeCoverage(stubShop());
    assert.equal(cov.configured, true);
    assert.equal(cov.status, 'ACTIVE');
    assert.deepEqual(cov.zoneIds, [TEST_ZONE_ID]);
  });

  it('verdictForShop: shop serving the selected zone → servesZone', () => {
    const v = shopCoverageService.verdictForShop(stubShop(), TEST_ZONE_ID, 'Harar City Zone');
    assert.equal(v.servesZone, true);
    assert.equal(v.code, null);
  });

  it('verdictForShop: unconfigured shop → LOCATION_NOT_CONFIGURED', () => {
    const v = shopCoverageService.verdictForShop(
      stubShop({ deliveryCoverage: { zoneIds: [], status: 'UNCONFIGURED' } }),
      TEST_ZONE_ID, 'Harar City Zone'
    );
    assert.equal(v.code, 'LOCATION_NOT_CONFIGURED');
    assert.equal(v.servesZone, false);
  });

  it('verdictForShop: shop serving a different zone → SHOP_NOT_SERVING_ZONE', () => {
    const v = shopCoverageService.verdictForShop(
      stubShop({ deliveryCoverage: { zoneIds: ['zone-other'], zoneNames: [], status: 'ACTIVE' } }),
      TEST_ZONE_ID, 'Harar City Zone'
    );
    assert.equal(v.code, 'SHOP_NOT_SERVING_ZONE');
    assert.equal(v.servesZone, false);
    assert.ok(v.message.includes('does not deliver'));
  });

  it('assertShopsServeZone: all shops serve the zone → OK', async () => {
    const shops = [stubShop(), stubShop({ _id: 'shop-2', name: 'Fresh Market' })];
    const verdicts = await shopCoverageService.assertShopsServeZone(shops, { id: TEST_ZONE_ID, name: 'Harar City Zone' });
    assert.equal(verdicts.length, 2);
    assert.ok(verdicts.every((v) => v.servesZone));
  });

  it('assertShopsServeZone: one failing shop blocks the whole order with that shop\'s code', async () => {
    const shops = [
      stubShop({ _id: 'shop-fail', name: 'Broken Shop', deliveryCoverage: { zoneIds: [], status: 'UNCONFIGURED' } }),
    ];
    await assert.rejects(
      () => shopCoverageService.assertShopsServeZone(shops, { id: TEST_ZONE_ID, name: 'Harar City Zone' }),
      (err) => err.code === 'LOCATION_NOT_CONFIGURED' && err.statusCode === 400
    );
  });

  it('assertShopsServeZone: two shops, one failing → ZONE_MISMATCH', async () => {
    const shops = [
      stubShop(),
      stubShop({ _id: 'shop-2', name: 'Fresh Market', deliveryCoverage: { zoneIds: ['zone-other'], status: 'ACTIVE' } }),
    ];
    await assert.rejects(
      () => shopCoverageService.assertShopsServeZone(shops, { id: TEST_ZONE_ID, name: 'Harar City Zone' }),
      (err) => err.code === 'ZONE_MISMATCH' && err.statusCode === 400
    );
  });

  it('assertShopsServeZone: mixed cart → ZONE_MISMATCH', async () => {
    const shops = [
      stubShop(),
      stubShop({ _id: 'shop-2', name: 'Fresh Market', deliveryCoverage: { zoneIds: ['zone-other'], status: 'ACTIVE' } }),
    ];
    await assert.rejects(
      () => shopCoverageService.assertShopsServeZone(shops, { id: TEST_ZONE_ID, name: 'Harar City Zone' }),
      (err) => err.code === 'ZONE_MISMATCH' && err.statusCode === 400
    );
  });

  it('assertShopsServeZone: missing zone → INVALID_DELIVERY_LOCATION', async () => {
    await assert.rejects(
      () => shopCoverageService.assertShopsServeZone([stubShop()], null),
      (err) => err.code === 'INVALID_DELIVERY_LOCATION'
    );
  });

  it('resolveDestinationZone: explicit zone returned (name from Delivery)', async () => {
    const zone = await shopCoverageService.resolveDestinationZone({
      deliveryZoneId: TEST_ZONE_ID, deliveryZoneName: 'Harar City Zone',
    });
    assert.equal(zone.id, TEST_ZONE_ID);
    assert.equal(zone.name, 'Harar City Zone');
  });

  it('resolveDestinationZone: zone definitively unknown → INVALID_DELIVERY_LOCATION', async () => {
    await assert.rejects(
      () => shopCoverageService.resolveDestinationZone({ deliveryZoneId: 'zone-does-not-exist' }),
      (err) => err.code === 'INVALID_DELIVERY_LOCATION'
    );
  });

  it('resolveDestinationZone: no zone and no location → INVALID_DELIVERY_LOCATION', async () => {
    await assert.rejects(
      () => shopCoverageService.resolveDestinationZone({}),
      (err) => err.code === 'INVALID_DELIVERY_LOCATION'
    );
  });

  it('setCoverage: rejects unknown zone ids', async () => {
    await assert.rejects(
      () => shopCoverageService.setCoverage('shop-harar', { zoneIds: ['zone-unknown'], status: 'ACTIVE' }, { id: 'admin-1' }),
      (err) => err.code === 'INVALID_DELIVERY_LOCATION' && err.statusCode === 400
    );
  });

  it('setCoverage: accepts and persists validated zones', async () => {
    const updated = await shopCoverageService.setCoverage('shop-harar', { zoneIds: [TEST_ZONE_ID], status: 'ACTIVE' }, { id: 'admin-1' });
    assert.equal(updated.deliveryCoverage.status, 'ACTIVE');
    assert.deepEqual(updated.deliveryCoverage.zoneIds, [TEST_ZONE_ID]);
    assert.equal(updated.deliveryCoverage.zoneNames[0].name, 'Harar City Zone');
    assert.ok(updated.deliveryCoverage.verifiedAt);
  });

  it('setCoverage: clearing coverage → UNCONFIGURED', async () => {
    const updated = await shopCoverageService.setCoverage('shop-harar', { zoneIds: [], status: 'UNCONFIGURED' }, { id: 'admin-1' });
    assert.equal(updated.deliveryCoverage.status, 'UNCONFIGURED');
    assert.deepEqual(updated.deliveryCoverage.zoneIds, []);
  });
});