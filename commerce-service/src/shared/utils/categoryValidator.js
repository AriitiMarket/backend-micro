const categoryRepository = require('../../modules/catalog/repositories/categories.repository');

/**
 * Validate that a category title matches an active Category of the given type.
 *
 * Skips validation when:
 *  - category is empty/null/undefined (optional field)
 *  - The Category collection has no categories of this type (seed not run yet)
 *
 * @param {string} categoryTitle - The category title string to validate
 * @param {string} type - The expected category type: 'product' | 'business' | 'shop' | 'event'
 * @returns {Promise<Object|null>} the matched Category document, or null when
 *   the check is skipped (empty value / collection not seeded) — callers use it
 *   to populate the optional `categoryId` FK.
 * @throws {Error} 400 if category does not match any active Category of the given type
 */
async function validateCategory(categoryTitle, type) {
  if (!categoryTitle || !String(categoryTitle).trim()) return null;

  const count = await categoryRepository.countActiveByType(type);
  if (count === 0) return null;

  const category = await categoryRepository.findByTitleAndType(
    String(categoryTitle).trim(),
    type
  );
  if (!category) {
    const err = new Error(`Invalid category "${categoryTitle}" for type "${type}". Please select from available categories.`);
    err.statusCode = 400;
    throw err;
  }
  if (category.status !== 'active') {
    const err = new Error(`Category "${categoryTitle}" is currently inactive.`);
    err.statusCode = 400;
    throw err;
  }
  return category;
}

module.exports = { validateCategory };
