const crypto = require('crypto');

const API_BASE = String(process.env.CHAPA_API_BASE_URL || 'https://api.chapa.co/v1').replace(/\/+$/, '');

function requireSecret() {
  const secret = String(process.env.CHAPA_SECRET_KEY || '').trim();
  if (!secret) {
    const error = new Error('Chapa is not configured on the server');
    error.statusCode = 503;
    error.code = 'CHAPA_NOT_CONFIGURED';
    throw error;
  }
  return secret;
}

async function request(path, options = {}) {
  const secret = requireSecret();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method: options.method || 'GET',
      headers: {
        Authorization: `Bearer ${secret}`,
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body?.message || `Chapa request failed (${response.status})`);
      error.statusCode = response.status === 401 ? 503 : 502;
      error.code = response.status === 401 ? 'CHAPA_AUTH_FAILED' : 'CHAPA_PROVIDER_ERROR';
      error.providerStatus = response.status;
      throw error;
    }
    return body;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('Chapa request timed out');
      timeoutError.statusCode = 504;
      timeoutError.code = 'CHAPA_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function initializeTransaction(fields) {
  const response = await request('/transaction/initialize', { method: 'POST', body: fields });
  const checkoutUrl = response?.data?.checkout_url;
  if (String(response?.status || '').toLowerCase() !== 'success' || !checkoutUrl) {
    const error = new Error(response?.message || 'Chapa did not return a checkout link');
    error.statusCode = 502;
    error.code = 'CHAPA_INITIALIZE_FAILED';
    throw error;
  }
  return { checkoutUrl, providerReference: response?.data?.reference || null };
}

async function verifyTransaction(txRef) {
  if (!txRef || !/^[A-Za-z0-9_-]{1,120}$/.test(String(txRef))) {
    const error = new Error('Invalid Chapa transaction reference');
    error.statusCode = 422;
    error.code = 'INVALID_TX_REF';
    throw error;
  }
  return request(`/transaction/verify/${encodeURIComponent(String(txRef))}`);
}

async function testConnection() {
  // A deliberately unissued reference makes no charge. Chapa's verify API
  // authenticates the secret before returning a not-found transaction result.
  const reference = `aritii_connection_${crypto.randomBytes(8).toString('hex')}`;
  try {
    await verifyTransaction(reference);
    return { success: true, provider: 'chapa', environment: process.env.CHAPA_ENVIRONMENT || 'sandbox' };
  } catch (error) {
    if (error.code === 'CHAPA_PROVIDER_ERROR' && [400, 404].includes(error.providerStatus)) {
      return { success: true, provider: 'chapa', environment: process.env.CHAPA_ENVIRONMENT || 'sandbox' };
    }
    throw error;
  }
}

module.exports = { initializeTransaction, verifyTransaction, testConnection };
