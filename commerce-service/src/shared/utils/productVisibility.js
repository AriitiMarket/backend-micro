const { inactiveProductCategoryTitles } = require('./categoryVisibility');

/**
 * Units a buyer can order right now: stock minus open-order reservations,
 * clamped at 0. Missing fields (legacy docs) count as 0.
 */
function availableUnits(product) {
  if (!product) return 0;
  const stock = Number(product.stock) || 0;
  const reserved = Number(product.reserved) || 0;
  return Math.max(0, stock - reserved);
}

/**
 * The public product gates, evaluated against an already-loaded document.
 *
 * One definition for every consumer that decides "may an anonymous buyer see or
 * order this product right now?". Three copies of this rule existed (the public
 * repository, the list/search service, and two inline checks in the order
 * service) and they drifted: the storefront hid a product while
 * `create-order` would still accept a stale id. The gates are:
 *
 *   1. `isActive !== false`  — the admin activate/deactivate kill-switch
 *   2. `status` PUBLISHED (or absent — legacy documents behave as published)
 *   3. the shop's `showOnPublic` allow (admin storefront toggle)
 *   4. the shop's operational status is APPROVED/ACTIVE (or absent), so a
 *      rejected/suspended/pending seller stops selling immediately
 *   5. the product's category is not deactivated in the catalog
 *   6. at least one unit is available (stock − reserved > 0) — finished or
 *      fully-reserved stock is a seller/admin concern only, never storefront
 *
 * The category gate is the only async part (it reads the tiny categories
 * collection; an empty exclusion list degrades to the previous behaviour).
 *
 * @param {object} product a product document (or lean object)
 * @returns {Promise<boolean>} true when the product belongs in the storefront
 */
async function isProductPubliclyVisible(product) {
  if (!product) return false;
  if (product.isActive === false) return false;
  if (product.status && product.status !== 'PUBLISHED') return false;

  const shop = product.shop && typeof product.shop === 'object' ? product.shop : {};
  if (shop.showOnPublic === false) return false;
  if (shop.status && !['APPROVED', 'ACTIVE'].includes(shop.status)) return false;

  if (availableUnits(product) < 1) return false;

  if (product.category) {
    const inactiveCategories = await inactiveProductCategoryTitles();
    if (inactiveCategories.includes(product.category)) return false;
  }
  return true;
}

module.exports = { isProductPubliclyVisible, availableUnits };
