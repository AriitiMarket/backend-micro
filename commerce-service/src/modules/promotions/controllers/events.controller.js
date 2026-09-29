const eventService = require('../services/events.service');
const { ok, created } = require('../../../shared/utils/response');
const { avatarRefFromInput } = require('../../../shared/utils/imageRefs');

async function createEvent(req, res, next) {
  try {
    const files = req.files || [];
    const uploadedImages = files.map((file) => ({ public_id: file.filename, url: file.path }));

    // Support image URLs / storage keys from request body
    let urlImages = [];
    if (req.body.imageUrls) {
      const raw = req.body.imageUrls;
      let urls = [];
      if (typeof raw === 'string') {
        urls = raw.split(',').map((u) => u.trim()).filter(Boolean);
      } else if (Array.isArray(raw)) {
        urls = raw.filter(Boolean);
      }
      urlImages = urls
        .map((ref) => avatarRefFromInput(ref))
        .filter(Boolean)
        .map((ref) => ({ public_id: ref.public_id, url: ref.url }));
    }

    const images = [...uploadedImages, ...urlImages];
    const sellerId = req.user ? req.user.id : (req.body.sellerId || null);
    const event = await eventService.createEvent({ ...req.body, images, sellerId }, req.user);
    return created(res, { event });
  } catch (err) { return next(err); }
}

async function getShopEvents(req, res, next) {
  try {
    const events = await eventService.getShopEvents(req.params.id);
    return ok(res, { events });
  } catch (err) { return next(err); }
}

async function deleteEvent(req, res, next) {
  try {
    const result = await eventService.deleteEvent(req.params.id, req.user);
    return ok(res, result);
  } catch (err) { return next(err); }
}

async function getAllEvents(req, res, next) {
  try {
    const events = await eventService.getAllEvents();
    return ok(res, { events });
  } catch (err) { return next(err); }
}

module.exports = { createEvent, getShopEvents, deleteEvent, getAllEvents };
