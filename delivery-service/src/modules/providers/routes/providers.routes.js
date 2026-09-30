const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/providers.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const authorize = require('../../../app/middleware/authorize');

// Delivery Providers — one entity covering riders, businesses and logistics
// providers (see Provider.providerType).
// Provider roster: ADMIN only for both the full list and the dispatch-eligibility
// query — it exposes identityUserId / zones / online state of every rider, and
// no shipped client calls it anonymously authenticated (the provider console
// uses /batch/available for open work instead). It must never answer anonymous
// or buyer-level requests.
router.get('/available', authenticate, authorize('ADMIN'), ctrl.getAvailableProviders);
router.get('/', authenticate, authorize('ADMIN'), ctrl.getProviders);
// The caller's OWN provider record. Declared before `/:id` so `/me` is never
// read as an id: the rider portal needs its own document (id, zones, status,
// capacity) to render the profile and the availability toggle, and it cannot know
// the provider _id without first fetching it.
router.get('/me', authenticate, authorize(['ADMIN', 'PROVIDER']), ctrl.getMyProvider);
router.get('/:id/detail', authenticate, authorize('ADMIN'), ctrl.getProviderDetail);
router.get('/:id', authenticate, authorize('ADMIN'), ctrl.getProvider);
router.post('/', authenticate, authorize('ADMIN'), ctrl.createProvider);
router.put('/:id', authenticate, authorize('ADMIN'), ctrl.updateProvider);
router.put('/:id/status', authenticate, authorize('ADMIN'), ctrl.setProviderStatus);
router.put('/:id/zones', authenticate, authorize('ADMIN'), ctrl.assignZones);
router.put('/:id/routes', authenticate, authorize('ADMIN'), ctrl.assignRoutes);
router.post('/:id/approve', authenticate, authorize('ADMIN'), ctrl.approveProvider);
router.post('/:id/reject', authenticate, authorize('ADMIN'), ctrl.rejectProvider);
// Availability used to be admin-only implicitly but was NOT enforced: any
// authenticated user could flip any provider's online state. It is an
// operational field, so it now requires ADMIN like every other mutation.
// PROVIDER is the role Identity actually issues for an approved delivery
// provider (the old PARTNER/RIDER spellings were never assigned to any
// account), and the controller additionally scopes a non-admin to its own
// record.
router.put('/:id/online', authenticate, authorize(['ADMIN', 'PROVIDER']), ctrl.setOnline);
router.put('/:id/location', authenticate, authorize(['ADMIN', 'PROVIDER']), ctrl.updateLocation);

module.exports = router;
