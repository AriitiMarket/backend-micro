// Address request validators for Identity Service.
// Supports both legacy format (country, city, address1) and new location hierarchy format.
function validateCreateAddress(req, res, next) {
  const errors = [];

  // New location hierarchy format
  const hasNewFormat = req.body.sectorId || req.body.regionId;

  if (hasNewFormat) {
    // New format: require sectorId and phone
    if (!req.body.sectorId) errors.push('Sector is required');
    if (!req.body.phone) errors.push('Phone number is required');
    const hasDetail = req.body.houseBuilding || req.body.landmark || req.body.description;
    if (!hasDetail) errors.push('At least one of house/building, landmark, or description is required');
  } else {
    // Legacy format: require country, city, address1
    if (!req.body.country) errors.push('Country is required');
    if (!req.body.city) errors.push('City is required');
    if (!req.body.address1 && !req.body.street) errors.push('Address line 1 is required');
  }

  if (errors.length) return res.status(400).json({ success: false, message: 'Validation failed', errors });
  next();
}

module.exports = { validateCreateAddress };