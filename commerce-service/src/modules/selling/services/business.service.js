const sellerAppRepository = require('../repositories/sellerApplications.repository');
const shopRepository = require('../repositories/shops.repository');

/**
 * Business registry — the missing User -> Seller Actor -> Business -> Shop link.
 *
 * The Business is the SellerApplication document (it is the only record that
 * carries `businessInformation`, and the admin console already lists it under
 * `/businesses`). Sellers who opened a Shop directly from the seller console
 * never filed one, which left those Shops belonging to no business at all.
 *
 * `ensureBusiness` closes that gap: it returns the owner's existing business,
 * or synthesises a minimal one flagged `provisionedFromShop` so it is never
 * mistaken for a reviewed registration.
 */

const ACTIVE_SHOP_STATUSES = ['APPROVED', 'ACTIVE'];

function timelineEntry(status, changedBy, reason) {
  return { status, changedBy, changedAt: new Date(), ...(reason ? { reason } : {}) };
}

/** True when a shop status means the storefront is live. */
function isLiveStatus(status) {
  return ACTIVE_SHOP_STATUSES.includes(String(status || '').toUpperCase());
}

/**
 * The owner's business, creating one when it does not exist yet.
 *
 * @param {string} ownerId  Identity user id (the seller actor).
 * @param {object} [seed]   Values copied from an existing Shop so the
 *                          synthesised business is not an empty shell.
 * @param {string} [seed.businessName]
 * @param {string} [seed.businessCategory]
 * @param {string} [seed.email]
 * @param {string} [seed.shopName]
 * @param {boolean} [seed.live]  Shop is APPROVED/ACTIVE -> business is too.
 * @returns {Promise<{business: object, created: boolean}>}
 */
async function ensureBusiness(ownerId, seed = {}) {
  if (!ownerId) throw new Error('ensureBusiness: ownerId is required');

  const existing = await sellerAppRepository.findByOwner(ownerId).catch(() => null);
  if (existing) return { business: existing, created: false };

  const businessName = String(seed.businessName || seed.shopName || '').trim();
  const status = seed.live === false ? 'DRAFT' : 'APPROVED';

  const business = await sellerAppRepository.create({
    ownerId,
    userId: ownerId,
    sellerType: 'INDIVIDUAL',
    businessInformation: {
      businessName,
      businessCategory: String(seed.businessCategory || '').trim(),
      description: '',
      phone: '',
      email: String(seed.email || '').trim(),
    },
    shopInformation: seed.shopName
      ? {
          shopName: String(seed.shopName).trim(),
          publicEmail: String(seed.email || '').trim(),
        }
      : undefined,
    status,
    ...(status === 'APPROVED' ? { approvedAt: new Date() } : {}),
    provisionedFromShop: true,
    statusTimeline: [timelineEntry(status, ownerId, 'Provisioned from an existing shop')],
  });

  return { business, created: true };
}

/**
 * The id of the business that owns `shop`, creating the record if needed and
 * writing the link back onto the shop (idempotent — a shop that is already
 * linked is returned untouched). Returns null only when the shop has no owner.
 */
async function resolveShopBusinessId(shop) {
  if (!shop) return null;
  if (shop.businessId) return String(shop.businessId);

  const ownerId = shop.ownerId;
  if (!ownerId) return null;

  const { business } = await ensureBusiness(ownerId, {
    businessName: shop.name,
    businessCategory: shop.category,
    email: shop.email,
    shopName: shop.name,
    live: isLiveStatus(shop.status),
  });
  const businessId = String(business._id);

  // Persist so the next reader (order creation, admin scope, migration) does
  // not have to repeat this. Best-effort: a failed link must not fail the call.
  try {
    await shopRepository.updateOneById(shop._id, {
      businessId,
      ...(shop.applicationId ? {} : { applicationId: businessId }),
    });
    shop.businessId = businessId;
    if (!shop.applicationId) shop.applicationId = businessId;
  } catch (e) {
    console.error('[resolveShopBusinessId] link warning:', e.message);
  }

  return businessId;
}

/**
 * Resolve the business id for an order shipment: the shop's business first,
 * falling back to the owner's business. Never the owner's *user* id — that was
 * the old value and it collided with the admin scope, which treats businessId
 * as a SellerApplication id.
 */
async function resolveShipmentBusinessId(shop) {
  if (!shop) return null;
  if (shop.businessId) return String(shop.businessId);
  if (shop.applicationId) return String(shop.applicationId);
  if (!shop.ownerId) return null;
  return resolveShopBusinessId(shop);
}

module.exports = {
  ensureBusiness,
  isLiveStatus,
  resolveShipmentBusinessId,
  resolveShopBusinessId,
};
