// Shop request validators.
//
// Creation is seller-only (the route carries `authenticate` + `authorize('SELLER')`)
// and the OWNER is always the authenticated caller — `ownerId`/`businessId` in the
// body are ignored by the service, so they are never validated here either.
const validateCreateShop = (req, res, next) => {
  const errors = [];
  if (!req.body.name || String(req.body.name).trim().length < 2) errors.push('Business name is required (min 2 chars)');
  if (!req.body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.body.email)) errors.push('Valid email is required');
  if (!req.body.address || !String(req.body.address).trim()) errors.push('Address is required');
  if (req.body.phoneNumber === undefined || req.body.phoneNumber === null || req.body.phoneNumber === '' ||
      !/^\+?[0-9\s\-()]{5,20}$/.test(String(req.body.phoneNumber).trim())) {
    errors.push('Valid phone number is required');
  }
  if (req.body.zipCode !== undefined && req.body.zipCode !== null && req.body.zipCode !== '' &&
      !/^[0-9]{1,10}$/.test(String(req.body.zipCode).trim())) {
    errors.push('Zip code must be numeric');
  }
  if (req.body.locationId !== undefined && req.body.locationId !== null && req.body.locationId !== '' &&
      typeof req.body.locationId !== 'string') {
    errors.push('locationId must be a string id');
  }
  if (req.body.sectorId !== undefined && req.body.sectorId !== null && req.body.sectorId !== '' &&
      typeof req.body.sectorId !== 'string') {
    errors.push('sectorId must be a string id');
  }
  if (errors.length) return failValidation(res, errors);
  next();
};

/**
 * Validate a shop UPDATE (partial — only fields present are checked).
 *
 * Admin/ownership fields (`status`, `showOnPublic`, `ownerId`, `applicationId`,
 * `availableBalance`, `approvalMetadata`, `locationSnapshot`) are deliberately
 * NOT accepted here: the service allowlist drops them, and the snapshot is
 * rebuilt server-side from the Delivery hierarchy.
 */
const validateUpdateShop = (req, res, next) => {
  const errors = [];
  const body = req.body || {};

  if (body.name !== undefined && body.name !== null && String(body.name).trim().length < 2) {
    errors.push('Business name must be at least 2 chars');
  }
  if (body.email !== undefined && body.email !== null && body.email !== '' &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.email))) {
    errors.push('Valid email is required');
  }
  if (body.address !== undefined && body.address !== null && body.address !== '' && !String(body.address).trim()) {
    errors.push('Address cannot be empty');
  }
  if (body.phoneNumber !== undefined && body.phoneNumber !== null && body.phoneNumber !== '' &&
      !/^\+?[0-9\s\-()]{5,20}$/.test(String(body.phoneNumber).trim())) {
    errors.push('Valid phone number is required');
  }
  if (body.zipCode !== undefined && body.zipCode !== null && body.zipCode !== '' &&
      !/^[0-9]{1,10}$/.test(String(body.zipCode).trim())) {
    errors.push('Zip code must be numeric');
  }
  for (const key of ['locationId', 'sectorId', 'shopId']) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== '' && typeof body[key] !== 'string') {
      errors.push(`${key} must be a string id`);
    }
  }

  if (errors.length) return failValidation(res, errors);
  next();
};

// Shared 400 shape — keeps `code` present so clients never have to handle
// responses with and without it (errorHandler always includes `code`).
function failValidation(res, errors) {
  return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Validation failed', errors });
}

const validateCreateProduct = (req, res, next) => {
  const errors = [];
  if (!req.body.name || req.body.name.trim().length < 2) errors.push('Product name is required (min 2 chars)');
  else if (req.body.name.trim().length > 200) errors.push('Product name must be at most 200 chars');
  if (!req.body.description || req.body.description.trim().length < 10) errors.push('Description is required (min 10 chars)');
  else if (req.body.description.trim().length > 5000) errors.push('Description must be at most 5000 chars');
  if (!req.body.category) errors.push('Category is required');
  if (req.body.tags !== undefined && req.body.tags !== null && String(req.body.tags).length > 500) {
    errors.push('Tags must be at most 500 chars');
  }
  if (req.body.sku !== undefined && req.body.sku !== null && String(req.body.sku).trim().length > 64) {
    errors.push('SKU must be at most 64 chars');
  }

  // `discountPrice` is the REAL selling price (schema-required). It used to be
  // unvalidated while the optional list price was checked instead.
  const discountRaw = req.body.discountPrice;
  if (discountRaw === undefined || discountRaw === null || discountRaw === '') {
    errors.push('Price is required');
  } else {
    const discount = Number(discountRaw);
    if (!Number.isFinite(discount) || discount <= 0) errors.push('Price must be a number greater than 0');
  }

  // Optional list/compare-at price (only when a discount is advertised).
  if (req.body.originalPrice !== undefined && req.body.originalPrice !== null && req.body.originalPrice !== '') {
    const original = Number(req.body.originalPrice);
    if (!Number.isFinite(original) || original < 0) {
      errors.push('Original price must be a number >= 0');
    } else if (Number.isFinite(Number(discountRaw)) && original > 0 && Number(discountRaw) > original) {
      errors.push('Price cannot exceed the original price');
    }
  }

  if (req.body.stock === undefined || req.body.stock === null || req.body.stock === '') {
    errors.push('Stock is required (>= 0)');
  } else {
    const stock = Number(req.body.stock);
    if (!Number.isFinite(stock) || stock < 0) errors.push('Stock must be a number >= 0');
    else if (!Number.isInteger(stock)) errors.push('Stock must be a whole number');
  }

  if (errors.length) return failValidation(res, errors);
  next();
};

/**
 * Validate a product UPDATE. The update route previously had NO validator, so
 * negative prices/stock and oversized strings passed straight to the service.
 * Only fields present in the body are checked (partial update).
 */
const validateUpdateProduct = (req, res, next) => {
  const errors = [];
  const body = req.body || {};

  if (body.name !== undefined && body.name !== null && body.name !== '') {
    const name = String(body.name).trim();
    if (name.length < 2) errors.push('Product name must be at least 2 chars');
    else if (name.length > 200) errors.push('Product name must be at most 200 chars');
  }
  if (body.description !== undefined && body.description !== null && body.description !== '') {
    const description = String(body.description).trim();
    if (description.length < 10) errors.push('Description must be at least 10 chars');
    else if (description.length > 5000) errors.push('Description must be at most 5000 chars');
  }
  if (body.tags !== undefined && body.tags !== null && String(body.tags).length > 500) {
    errors.push('Tags must be at most 500 chars');
  }
  if (body.sku !== undefined && body.sku !== null && String(body.sku).trim().length > 64) {
    errors.push('SKU must be at most 64 chars');
  }
  if (body.discountPrice !== undefined && body.discountPrice !== null && body.discountPrice !== '') {
    const price = Number(body.discountPrice);
    if (!Number.isFinite(price) || price <= 0) errors.push('Price must be a number greater than 0');
  }
  if (body.originalPrice !== undefined && body.originalPrice !== null && body.originalPrice !== '') {
    const original = Number(body.originalPrice);
    if (!Number.isFinite(original) || original < 0) errors.push('Original price must be a number >= 0');
    // Cross-field rule lives in the CREATE validator and the UPDATE service;
    // checking the pair here too keeps both routes on the same contract.
    else if (
      body.discountPrice !== undefined && body.discountPrice !== null && body.discountPrice !== '' &&
      Number.isFinite(Number(body.discountPrice)) && original > 0 && Number(body.discountPrice) > original
    ) {
      errors.push('Price cannot exceed the original price');
    }
  }
  if (body.stock !== undefined && body.stock !== null && body.stock !== '') {
    const stock = Number(body.stock);
    if (!Number.isFinite(stock) || stock < 0) errors.push('Stock must be a number >= 0');
    else if (!Number.isInteger(stock)) errors.push('Stock must be a whole number');
  }
  if (body.lowStockThreshold !== undefined && body.lowStockThreshold !== null && body.lowStockThreshold !== '') {
    const threshold = Number(body.lowStockThreshold);
    if (!Number.isFinite(threshold) || threshold < 0) errors.push('Low stock threshold must be a number >= 0');
  }

  if (errors.length) return failValidation(res, errors);
  next();
};

/**
 * Validate order creation payload.
 *
 * Required:
 *   - cart: non-empty array
 *   - destination: object with sectorId and fullAddress
 *   - user: object
 *
 * The destination must include:
 *   - sectorId (or sectorId at minimum)
 *   - fullAddress (non-empty string)
 *
 * Region/Area/City IDs are validated at service level against the Delivery hierarchy.
 */
const validateCreateOrder = (req, res, next) => {
  const errors = [];
  if (!req.body.cart || !Array.isArray(req.body.cart) || req.body.cart.length === 0) {
    errors.push('Cart items are required');
  }
  if (!req.body.user) {
    errors.push('User info is required');
  }

  // Destination location validation
  const dest = req.body.destination;
  if (!dest) {
    errors.push('Delivery destination is required (destination.sectorId, destination.fullAddress)');
  } else {
    if (!dest.sectorId) errors.push('destination.sectorId is required');
    if (!dest.fullAddress || !String(dest.fullAddress).trim()) errors.push('destination.fullAddress is required');
    if (!dest.phone || !String(dest.phone).trim()) errors.push('destination.phone is required');
    if (dest.regionId && !dest.regionName) errors.push('destination.regionName is required when regionId is provided');
    if (dest.areaId && !dest.areaName) errors.push('destination.areaName is required when areaId is provided');
    if (dest.cityId && !dest.cityName) errors.push('destination.cityName is required when cityId is provided');
  }

  if (errors.length) return failValidation(res, errors);
  next();
};

const validateCreateCoupon = (req, res, next) => {
  const errors = [];
  if (!req.body.name || req.body.name.trim().length < 2) errors.push('Coupon name is required');
  if (req.body.value === undefined || req.body.value === null) errors.push('Coupon value is required');
  if (errors.length) return failValidation(res, errors);
  next();
};

module.exports = {
  validateCreateShop,
  validateUpdateShop,
  validateCreateProduct,
  validateUpdateProduct,
  validateCreateOrder,
  validateCreateCoupon,
};
