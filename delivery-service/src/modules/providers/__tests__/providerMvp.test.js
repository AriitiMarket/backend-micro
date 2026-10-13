/**
 * Provider MVP lifecycle tests — self-apply, admin-created provider, approve,
 * reject, activate, deactivate, location assignment and the account-status vs
 * availability split.
 *
 * The repository and the Identity/audit clients are replaced with in-memory
 * fakes (via the require cache, the same pattern as the operations tests) so the
 * REAL service logic runs without a database or network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// __dirname = <service>/src/modules/providers/__tests__ — three levels up is the
// service root, where `src/...` paths resolve from.
const ROOT = path.resolve(__dirname, '../../../..');

// ---- In-memory fakes -------------------------------------------------------
const store = { providers: [], audits: [], nextId: 1 };
let seq = 0;
const oid = () => `p${String(++seq)}`;

function defaults(data) {
  return {
    status: 'pending',
    availability: { isOnline: false, lastSeenAt: null },
    zoneIds: [],
    metadata: {},
    activeDeliveries: 0,
    maxActiveAssignments: 3,
    maxCapacityKg: 10,
    currentWorkloadIds: [],
    completedDeliveries: 0,
    ...(data || {}),
  };
}

const providersRepo = {
  async create(data) {
    const doc = { _id: oid(), ...defaults(data) };
    store.providers.push(doc);
    return doc;
  },
  async findById(id) {
    return store.providers.find((p) => String(p._id) === String(id)) || null;
  },
  async findByIdentityUserId(uid) {
    return store.providers.find((p) => p.identityUserId === uid) || null;
  },
  async findAll(filter = {}) {
    let out = store.providers;
    if (filter.status) out = out.filter((p) => p.status === filter.status);
    return out;
  },
  async count(filter = {}) { return (await providersRepo.findAll(filter)).length; },
  async updateFields(id, fields) {
    const p = await providersRepo.findById(id);
    if (!p) return null;
    // Handle dotted availability keys the way mongoose would.
    for (const [key, value] of Object.entries(fields)) {
      if (key.startsWith('availability.')) {
        p.availability = p.availability || {};
        p.availability[key.slice('availability.'.length)] = value;
      } else {
        p[key] = value;
      }
    }
    return p;
  },
  async remove(id) {
    store.providers = store.providers.filter((p) => String(p._id) !== String(id));
  },
  async findAvailable() { return store.providers.filter((p) => p.status === 'available'); },
  async findAvailableForAssignment() {
    return store.providers.filter((p) => p.status === 'available' && p.availability?.isOnline);
  },
  async findByZone(zoneId) {
    return store.providers.filter(
      (p) => String(p.zoneId) === String(zoneId) || (p.zoneIds || []).some((z) => String(z) === String(zoneId)),
    );
  },
  async findByPort(portId) {
    return store.providers.filter((p) => String(p.portId) === String(portId));
  },
};

const identityClient = {
  grants: [],
  async grantProviderRole(userId) { identityClient.grants.push(userId); return { granted: true }; },
  async setProviderMembershipStatus() { return { ok: true }; },
  async markOnboardingComplete() { return { ok: true }; },
};

const auditClient = {
  ACTIONS: {}, LEVELS: {},
  async sendAudit(entry) { store.audits.push(entry); return null; },
  getAdminFromReq() { return { adminId: null, adminName: 'Admin', ipAddress: null }; },
  getActorFromReq() { return { actor: { id: null, name: 'Admin', role: null } }; },
};

function stub(relPath, exports) {
  const resolved = require.resolve(path.join(ROOT, relPath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stub('src/modules/providers/repositories/providers.repository.js', providersRepo);
stub('src/shared/utils/identity-client.js', identityClient);
stub('src/shared/utils/audit-client.js', auditClient);

const providersService = require(path.join(ROOT, 'src/modules/providers/services/providers.service.js'));
const applicationsService = require(path.join(ROOT, 'src/modules/providers/services/providerApplications.service.js'));
const eligibility = require(path.join(ROOT, 'src/modules/providers/services/provider-eligibility.service.js'));

function reset() {
  store.providers = [];
  store.audits = [];
  identityClient.grants = [];
}

const admin = { id: 'admin-1', name: 'Test Admin' };

// ---- Provider registration -------------------------------------------------

test('provider self-apply creates ONE pending provider carrying the requested location', async () => {
  reset();
  const { provider, created } = await applicationsService.applyForProvider('user-1', {
    name: 'Ahmed Delivery',
    phone: '0911000001',
    email: 'ahmed@example.com',
    providerType: 'individual_rider',
    vehicleType: 'motorcycle',
    zoneIds: ['zone-central'],
    portId: 'port-main',
    cityId: 'city-harar',
    metadata: { vehicleModel: 'Honda CG' },
  });

  assert.equal(created, true);
  assert.equal(provider.status, 'pending');
  assert.equal(provider.identityUserId, 'user-1');
  // The application IS the provider record — same model, no second system.
  assert.equal(provider.metadata.application.vehicleModel, 'Honda CG');
  // Requested operating location rides along for the admin's review (§4).
  assert.deepEqual(provider.zoneIds, ['zone-central']);
  assert.equal(provider.portId, 'port-main');
  assert.equal(provider.cityId, 'city-harar');
});

test('re-applying after a rejection returns the record to pending AND clears the previous application fully', async () => {
  reset();
  await applicationsService.applyForProvider('user-2', {
    name: 'Hassan', phone: '0911000002',
    zoneIds: ['zone-old'], portId: 'port-old', cityId: 'city-old',
    metadata: { experience: 'old experience', vehicleModel: 'Old Bike' },
  });
  const first = await providersRepo.findByIdentityUserId('user-2');
  await providersService.rejectProvider(first._id, 'Incomplete documents', admin);

  // The applicant re-applies WITHOUT a location and with fresh answers.
  const { provider, created } = await applicationsService.applyForProvider('user-2', {
    name: 'Hassan', phone: '0911000002',
    metadata: { experience: '5 years delivery', vehicleModel: 'New Bike' },
  });

  assert.equal(created, false);
  assert.equal(provider.status, 'pending');

  // The stored decision is cleared — the new application stands alone.
  assert.equal(provider.metadata.application.rejectionReason, undefined);
  assert.equal(provider.metadata.application.decidedAt, undefined);

  // The previous application's ANSWERS are replaced, not merged.
  assert.equal(provider.metadata.application.experience, '5 years delivery');
  assert.equal(provider.metadata.application.vehicleModel, 'New Bike');

  // ...and the previous REQUESTED LOCATION is cleared, so the reviewer cannot
  // approve a stale City/Zone/Port that this application never asked for.
  assert.deepEqual(provider.zoneIds ?? [], []);
  assert.equal(provider.portId ?? null, null);
  assert.equal(provider.cityId ?? null, null);
});

test('a re-application MAY still state its own requested location', async () => {
  reset();
  await applicationsService.applyForProvider('user-3', {
    name: 'Omar', phone: '0911000003', zoneIds: ['zone-a'], portId: 'port-a',
  });
  const first = await providersRepo.findByIdentityUserId('user-3');
  await providersService.rejectProvider(first._id, 'Wrong documents', admin);

  const { provider } = await applicationsService.applyForProvider('user-3', {
    name: 'Omar', phone: '0911000003', zoneIds: ['zone-b'], portId: 'port-b', cityId: 'city-b',
  });

  assert.equal(provider.status, 'pending');
  assert.deepEqual(provider.zoneIds, ['zone-b']);
  assert.equal(provider.portId, 'port-b');
  assert.equal(provider.cityId, 'city-b');
  // The old zone is gone — this is a replacement, not an accumulation.
  assert.ok(!(provider.zoneIds || []).includes('zone-a'));
});

test('approving clears the rejection decision but keeps the application answers for review', async () => {
  reset();
  await applicationsService.applyForProvider('user-4', {
    name: 'Sara', phone: '0911000004', metadata: { experience: '3 years', vehicleModel: 'Honda' },
  });
  const record = await providersRepo.findByIdentityUserId('user-4');
  await providersService.rejectProvider(record._id, 'Blurry ID', admin);
  await applicationsService.applyForProvider('user-4', { name: 'Sara', phone: '0911000004' });
  await providersService.approveProvider(record._id, admin);

  const approved = await providersRepo.findById(record._id);
  assert.equal(approved.status, 'offline');
  assert.equal(approved.metadata.application.rejectionReason, undefined);
  assert.equal(approved.metadata.application.decidedAt, undefined);
  // The answers stay available for the provider detail view (spec §15).
  assert.equal(approved.metadata.application.experience, '3 years');
});

test('admin-created provider starts PENDING — status and availability cannot be seeded', async () => {
  reset();
  const provider = await providersService.createProvider({
    name: 'Jinela Couriers',
    phone: '0911000003',
    // A hostile/legacy body trying to skip approval or set availability:
    status: 'available',
    availability: { isOnline: true },
    activeDeliveries: 99,
  }, admin);

  assert.equal(provider.status, 'pending');
  assert.equal(provider.availability.isOnline, false);
  assert.equal(provider.activeDeliveries, 0);
});

// ---- Admin lifecycle actions ----------------------------------------------

test('approve moves pending -> offline (account active, availability stays with the provider)', async () => {
  reset();
  const created = await providersService.createProvider({ name: 'Ali', phone: '0911' }, admin);
  const approved = await providersService.approveProvider(created._id, admin);

  assert.equal(approved.status, 'offline');
  // The admin never sets Online: approval must not flip availability.
  assert.equal(approved.availability.isOnline, false);
});

test('reject stores the reason on the application and blocks assignment', async () => {
  reset();
  const created = await providersService.createProvider({ name: 'Bad Docs', phone: '0912' }, admin);
  const rejected = await providersService.rejectProvider(created._id, 'ID document unreadable', admin);

  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.metadata.application.rejectionReason, 'ID document unreadable');
  const verdict = eligibility.isProviderEligible(rejected, {});
  assert.equal(verdict.eligible, false);
  assert.match(verdict.reason, /rejected/i);
});

test('deactivate requires an allowed transition and records the reason', async () => {
  reset();
  const created = await providersService.createProvider({ name: 'Sara', phone: '0913' }, admin);
  await providersService.approveProvider(created._id, admin); // -> offline

  const deactivated = await providersService.setProviderStatus(
    created._id, 'suspended', admin, 'Repeated failed deliveries',
  );
  assert.equal(deactivated.status, 'suspended');
  assert.equal(deactivated.metadata.deactivationReason, 'Repeated failed deliveries');
  assert.equal(deactivated.metadata.deactivatedBy, admin.id);

  const verdict = eligibility.isProviderEligible(deactivated, {});
  assert.equal(verdict.eligible, false);
  assert.match(verdict.reason, /deactivated/i);

  const audited = store.audits.filter((a) => a.action === 'PROVIDER_SUSPENDED');
  assert.equal(audited.length, 1);
  assert.equal(audited[0].reason, 'Repeated failed deliveries');
});

test('activate takes a deactivated provider back to ACTIVE (offline — they come online themselves)', async () => {
  reset();
  const created = await providersService.createProvider({ name: 'Omar', phone: '0914' }, admin);
  await providersService.approveProvider(created._id, admin);
  await providersService.setProviderStatus(created._id, 'suspended', admin, 'Break');

  const activated = await providersService.setProviderStatus(created._id, 'offline', admin);
  assert.equal(activated.status, 'offline');
  assert.equal(activated.availability.isOnline, false);
});

test('invalid account-status transitions are refused with 409', async () => {
  reset();
  const created = await providersService.createProvider({ name: 'Noor', phone: '0915' }, admin);
  await providersService.approveProvider(created._id, admin);
  await providersService.setProviderStatus(created._id, 'suspended', admin, 'x');

  // suspended -> available is not an account transition the admin may make.
  await assert.rejects(
    () => providersService.setProviderStatus(created._id, 'available', admin),
    /Invalid status transition/,
  );
});

// ---- Location assignment (City / Zone / Port) ------------------------------

test('provider location (city/zone/port) is editable through the roster endpoint; status is not', async () => {
  reset();
  const created = await providersService.createProvider({ name: 'Locum', phone: '0916' }, admin);

  const updated = await providersService.updateProvider(created._id, {
    cityId: 'city-harar',
    zoneIds: ['zone-central'],
    portId: 'port-main',
  }, admin);
  assert.equal(updated.cityId, 'city-harar');
  assert.deepEqual(updated.zoneIds, ['zone-central']);
  assert.equal(updated.portId, 'port-main');

  // Account status has its own audited endpoint — never a generic update.
  await assert.rejects(
    () => providersService.updateProvider(created._id, { status: 'available' }, admin),
    /Unsupported provider field/,
  );
});

// ---- Eligibility: account status x availability x coverage -----------------

const activeAndAvailable = (extra = {}) => ({
  _id: 'prov-1', name: 'Ahmed', status: 'available',
  availability: { isOnline: true },
  zoneId: 'zone-central', zoneIds: ['zone-central'], portId: 'port-main',
  activeDeliveries: 0, maxActiveAssignments: 3,
  ...extra,
});

test('eligible = ACTIVE + AVAILABLE + online + under capacity + same Zone/Port', () => {
  const verdict = eligibility.isProviderEligible(activeAndAvailable(), {
    zoneId: 'zone-central', portId: 'port-main',
  });
  assert.equal(verdict.eligible, true);
});

test('provider outside the delivery Zone is not eligible for a normal assignment', () => {
  const verdict = eligibility.isProviderEligible(
    activeAndAvailable({ zoneId: 'zone-jugol', zoneIds: ['zone-jugol'] }),
    { zoneId: 'zone-central', portId: 'port-main' },
  );
  assert.equal(verdict.eligible, false);
  assert.match(verdict.reason, /zone/i);
});

test('provider outside the delivery Port is not eligible for a normal assignment', () => {
  const verdict = eligibility.isProviderEligible(
    activeAndAvailable({ portId: 'port-jugol' }),
    { zoneId: 'zone-central', portId: 'port-main' },
  );
  assert.equal(verdict.eligible, false);
  assert.match(verdict.reason, /port/i);
});

test('a provider with no port restriction stays eligible inside the right zone', () => {
  const verdict = eligibility.isProviderEligible(
    activeAndAvailable({ portId: null }),
    { zoneId: 'zone-central', portId: 'port-main' },
  );
  assert.equal(verdict.eligible, true);
});

test('BUSY, OFFLINE, DEACTIVATED, PENDING and REJECTED providers are never eligible', () => {
  const cases = [
    ['busy', /not assignable/],
    ['offline', /offline/i],
    ['suspended', /deactivated/i],
    ['pending', /not approved/i],
    ['rejected', /rejected/i],
  ];
  for (const [status, reason] of cases) {
    const verdict = eligibility.isProviderEligible(activeAndAvailable({ status }), {
      zoneId: 'zone-central', portId: 'port-main',
    });
    assert.equal(verdict.eligible, false, `status ${status} must be ineligible`);
    assert.match(verdict.reason, reason);
  }
});

test('an online-but-unavailable (isOnline=false) provider is not eligible', () => {
  const verdict = eligibility.isProviderEligible(
    activeAndAvailable({ availability: { isOnline: false } }),
    { zoneId: 'zone-central' },
  );
  assert.equal(verdict.eligible, false);
  assert.match(verdict.reason, /offline/i);
});

test('a provider at capacity is not eligible for a new assignment', () => {
  const verdict = eligibility.isProviderEligible(
    activeAndAvailable({ activeDeliveries: 3, maxActiveAssignments: 3 }),
    { zoneId: 'zone-central' },
  );
  assert.equal(verdict.eligible, false);
  assert.match(verdict.reason, /maximum assignment limit/i);
});

test('force (ignoreCoverage) relaxes Zone/Port ONLY — never account or availability', () => {
  const outOfArea = activeAndAvailable({ zoneId: 'zone-jugol', zoneIds: ['zone-jugol'], portId: 'port-jugol' });
  assert.equal(
    eligibility.isProviderEligible(outOfArea, { zoneId: 'zone-central', portId: 'port-main', ignoreCoverage: true }).eligible,
    true,
    'coverage exception applies to an available provider',
  );
  for (const status of ['suspended', 'busy', 'pending', 'rejected', 'offline']) {
    const verdict = eligibility.isProviderEligible(
      { ...outOfArea, status },
      { zoneId: 'zone-central', portId: 'port-main', ignoreCoverage: true },
    );
    assert.equal(verdict.eligible, false, `force must NOT rescue status ${status}`);
  }
});

test('findEligibleProviders: normal list is Zone/Port-scoped, force list is not', () => {
  const candidates = [
    activeAndAvailable({ _id: 'in-area', zoneId: 'zone-central', zoneIds: ['zone-central'], portId: 'port-main' }),
    activeAndAvailable({ _id: 'other-port', zoneId: 'zone-central', zoneIds: ['zone-central'], portId: 'port-jugol' }),
    activeAndAvailable({ _id: 'other-zone', zoneId: 'zone-jugol', zoneIds: ['zone-jugol'], portId: 'port-jugol' }),
    activeAndAvailable({ _id: 'no-port', zoneId: 'zone-central', zoneIds: ['zone-central'], portId: null }),
  ];
  const constraints = { zoneId: 'zone-central', portId: 'port-main', serviceId: null };

  const normal = eligibility.findEligibleProviders(constraints, candidates).map((p) => p._id);
  assert.deepEqual(new Set(normal), new Set(['in-area', 'no-port']));
  // In-area provider is ordered first (port match preferred).
  assert.equal(normal[0], 'in-area');

  const force = eligibility.findEligibleProviders({ ...constraints, ignoreCoverage: true }, candidates).map((p) => p._id);
  assert.deepEqual(new Set(force), new Set(['in-area', 'other-port', 'other-zone', 'no-port']));
});



