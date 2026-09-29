const fs = require('fs');

let routes = fs.readFileSync('src/modules/partners/routes/partners.routes.js', 'utf8');
routes = routes.replace(
  /router\.put\('\/:id\/online', authenticate, authorize\('ADMIN'\), ctrl\.setOnline\);/,
  `router.put('/:id/online', authenticate, authorize.authorize ? authorize.authorize(['ADMIN', 'RIDER', 'PARTNER']) : authorize(['ADMIN', 'RIDER', 'PARTNER']), ctrl.setOnline);
router.put('/:id/location', authenticate, authorize.authorize ? authorize.authorize(['ADMIN', 'RIDER', 'PARTNER']) : authorize(['ADMIN', 'RIDER', 'PARTNER']), ctrl.updateLocation);`
);
// wait, the authorize module exports `authorize` directly AND `module.exports.authorize = authorize`.
// Let's just use `authorize(['ADMIN', 'PARTNER', 'RIDER'])`.
routes = routes.replace(/authorize\.authorize \? authorize\.authorize\(\['ADMIN', 'RIDER', 'PARTNER'\]\) : authorize\(\['ADMIN', 'RIDER', 'PARTNER'\]\)/g, "authorize(['ADMIN', 'PARTNER', 'RIDER'])");

fs.writeFileSync('src/modules/partners/routes/partners.routes.js', routes);

let ctrl = fs.readFileSync('src/modules/partners/controllers/partners.controller.js', 'utf8');

const setOnlineFn = `async function setOnline(req, res, next) {
  try { return ok(res, { partner: await svc.setOnline(req.params.id, req.body.isOnline) }); }
  catch (err) { return next(err); }
}`;

const setOnlineReplacement = `async function setOnline(req, res, next) {
  try {
    const partner = await svc.getPartner(req.params.id);
    if (req.user && req.user.role !== 'ADMIN' && partner.identityUserId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized to update another partner' });
    }
    return ok(res, { partner: await svc.setOnline(req.params.id, req.body.isOnline, getAdminFromReq(req)) });
  } catch (err) { return next(err); }
}

async function updateLocation(req, res, next) {
  try {
    const partner = await svc.getPartner(req.params.id);
    if (req.user && req.user.role !== 'ADMIN' && partner.identityUserId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized to update another partner' });
    }
    return ok(res, { partner: await svc.updateLocation(req.params.id, req.body.coordinates) });
  } catch (err) { return next(err); }
}`;

ctrl = ctrl.replace(setOnlineFn, setOnlineReplacement);
ctrl = ctrl.replace(/setOnline, approvePartner,/, 'setOnline, updateLocation, approvePartner,');

fs.writeFileSync('src/modules/partners/controllers/partners.controller.js', ctrl);
