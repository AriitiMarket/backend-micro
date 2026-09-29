// Category gate for the PUBLIC product surface.
//
// Products reference a category by `title` (title-as-FFK — see
// categories.service.remove()). Deactivating a category is the admin's public
// curation switch, so an inactive category must hide its products the same way
// a shop hidden from the public (`shop.showOnPublic: false`) does.
//
// The helper returns the titles to EXCLUDE (`$nin`) rather than the titles to
// include: a product whose category no longer matches any Category row (legacy
// rows created before the catalog existed, or a row deleted before deletes were
// reference-protected) stays visible instead of silently disappearing.
//
// The categories collection is tiny (tens of rows) and `status` is indexed by
// the admin list screen, so one small query per public read is cheaper than a
// cross-module cache that could serve a stale gate after an admin toggle.
const Category = require('../../modules/catalog/models/Categories');

async function inactiveProductCategoryTitles() {
  try {
    const rows = await Category.find({ type: 'product', status: 'inactive' })
      .select('title')
      .lean();
    return rows.map((row) => row.title).filter(Boolean);
  } catch (err) {
    // Never fail a public read because the gate could not be resolved: an empty
    // exclusion list degrades to the previous behaviour (gate unavailable).
    console.error('[categoryVisibility] could not resolve inactive categories:', err.message);
    return [];
  }
}

module.exports = { inactiveProductCategoryTitles };
