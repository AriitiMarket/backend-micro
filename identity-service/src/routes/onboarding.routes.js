// Internal onboarding-lifecycle routes — called only by other backend services
// (Commerce on seller submission, Delivery on provider submission) and by ops.
// Guarded by the dedicated internal service token; never reachable by browsers.
const express = require('express');
const router = express.Router();
const onboardingController = require('../controllers/onboarding.controller');
const internalOnly = require('../middleware/internalOnly');

router.post('/internal/onboarding/:role/complete', internalOnly, onboardingController.completeOnboarding);
router.post('/internal/onboarding/cleanup', internalOnly, onboardingController.runCleanup);

module.exports = router;
