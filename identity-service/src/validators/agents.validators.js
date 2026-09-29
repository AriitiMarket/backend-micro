// Agent request validators for Identity Service.
function validateCreateAgent(req, res, next) {
  const errors = [];
  if (!req.body.userId && !req.user) errors.push('userId is required (or authenticated)');
  if (req.body.commissionRate !== undefined && (req.body.commissionRate < 0 || req.body.commissionRate > 100)) {
    errors.push('Commission rate must be between 0 and 100');
  }
  if (errors.length) return res.status(400).json({ success: false, message: 'Validation failed', errors });
  next();
}

function validateVerifyAgent(req, res, next) {
  const errors = [];
  const status = req.body.verificationStatus;
  if (!status) errors.push('verificationStatus is required');
  else if (!['PENDING', 'APPROVED', 'REJECTED'].includes(status)) errors.push('Invalid verification status');
  if (errors.length) return res.status(400).json({ success: false, message: 'Validation failed', errors });
  next();
}

function validateCommissionRate(req, res, next) {
  const errors = [];
  const rate = req.body.commissionRate;
  if (rate === undefined || rate < 0 || rate > 100) errors.push('Commission rate must be between 0 and 100');
  if (errors.length) return res.status(400).json({ success: false, message: 'Validation failed', errors });
  next();
}

module.exports = { validateCreateAgent, validateVerifyAgent, validateCommissionRate };