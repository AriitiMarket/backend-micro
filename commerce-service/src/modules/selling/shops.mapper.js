/**
 * Shop mappers — the ONE definition of what a shop looks like outside the
 * service layer.
 *
 * Two projections live here because the module has exactly two audiences:
 *   * the public/buyer view  → `toPublicShop` (allowlisted business fields only,
 *     never identity or money fields);
 *   * the admin console view → `toAdminRow` (shared by both admin read paths so
 *     the list and the pending queue can never drift apart again).
 */

/** Statuses a guest may see. Admin-curated `showOnPublic` is checked on top. */
const PUBLIC_VISIBLE_STATUSES = ['APPROVED', 'ACTIVE'];

/** Mongo filter for "visible on the public marketplace". */
function publicVisibilityFilter() {
  return { status: { $in: PUBLIC_VISIBLE_STATUSES }, showOnPublic: { $ne: false } };
}

/** Predicate twin of `publicVisibilityFilter` for an already-loaded document. */
function isPubliclyVisible(shop) {
  if (!shop) return false;
  return PUBLIC_VISIBLE_STATUSES.includes(shop.status) && shop.showOnPublic !== false;
}

/** Location names only — ids stay internal, coordinates are not public. */
function publicLocationSnapshot(snapshot) {
  if (!snapshot) return undefined;
  return {
    regionName: snapshot.regionName || '',
    areaName: snapshot.areaName || '',
    cityName: snapshot.cityName || '',
    sectorName: snapshot.sectorName || '',
    fullAddress: snapshot.fullAddress || '',
  };
}

const PUBLIC_SHOP_FIELDS = [
  '_id', 'name', 'description', 'address', 'avatar', 'category',
  'locationSnapshot', 'ratings', 'ratingCount', 'productCount', 'createdAt',
];

/**
 * Allowlisted shop for a non-owner. Strips ownerId / email / phone / balance /
 * transactions / status / curation flags — everything a buyer must not see.
 */
function toPublicShop(shop) {
  if (!shop) return null;
  const plain = typeof shop.toObject === 'function' ? shop.toObject() : { ...shop };
  const out = {};
  for (const key of PUBLIC_SHOP_FIELDS) {
    if (plain[key] !== undefined) out[key] = plain[key];
  }
  const snapshot = publicLocationSnapshot(plain.locationSnapshot);
  if (snapshot) out.locationSnapshot = snapshot;
  else delete out.locationSnapshot;
  return out;
}

/**
 * One row of every admin shop list (list, pending queue, filters).
 * Field names match the Shop model and the admin console types:
 * `phoneNumber` (not `phone`), `ratings` (not `rating`), `orderCount`
 * (not `totalOrders`), coordinates as `{latitude, longitude}`.
 */
function toAdminRow(shop) {
  const avatar = shop.avatar || {};
  return {
    id: shop._id,
    name: shop.name,
    email: shop.email,
    description: shop.description || '',
    phoneNumber: shop.phoneNumber != null ? String(shop.phoneNumber) : '',
    zipCode: shop.zipCode != null ? String(shop.zipCode) : '',
    image: avatar.url || '',
    ownerId: shop.ownerId,
    status: shop.status,
    address: shop.address,
    category: shop.category || '',
    locationId: shop.locationId || null,
    sectorId: shop.sectorId || null,
    applicationId: shop.applicationId || null,
    showOnPublic: shop.showOnPublic !== false,
    locationSnapshot: shop.locationSnapshot || null,
    // Computed stats are attached by the service layer when available
    // (detail always has them; list may leave them undefined).
    ratings: shop.ratings,
    ratingCount: shop.ratingCount,
    productCount: shop.productCount,
    orderCount: shop.orderCount,
    createdAt: shop.createdAt,
    approvedAt: shop.approvalMetadata ? shop.approvalMetadata.approvedAt : null,
    rejectionReason: shop.approvalMetadata ? shop.approvalMetadata.rejectionReason || null : null,
    suspensionReason: shop.approvalMetadata ? shop.approvalMetadata.suspensionReason || null : null,
  };
}

/** `[{ _id: <status>, count }]` (from `countByField`) → `{ STATUS: count }`. */
function countMapFromRows(rows = []) {
  const out = {};
  for (const row of rows) {
    if (row && row._id !== null && row._id !== undefined) out[String(row._id)] = row.count;
  }
  return out;
}

module.exports = {
  PUBLIC_VISIBLE_STATUSES,
  publicVisibilityFilter,
  isPubliclyVisible,
  toPublicShop,
  toAdminRow,
  countMapFromRows,
};
