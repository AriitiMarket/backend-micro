const crypto = require('crypto');

/**
 * FIX #2: Verify webhook signatures to prevent forged payment updates
 * Checks HMAC-SHA256 signature and timestamp to ensure request is authentic
 */
function verifyPaymentWebhookSignature(req, res, next) {
  const signature = req.headers['x-payment-signature'];
  const timestamp = req.headers['x-payment-timestamp'];
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;

  // Validate headers exist
  if (!signature || !timestamp || !secret) {
    console.warn('Missing webhook verification headers/secret');
    return res.status(401).json({
      success: false,
      error: 'Invalid webhook request',
      code: 'MISSING_SIGNATURE'
    });
  }

  // Prevent replay attacks (request must be within 5 minutes)
  const requestAge = Date.now() - parseInt(timestamp);
  if (requestAge > 5 * 60 * 1000) {
    console.warn(`Webhook too old: ${requestAge}ms`);
    return res.status(401).json({
      success: false,
      error: 'Request timestamp too old',
      code: 'STALE_REQUEST'
    });
  }

  // Reconstruct signed payload: timestamp + body
  const payload = JSON.stringify(req.body);
  const signedData = `${timestamp}.${payload}`;

  // Compute HMAC-SHA256
  const computedHash = crypto
    .createHmac('sha256', secret)
    .update(signedData)
    .digest('hex');

  // Constant-time comparison to prevent timing attacks
  try {
    if (!crypto.timingSafeEqual(Buffer.from(computedHash), Buffer.from(signature))) {
      console.warn('Webhook signature mismatch');
      return res.status(401).json({
        success: false,
        error: 'Invalid signature',
        code: 'INVALID_SIGNATURE'
      });
    }
  } catch (err) {
    console.warn('Signature comparison failed:', err.message);
    return res.status(401).json({
      success: false,
      error: 'Invalid signature',
      code: 'INVALID_SIGNATURE'
    });
  }

  // Verification passed, proceed
  next();
}

module.exports = verifyPaymentWebhookSignature;
