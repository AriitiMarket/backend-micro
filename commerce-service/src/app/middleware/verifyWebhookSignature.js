const crypto = require('crypto');

/**
 * FIX #2: Verify webhook signatures to prevent forged payment updates
 * Checks HMAC-SHA256 signature and timestamp to ensure request is authentic
 * Enforces constant-time comparison and configurable replay protection tolerance.
 */
function verifyPaymentWebhookSignature(req, res, next) {
  const signature = req.headers['x-payment-signature']
    || req.headers['x-chapa-signature']
    || req.headers['chapa-signature']
    || req.headers['x-webhook-signature'];

  const timestamp = req.headers['x-payment-timestamp']
    || req.headers['x-webhook-timestamp']
    || req.headers['x-chapa-timestamp']
    || (req.body && (req.body.timestamp || req.body.created_at));

  const secret = process.env.PAYMENT_WEBHOOK_SECRET
    || process.env.CHAPA_WEBHOOK_SECRET
    || process.env.CHAPA_SECRET_KEY;

  // Validate headers / secret exist
  if (!signature || !secret) {
    console.warn('Missing webhook verification signature or secret');
    return res.status(401).json({
      success: false,
      error: 'Invalid webhook request',
      code: 'MISSING_SIGNATURE'
    });
  }

  // If x-payment-signature was specifically used, timestamp header is required for replay guard
  if (req.headers['x-payment-signature'] && !timestamp) {
    console.warn('Missing webhook verification timestamp');
    return res.status(401).json({
      success: false,
      error: 'Invalid webhook request',
      code: 'MISSING_SIGNATURE'
    });
  }

  // Prevent replay attacks (configurable tolerance via WEBHOOK_TOLERANCE_SECONDS, default 300s = 5m)
  const toleranceSeconds = parseInt(process.env.WEBHOOK_TOLERANCE_SECONDS || '300', 10);
  const maxToleranceMs = (Number.isFinite(toleranceSeconds) ? toleranceSeconds : 300) * 1000;

  if (timestamp) {
    let parsedTime = NaN;
    if (typeof timestamp === 'number') {
      parsedTime = timestamp > 1e11 ? timestamp : timestamp * 1000;
    } else if (typeof timestamp === 'string') {
      parsedTime = /^\d+$/.test(timestamp)
        ? (Number(timestamp) > 1e11 ? Number(timestamp) : Number(timestamp) * 1000)
        : Date.parse(timestamp);
    }

    if (Number.isNaN(parsedTime)) {
      console.warn(`Webhook timestamp invalid: ${timestamp}`);
      return res.status(401).json({
        success: false,
        error: 'Invalid webhook timestamp',
        code: 'INVALID_TIMESTAMP'
      });
    }

    const requestAge = Date.now() - parsedTime;
    if (Math.abs(requestAge) > maxToleranceMs) {
      console.warn(`Webhook timestamp out of tolerance: ${requestAge}ms (max ${maxToleranceMs}ms)`);
      return res.status(401).json({
        success: false,
        error: 'Request timestamp too old',
        code: 'STALE_REQUEST'
      });
    }
  }

  // Reconstruct signed payload candidates:
  // 1. timestamp + body (standard internal format: `${timestamp}.${payload}`)
  // 2. raw body (standard Chapa provider webhook format: HMAC of body string)
  const payload = JSON.stringify(req.body);
  const candidateHashes = [];

  if (timestamp) {
    const signedDataWithTimestamp = `${timestamp}.${payload}`;
    candidateHashes.push(
      crypto.createHmac('sha256', secret).update(signedDataWithTimestamp).digest('hex')
    );
  }

  candidateHashes.push(
    crypto.createHmac('sha256', secret).update(payload).digest('hex')
  );

  // Constant-time comparison to prevent timing attacks
  const sigBuf = Buffer.from(String(signature), 'utf8');
  let matched = false;

  for (const computedHash of candidateHashes) {
    const compBuf = Buffer.from(computedHash, 'utf8');
    if (compBuf.length === sigBuf.length && crypto.timingSafeEqual(compBuf, sigBuf)) {
      matched = true;
      break;
    }
  }

  if (!matched) {
    console.warn('Webhook signature mismatch');
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
module.exports.verifyPaymentWebhookSignature = verifyPaymentWebhookSignature;
module.exports.verifyWebhookSignature = verifyPaymentWebhookSignature;
