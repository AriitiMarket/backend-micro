const categoryService = require('../services/categories.service');
const { ok, created } = require('../../../shared/utils/response');
const { sendAudit, getAdminFromReq } = require('../../../shared/utils/audit-client');

async function createCategory(req, res, next) {
  try {
        const { title, description, type, sortOrder, categoryImage } = req.body;
    if (!title || !type) {
      return res.status(400).json({ success: false, message: 'Title and type are required' });
    }
    const existing = await categoryService.getBySlug(
      title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
    );
    if (existing) {
      return res.status(409).json({ success: false, message: 'A category with this title already exists' });
    }
    const category = await categoryService.create({ title, description, type, sortOrder, categoryImage });
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'CATEGORY_CREATED', level: 'INFO', adminId, adminName, module: 'commerce', targetEntity: 'category', targetId: category.id || category._id, ipAddress });
    return created(res, { category });
  } catch (err) { return next(err); }
}

async function getAllCategories(req, res, next) {
  try {
    const { type } = req.query;
    // Public view is ADMIN-CURATED: guests/buyers/sellers only ever receive
    // ACTIVE (allowed) categories. The admin console (role ADMIN, injected by
    // the gateway from the verified token) may list inactive ones and pass an
    // explicit ?status= filter to manage them.
    const role = req.headers['x-user-role'] || (req.user && req.user.role) || null;
    const status = role === 'ADMIN' ? req.query.status : 'active';
    const categories = await categoryService.getAllWithProductCount({ type, status });
    return ok(res, { categories });
  } catch (err) { return next(err); }
}

async function getActiveCategoriesByType(req, res, next) {
  try {
    const { type } = req.params;
    const categories = await categoryService.getActiveByTypeWithProductCount(type);
    return ok(res, { categories });
  } catch (err) { return next(err); }
}

async function getCategory(req, res, next) {
  try { return ok(res, { category: await categoryService.getById(req.params.id) }); }
  catch (err) { return next(err); }
}

async function updateCategory(req, res, next) {
  try {
    const category = await categoryService.update(req.params.id, req.body);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({
      action: 'CATEGORY_UPDATED', level: 'INFO', adminId, adminName, module: 'commerce',
      targetEntity: 'category', targetId: req.params.id,
      // A title rename re-points every product that referenced it — record how
      // many so the audit trail explains a bulk product change.
      details: category && category.previousTitle
        ? { previousTitle: category.previousTitle, cascadedProducts: category.cascadedProducts }
        : undefined,
      ipAddress,
    });
    return ok(res, { category });
  } catch (err) { return next(err); }
}

async function toggleCategoryStatus(req, res, next) {
  try {
    const category = await categoryService.toggleStatus(req.params.id);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'CATEGORY_STATUS_TOGGLED', level: 'INFO', adminId, adminName, module: 'commerce', targetEntity: 'category', targetId: req.params.id, ipAddress });
    return ok(res, { category });
  } catch (err) { return next(err); }
}

async function deleteCategory(req, res, next) {
  try {
    const result = await categoryService.remove(req.params.id);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'CATEGORY_DELETED', level: 'WARNING', adminId, adminName, module: 'commerce', targetEntity: 'category', targetId: req.params.id, ipAddress });
    return ok(res, result);
  } catch (err) { return next(err); }
}

module.exports = {
  createCategory,
  getAllCategories,
  getActiveCategoriesByType,
  getCategory,
  updateCategory,
  toggleCategoryStatus,
  deleteCategory,
};
