const crypto = require('crypto');
const BASE = 'http://api-gateway:3000/api';

function pkceVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Buffer.from(array).toString('base64').replace(/+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function pkceChallenge(verifier) {
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return Buffer.from(hash).toString('base64').replace(/+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
async function api(method, path, body, token) {
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: JSON.stringify(body) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
async function main() {
  const verifier = pkceVerifier();
  const challenge = pkceChallenge(verifier);
  const reg = await api('POST', '/auth/register/SELLER', { name: 'Debug Seller', email: 'debug2@aritii.com', password: 'Seller@12345', code_challenge: challenge, code_challenge_method: 'S256' });
  console.log('Register status:', reg.status);
  console.log('Register data keys:', Object.keys(reg.data || {}));
  console.log('Register data:', JSON.stringify(reg.data).slice(0, 800));
  
  if (reg.data.code) {
    const token = await api('POST', '/auth/token', { grant_type: 'authorization_code', code: reg.data.code, code_verifier: verifier });
    console.log('Token status:', token.status);
    const accessToken = token.data.access_token;
    
    const app = await api('POST', '/seller-application', { name: 'Debug Shop', email: 'debug2@aritii.com', businessType: 'RETAIL', description: 'Debug business' }, accessToken);
    console.log('Application status:', app.status);
    console.log('Application data:', JSON.stringify(app.data).slice(0, 800));
    
    if (app.data.application) {
      const appId = app.data.application.id || app.data.application._id;
      console.log('App ID:', appId);
      const approve = await api('POST', '/seller-application/' + appId + '/approve', {}, 'ADMIN_TOKEN');
      console.log('Approve status:', approve.status);
      console.log('Approve data:', JSON.stringify(approve.data).slice(0, 500));
    }
  }
}
main().catch(e => console.error('Error:', e.message));