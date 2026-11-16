'use strict';

/**
 * Catalog domain validators for products.
 */

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

  const discountRaw = req.body.discountPrice;
  if (discountRaw === undefined || discountRaw === null || discountRaw === '') {
    errors.push('Price is required');
  } else {
    const discount = Number(discountRaw);
    if (!Number.isFinite(discount) || discount <= 0) errors.push('Price must be a number greater than 0');
  }

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

module.exports = {
  validateCreateProduct,
  validateUpdateProduct,
};
