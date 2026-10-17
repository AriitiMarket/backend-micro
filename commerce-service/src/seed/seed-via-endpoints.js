#!/usr/bin/env node
const crypto = require('crypto');
const BASE = 'http://api-gateway:3000/api';

function pkceVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Buffer.from(array).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function pkceChallenge(verifier) {
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return Buffer.from(hash).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
async function api(method, path, body, token, isFormData = false) {
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  let fetchBody;
  if (isFormData) { fetchBody = body; }
  else if (body) { headers['Content-Type'] = 'application/json'; fetchBody = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers, body: fetchBody });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
async function getToken(name, email, password, role) {
  try { return await loginUser(email, password); } catch (e) {
    const verifier = pkceVerifier();
    const challenge = pkceChallenge(verifier);
    const path = role ? '/auth/register/' + role : '/auth/register';
    const reg = await api('POST', path, { name, email, password, code_challenge: challenge, code_challenge_method: 'S256' });
    if (reg.status !== 201 && reg.status !== 200) throw new Error('Register ' + email + ': ' + reg.status + ' ' + JSON.stringify(reg.data));
    const code = reg.data.code;
    if (!code) throw new Error('Register ' + email + ': no code');
    const token = await api('POST', '/auth/token', { grant_type: 'authorization_code', code, code_verifier: verifier });
    if (token.status !== 200) throw new Error('Token exchange ' + email + ': ' + token.status);
    return { accessToken: token.data.access_token };
  }
}
async function loginUser(email, password) {
  const verifier = pkceVerifier();
  const challenge = pkceChallenge(verifier);
  const auth = await api('POST', '/auth/authorize', { email, password, code_challenge: challenge, code_challenge_method: 'S256' });
  if (auth.status !== 200) throw new Error('Authorize ' + email + ': ' + auth.status);
  const code = auth.data.code;
  if (!code) throw new Error('Authorize ' + email + ': no code');
  const token = await api('POST', '/auth/token', { grant_type: 'authorization_code', code, code_verifier: verifier });
  if (token.status !== 200) throw new Error('Token exchange ' + email + ': ' + token.status);
  return { accessToken: token.data.access_token };
}
async function main() {
  console.log('Starting commerce seed via API endpoints...\n');
  const admin = await loginUser('admin@aritii.com', 'Admin@12345');
  console.log('Admin token obtained');
  const categories = [
    { title: 'Electronics', description: 'Electronic devices', type: 'product', sortOrder: 1 },
    { title: 'Fashion', description: 'Clothing and accessories', type: 'product', sortOrder: 2 },
    { title: 'Home & Living', description: 'Furniture and decor', type: 'product', sortOrder: 3 },
    { title: 'Beauty & Personal Care', description: 'Cosmetics and skincare', type: 'product', sortOrder: 4 },
    { title: 'Groceries & Food', description: 'Food and grocery items', type: 'product', sortOrder: 5 },
    { title: 'Sports Equipment', description: 'Sports gear and fitness', type: 'product', sortOrder: 6 },
    { title: 'Retail', description: 'General retail businesses', type: 'business', sortOrder: 7 },
    { title: 'Food & Beverage', description: 'Restaurants and food services', type: 'business', sortOrder: 8 },
  ];
  const createdCategories = [];
  for (const cat of categories) {
    const res = await api('POST', '/category', cat, admin.accessToken);
    if (res.status === 201 || res.status === 200) { createdCategories.push(res.data.category); console.log('Category: ' + cat.title); }
    else if (res.status === 409) {
      const list = await api('GET', '/category/active/product', null, admin.accessToken);
      const existing = (list.data.categories || []).find(c => c.title === cat.title);
      if (existing) createdCategories.push(existing);
    } else { console.log('Failed ' + cat.title + ': ' + res.status); }
  }
  const sellers = [
    { name: 'TechHub Seller', email: 'seller1@aritii.com', password: 'Seller@12345' },
    { name: 'Fashion Hub Seller', email: 'seller2@aritii.com', password: 'Seller@12345' },
    { name: 'Fresh Market Seller', email: 'seller3@aritii.com', password: 'Seller@12345' },
  ];
  const sellerSessions = [];
  for (const s of sellers) {
    try {
      const session = await getToken(s.name, s.email, s.password, 'SELLER');
      sellerSessions.push({ ...s, session });
      console.log('Seller ready: ' + s.email);
    } catch (err) { console.log('Seller failed ' + s.email + ': ' + err.message); }
  }
  const applications = [];
  for (const s of sellerSessions) {
    const appPayload = {
      sellerType: 'BUSINESS',
      submit: true,
      businessInformation: {
        businessName: s.name,
        businessCategory: s.name.includes('Tech') ? 'Retail' : s.name.includes('Fashion') ? 'Retail' : 'Food & Beverage',
      },
      location: {
        city: 'Addis Ababa',
        cityName: 'Addis Ababa',
      },
      shopInformation: {
        shopName: s.name,
      },
    };
    const res = await api('POST', '/seller-application', appPayload, s.session.accessToken);
    if (res.status === 201) applications.push(res.data.application);
    else console.log('Application failed ' + s.email + ': ' + res.status + ' ' + JSON.stringify(res.data).slice(0, 200));
  }
  const approvedSellers = [];
  for (let i = 0; i < applications.length; i++) {
    const app = applications[i];
    const seller = sellerSessions[i];
    const appId = app.id || app._id;
    console.log('Approving app ID:', appId);
    const res = await api('POST', '/seller-application/' + appId + '/approve', {}, admin.accessToken);
    if (res.status === 200) {
      // Re-login to get fresh token with APPROVED status
      try {
        const freshSession = await loginUser(s.email, s.password);
        seller.session.accessToken = freshSession.accessToken;
        console.log('Seller re-logged in with fresh token: ' + s.email);
      } catch (e) {
        console.log('Seller re-login failed ' + s.email + ': ' + e.message);
      }
      approvedSellers.push({ ...seller });
      console.log('Seller approved: ' + seller.email);
    } else {
      console.log('Approval failed ' + seller.email + ': ' + res.status + ' ' + JSON.stringify(res.data).slice(0, 200));
    }
  }
  const shops = [
    { name: 'TechHub Electronics', email: 'shop1@aritii.com', address: '100 Tech Street, Addis Ababa', phoneNumber: '0911000001', zipCode: '10001', category: 'Retail', description: 'Electronics and gadgets', shopIndex: 0 },
    { name: 'Fashion Forward', email: 'shop2@aritii.com', address: '200 Fashion Ave, Addis Ababa', phoneNumber: '0911000002', zipCode: '10002', category: 'Retail', description: 'Clothing and accessories', shopIndex: 1 },
    { name: 'Harar Fresh Market', email: 'shop3@aritii.com', address: '300 Market Road, Harar', phoneNumber: '0911000003', zipCode: '10003', category: 'Food & Beverage', description: 'Fresh produce and groceries', shopIndex: 2 },
  ];
  const createdShops = [];
  for (let i = 0; i < shops.length && i < approvedSellers.length; i++) {
    const shop = shops[i];
    const seller = approvedSellers[i];
    const formData = new FormData();
    formData.append('name', shop.name);
    formData.append('email', shop.email);
    formData.append('address', shop.address);
    formData.append('phoneNumber', shop.phoneNumber);
    formData.append('zipCode', shop.zipCode);
    formData.append('category', shop.category);
    formData.append('description', shop.description);
    const res = await api('POST', '/shop/create-shop', formData, seller.session.accessToken, true);
    if (res.status === 201) { createdShops.push(res.data.shop); console.log('Shop: ' + shop.name); }
    else console.log('Shop failed ' + shop.name + ': ' + res.status + ' ' + JSON.stringify(res.data).slice(0, 200));
  }
