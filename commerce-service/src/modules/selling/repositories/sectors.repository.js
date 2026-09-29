const Sector = require('../models/Sectors');

class SectorRepository {
  create(data) { return Sector.create(data); }
  findById(id) { return Sector.findById(id); }
  findAll() { return Sector.find({}).sort({ createdAt: -1 }); }
  findActive() { return Sector.find({ isActive: true }); }
  findByCity(city) { return Sector.find({ city }); }
  findByIdAndUpdate(id, data) { return Sector.findByIdAndUpdate(id, data, { new: true }); }
  findByIdAndDelete(id) { return Sector.findByIdAndDelete(id); }

  // --- Admin / analytics reads -------------------------------------------

  count(filter = {}) {
    return Sector.countDocuments(filter);
  }

  countActive() {
    return Sector.countDocuments({ isActive: true });
  }

  findAllLean(filter = {}) {
    return Sector.find(filter).sort({ name: 1 }).lean();
  }
}

module.exports = new SectorRepository();
