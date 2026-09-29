const Event = require('../models/Events');

class EventRepository {
  create(data) { return Event.create(data); }
  findById(id) { return Event.findById(id); }
  findByShop(shopId) { return Event.find({ shopId }); }
  findAll(sort = { createdAt: -1 }) { return Event.find().sort(sort); }
  deleteById(id) { return Event.findByIdAndDelete(id); }
}

module.exports = new EventRepository();
