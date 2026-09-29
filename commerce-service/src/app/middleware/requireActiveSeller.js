const { identityClient } = require('../clients/identity.client');

/**
 * requireActiveSeller — blocks seller WRITE operations while Identity reports
 * the account as suspended.
 *
 * Why this exists: suspending/deactivating a business sets Identity
 * `sellerStatus = SUSPENDED` but deliberately keeps `role = SELLER` (the role
 * is the one-account model, not the operational state). `authorize('SELLER')`
 * only reads the role from the gateway-verified token, so without this gate a
 * suspended business could still create shops, edit its profile and keep
 * selling behind a storefront the admin just took down.
 *
 * Failure policy: fail CLOSED when Identity positively reports SUSPENDED, and
 * fail OPEN when Identity is unreachable or answers non-200 — an outage of the
 * identity lookup must not lock every seller out of their own dashboard.
 *
 * Reads only; the check is cached for `TTL_MS` per user so a burst of writes
 * (save image + save info + …) costs one internal call.
 */
const TTL_MS = 30_000;
const cache = new Map(); // userId -> { value: 'SUSPENDED'|'OK', at: number }

function isSuspended(value) {
  return typeof value === 'string' && value.trim().toUpperCase() === 'SUSPENDED';
}

async function sellerIsSuspended(userId) {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value === 'SUSPENDED';

  let suspended = false;
  try {
    const res = await identityClient.getSellerStatus(userId);
    if (res && res.status === 200 && res.body) {
      suspended = isSuspended(res.body.sellerStatus);
    }
  } catch (e) {
    console.error(`[requireActiveSeller] status lookup warning for ${userId}: ${e.message}`);
  }
  cache.set(userId, { value: suspended ? 'SUSPENDED' : 'OK', at: Date.now() });
  return suspended;
}

function requireActiveSeller(req, res, next) {
  const userId = req.user && (req.user.id || req.user.sub);
  if (!userId) {
    return res.status(401).json({
      success: false,
      code: 'UNAUTHENTICATED',
      message: 'Not logged in',
      errors: [],
    });
  }

  sellerIsSuspended(userId)
    .then((suspended) => {
      if (!suspended) return next();
      return res.status(403).json({
        success: false,
        code: 'SELLER_SUSPENDED',
        message:
          'This seller account is suspended. Your shops stay hidden until an administrator reactivates the account.',
        errors: [],
      });
    })
    .catch((err) => next(err));
}

module.exports = { requireActiveSeller, sellerIsSuspended };
