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

module.exports = { grantProviderRole, postInternal, identityClientInternals: client };
