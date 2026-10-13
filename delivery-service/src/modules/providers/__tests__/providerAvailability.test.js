/**
 * Provider availability ↔ load tests — the "BUSY is freed automatically when a
 * delivery succeeds" rule (MVP §19).
 *
 * BUSY means exactly one thing: an ACTIVE provider at their capacity limit.
 * Everything else (under capacity, the provider's own offline switch, an account
 * that is not ACTIVE) must survive a capacity change untouched, and a provider
 * must NEVER be left stuck busy after work completes — otherwise they are
 * ineligible for every new assignment forever.
 *
 * The provider repository is an in-memory fake (require cache) implementing the
 * same atomic guards as the Mongo query, so the real capacity service runs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../../..');

const store = { providers: new Map() };
let seq = 0;
const nextId = () => `p${++seq}`;

function stub(relPath, exports) {
  const resolved = require.resolve(path.join(ROOT, relPath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

function seedProvider(extra = {}) {
  const id = nextId();
  store.providers.set(id, {
    _id: id,
    status: 'available',
    availability: { isOnline: true, lastSeenAt: null },
    activeDeliveries: 0,
    maxActiveAssignments: 3,
    currentWorkloadIds: [],
    completedDeliveries: 0,
    ...extra,
  });
  return id;
}

/** Mirrors the Mongo guards: capacity check on increment, membership on both. */
const providersRepo = {
  async findById(id) { return store.providers.get(String(id)) || null; },
  async updateFields(id, fields) {
    const p = store.providers.get(String(id));
    if (!p) return null;
    // Dotted keys (e.g. `availability.isOnline`) are nested writes in Mongo.
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
  async incrementWorkload(id, workloadId) {
    const p = store.providers.get(String(id));
    if (!p) return null;
    if (p.currentWorkloadIds.includes(String(workloadId))) return null; // guard: already held
    if (p.activeDeliveries >= p.maxActiveAssignments) return null;    // guard: at capacity
    p.currentWorkloadIds.push(String(workloadId));
    p.activeDeliveries += 1;
    return p;
  },
  async decrementWorkload(id, workloadId) {
    const p = store.providers.get(String(id));
    if (!p) return null;
    if (!p.currentWorkloadIds.includes(String(workloadId))) return null; // guard: not held
    p.currentWorkloadIds = p.currentWorkloadIds.filter((w) => w !== String(workloadId));
    p.activeDeliveries = Math.max(0, p.activeDeliveries - 1);
    return p;
  },
  async incrementCompletedDeliveries(id) {
    const p = store.providers.get(String(id));
    if (p) p.completedDeliveries += 1;
    return p;
  },
};

stub('src/modules/providers/repositories/providers.repository.js', providersRepo);
stub('src/shared/utils/audit-client.js', {
  ACTIONS: {}, LEVELS: {},
  async sendAudit() { return null; },
  getAdminFromReq() { return { adminId: null, adminName: 'Admin', ipAddress: null }; },
  getActorFromReq() { return { actor: {} }; },
});

const capacity = require(path.join(ROOT, 'src/modules/providers/services/provider-capacity.service.js'));
const availability = require(path.join(ROOT, 'src/modules/providers/services/provider-availability.service.js'));
const eligibility = require(path.join(ROOT, 'src/modules/providers/services/provider-eligibility.service.js'));

const provider = (id) => store.providers.get(String(id));

// ---- The rule: BUSY = ACTIVE + at capacity, freed automatically ------------

test('a provider becomes BUSY at their capacity limit and is eligible again when freed', async () => {
  const id = seedProvider({ maxActiveAssignments: 2 });

  await capacity.incrementWorkload(id, 'a1');
  assert.equal(provider(id).status, 'available', 'under capacity -> available');
  await capacity.incrementWorkload(id, 'a2');
  assert.equal(provider(id).status, 'busy', 'at capacity -> busy');
  assert.equal(
    eligibility.isProviderEligible(provider(id), {}).eligible,
    false,
    'a busy provider is not eligible for new work',
  );

  await capacity.completeDelivery(id, 'a1');
  assert.equal(provider(id).activeDeliveries, 1);
  assert.equal(provider(id).completedDeliveries, 1);
  assert.equal(provider(id).status, 'available', 'freed automatically after success');
  assert.equal(
    eligibility.isProviderEligible(provider(id), {}).eligible,
    true,
    'and eligible again without any admin action',
  );
});

test('the last delivery of a busy provider frees them (capacity fully released)', async () => {
  const id = seedProvider({ maxActiveAssignments: 1 });
  await capacity.incrementWorkload(id, 'a1');
  assert.equal(provider(id).status, 'busy');

  await capacity.completeDelivery(id, 'a1');
  assert.equal(provider(id).status, 'available');
  assert.equal(provider(id).currentWorkloadIds.length, 0);
  assert.equal(provider(id).activeDeliveries, 0);
});

test('a repeated release heals a provider stuck in busy (idempotent path)', async () => {
  const id = seedProvider({ maxActiveAssignments: 1, status: 'busy', activeDeliveries: 0 });
  // The workload was already released earlier (double-closed delivery), so the
  // decrement is a no-op — but the provider must still be freed.
  const result = await capacity.decrementWorkload(id, 'already-released');
  assert.equal(result.status, 'available');
  assert.equal(provider(id).activeDeliveries, 0, 'counters untouched by the no-op path');
});

test('oversubscribing is refused and never turns into a busy provider', async () => {
  const id = seedProvider({ maxActiveAssignments: 1 });
  await capacity.incrementWorkload(id, 'a1');
  await assert.rejects(() => capacity.incrementWorkload(id, 'a2'), /capacity exceeded/i);
  assert.equal(provider(id).activeDeliveries, 1);
  assert.equal(provider(id).currentWorkloadIds.length, 1);
});

test('incrementing the same workload twice is idempotent and still derives availability', async () => {
  const id = seedProvider({ maxActiveAssignments: 1 });
  await capacity.incrementWorkload(id, 'a1');
  const second = await capacity.incrementWorkload(id, 'a1');
  assert.equal(provider(id).activeDeliveries, 1, 'not double counted');
  assert.equal(second.status, 'busy');
});

test('the provider own offline switch wins: work completing never flips them online', async () => {
  const id = seedProvider({ maxActiveAssignments: 1, status: 'offline', availability: { isOnline: false } });
  await capacity.incrementWorkload(id, 'a1');
  assert.equal(provider(id).status, 'offline', 'staying offline is the provider call');

  await capacity.completeDelivery(id, 'a1');
  assert.equal(provider(id).status, 'offline', 'and a success does not override it');
  assert.equal(provider(id).activeDeliveries, 0, 'the capacity itself was still released');

  // When they come back online the availability is re-derived from the load.
  await availability.setOnlineStatus(id, true);
  assert.equal(provider(id).status, 'available');
});

test('coming online with spare capacity is AVAILABLE, not busy', async () => {
  const id = seedProvider({ maxActiveAssignments: 3, status: 'offline', availability: { isOnline: false } });
  await capacity.incrementWorkload(id, 'a1');

  await availability.setOnlineStatus(id, true);
  assert.equal(provider(id).status, 'available', '1 of 3 is under capacity');
  assert.equal(eligibility.isProviderEligible(provider(id), {}).eligible, true);
});

test('coming online AT capacity is busy', async () => {
  const id = seedProvider({ maxActiveAssignments: 1, status: 'offline', availability: { isOnline: false } });
  await capacity.incrementWorkload(id, 'a1');
  await availability.setOnlineStatus(id, true);
  assert.equal(provider(id).status, 'busy');
});

// ---- Account status is never overwritten by a load change -----------------

test('a deactivated / pending / rejected provider is never flipped to available or busy', async () => {
  for (const status of ['suspended', 'pending', 'rejected']) {
    const id = seedProvider({ maxActiveAssignments: 1, status });
    await capacity.reconcileAvailability(id);
    assert.equal(provider(id).status, status, `${status} must keep its account status`);

    // Nor by a capacity release.
    await capacity.decrementWorkload(id, 'nothing-held');
    assert.equal(provider(id).status, status);
  }
});

test('a non-active provider cannot go online', async () => {
  for (const status of ['pending', 'rejected', 'suspended']) {
    const id = seedProvider({ status });
    await assert.rejects(() => availability.setOnlineStatus(id, true), /cannot go online/);
  }
});

test('a document without maxActiveAssignments falls back to the schema default (3)', async () => {
  const id = seedProvider({ maxActiveAssignments: undefined });
  delete provider(id).maxActiveAssignments;
  await capacity.incrementWorkload(id, 'a1');
  await capacity.incrementWorkload(id, 'a2');
  await capacity.incrementWorkload(id, 'a3');
  assert.equal(provider(id).status, 'busy', '3 of 3 -> busy');
  await capacity.completeDelivery(id, 'a3');
  assert.equal(provider(id).status, 'available');
});