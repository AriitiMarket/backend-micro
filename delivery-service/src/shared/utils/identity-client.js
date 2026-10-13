// Service-to-service client for the Identity Service's /internal/* API.
//
// The Delivery Service never writes account roles into the identity database
// itself: it asks Identity to do it, exactly like Commerce does for sellers.
//
// DIRECT internal call over the private network (IDENTITY_SERVICE_URL) via the
// shared internal client — no gateway hop, one timeout/retry/logging policy for
// every dependency, and the caller is correctly attributed as `delivery` rather
// than as the gateway.
//
// Like the audit client, this never throws into a request handler: a
// provisioning failure is reported to the caller, not raised.
const { createInternalClient } = require('../../shared/internal-client');
const { services } = require('../../app/config/services');

const client = createInternalClient({
  name: services.self,
  baseUrl: services.identity.url,
  timeoutMs: parseInt(process.env.IDENTITY_CALL_TIMEOUT_MS, 10) || 5000,
  maxRetries: 1, // idempotent reads only; writes are never retried
});

/**
 * POST to an internal Identity path. Never throws: the failure is returned.
 * @returns {Promise<{ok: boolean, status: number, body: object|null, error?: string}>}
 */
async function postInternal(path, body) {
  const res = await client.request('POST', path, { body: body || {} });
  return { ok: res.ok, status: res.status, body: res.body, error: res.error || undefined };
}

/**
 * Grant the PROVIDER account role. Called when an admin approves a provider
 * application; approving a provider whose account cannot be provisioned is a
 * real failure, so the outcome is returned for the caller to act on.
 * @returns {Promise<{granted: boolean, status: number, reason?: string}>}
 */
async function grantProviderRole(userId) {
  const result = await postInternal('/internal/providers/grant-role', { userId });
  if (!result.ok) {
    return {
      granted: false,
      status: result.status,
      reason: (result.body && result.body.message) || result.error || 'identity service unavailable',
    };
  }
  return {
    granted: Boolean(result.body && result.body.granted),
    status: result.status,
    reason: result.body && result.body.reason,
  };
}

/**
 * Write the PROVIDER membership status (SUSPENDED / REJECTED / PENDING /
 * ACTIVE) for an account. Used to keep Identity in step when the roster
 * suspends, rejects or sends an application back to review — without it the
 * account keeps (or keeps missing) the capability the roster says it has.
 *
 * Never throws: a failure is returned for the caller to log.
 * @returns {Promise<{ok: boolean, status: number, reason?: string}>}
 */
async function setProviderMembershipStatus(userId, status) {
  const result = await postInternal('/internal/providers/set-status', { userId, status });
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      reason: (result.body && result.body.message) || result.error || 'identity service unavailable',
    };
  }
  return { ok: true, status: result.status };
}

/**
 * Mark the provider onboarding wizard complete on application submission.
 *
 * Tells Identity the applicant finished the vehicle/application details, so the
 * abandoned-application sweep will not reclaim their PENDING membership.
 * Idempotent and never throws: the application document is the source of truth
 * for the review queue.
 * @returns {Promise<{ok: boolean, status: number, reason?: string}>}
 */
async function markOnboardingComplete(userId) {
  const result = await postInternal('/internal/onboarding/PROVIDER/complete', { userId });
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      reason: (result.body && result.body.message) || result.error || 'identity service unavailable',
    };
  }
  return { ok: true, status: result.status };
}

module.exports = {
  grantProviderRole,
  setProviderMembershipStatus,
  markOnboardingComplete,
  postInternal,
  identityClientInternals: client,
};
