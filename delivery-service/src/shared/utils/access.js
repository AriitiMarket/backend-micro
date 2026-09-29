const { forbidden, notFound } = require('../errors');

/**
 * Resource access rules for Delivery & Logistics (MVP §27).
 *
 * The gateway forwards the identity user id, the PRIMARY role and the account's
 * CAPABILITY SET (one account can hold several actor roles at once — see
 * Identity's user_roles). Every read of a delivery-scoped resource must pass
 * through here — the frontend must never be the thing standing between one
 * tenant's data and another.
 *
 *   ADMIN            — full operational access
 *   SELLER           — only deliveries/requests they handed over (sellerId)
 *   BUYER            — only their own deliveries/requests (buyerId); CUSTOMER
 *                      is the legacy spelling of the same actor
 *   PROVIDER         — only deliveries assigned to their Provider document.
 *                      PROVIDER is the role Identity actually issues for an
 *                      approved delivery provider; RIDER is not a role at all
 *                      (it only ever appears as `actorType` on assignment
 *                      documents), and PARTNER was the pre-rename spelling of
 *                      PROVIDER.
 *
 * Access is ADDITIVE: an account that is both a seller and a provider is allowed
 * by whichever rule matches, rather than being rejected because the first rule
 * checked did not.
 */

/** Actor roles the caller holds: the primary role plus every capability. */
function actorRoles(user) {
  if (!user) return [];
  const capabilities = Array.isArray(user.capabilities) ? user.capabilities : [];
  return [user.role, ...capabilities].filter(Boolean).map((r) => String(r).toUpperCase());
}

function hasActor(user, ...roles) {
  const held = actorRoles(user);
  return roles.some((role) => held.includes(String(role).toUpperCase()));
}

function isAdmin(user) {
  return hasActor(user, 'ADMIN');
}

function isSeller(user) {
  return hasActor(user, 'SELLER');
}

/** Buyer: every account is one (CUSTOMER and BUYER are the same actor). */
function isBuyer(user) {
  return hasActor(user, 'CUSTOMER', 'BUYER');
}

/**
 * Delivery-side actor. PROVIDER is the only role that grants it: the old
 * PARTNER spelling was normalized to PROVIDER by Identity, and RIDER is an
 * actorType (driver label) rather than a role.
 */
function isOperator(user) {
  return hasActor(user, 'PROVIDER');
}

function isOwnerless(user) {
  return isSeller(user) || isBuyer(user);
}

/** Provider document owned by a provider identity user, or null. */
async function resolveProviderForUser(user) {
  if (!isOperator(user)) return null;
  const providersRepo = require('../../modules/providers/repositories/providers.repository');
  return providersRepo.findByIdentityUserId(user.id).catch(() => null);
}

function sameId(a, b) {
  return a != null && b != null && String(a) === String(b);
}

/** Throws 404 when missing, 403 when the user may not see this delivery. */
async function assertCanReadDelivery(delivery, user) {
  if (!delivery) throw notFound('Delivery not found');
  if (!user) throw forbidden('Unauthorized');
  if (isAdmin(user)) return delivery;

  const denies = [];

  if (isSeller(user)) {
    if (sameId(delivery.sellerId, user.id)) return delivery;
    denies.push('You can only access deliveries for your own orders');
  }
  if (isBuyer(user)) {
    if (sameId(delivery.buyerId, user.id)) return delivery;
    denies.push('You can only access your own deliveries');
  }
  if (isOperator(user)) {
    const provider = await resolveProviderForUser(user);
    if (provider && sameId(delivery.providerId, provider._id)) return delivery;
    denies.push('You can only access your assigned deliveries');
  }

  if (denies.length > 0) throw forbidden(denies[0]);
  throw forbidden();
}

/** Same rule for DeliveryRequest (pre-delivery handoff). */
async function assertCanReadRequest(request, user) {
  if (!request) throw notFound('Delivery request not found');
  if (!user) throw forbidden('Unauthorized');
  if (isAdmin(user)) return request;

  if (isSeller(user) && sameId(request.sellerId, user.id)) return request;
  if (isBuyer(user) && sameId(request.buyerId, user.id)) return request;

  if (isSeller(user)) throw forbidden('You can only access requests for your own orders');
  if (isBuyer(user)) throw forbidden('You can only access your own delivery requests');
  throw forbidden('Delivery requests are visible to admins, sellers and buyers only');
}

module.exports = {
  actorRoles,
  hasActor,
  isAdmin,
  isSeller,
  isBuyer,
  isOwnerless,
  isOperator,
  resolveProviderForUser,
  sameId,
  assertCanReadDelivery,
  assertCanReadRequest,
};

