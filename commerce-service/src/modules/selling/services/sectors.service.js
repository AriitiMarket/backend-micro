const SectorRepository = require('../repositories/sectors.repository');

class ApiError extends Error { constructor(message, statusCode) { super(message); this.statusCode = statusCode; } }

class SectorsService {
  create(data) { return SectorRepository.create(data); }
  getAll(query) { return SectorRepository.findAll(query); }
  async getById(id) {
    const sector = await SectorRepository.findById(id);
    if (!sector) throw new ApiError('Sector not found', 404);
    return sector;
  }
  async update(id, data) {
    const sector = await SectorRepository.findByIdAndUpdate(id, data);
    if (!sector) throw new ApiError('Sector not found', 404);
    return sector;
  }
  async remove(id) {
    const sector = await SectorRepository.findByIdAndDelete(id);
    if (!sector) throw new ApiError('Sector not found', 404);
    return sector;
  }
}

module.exports = new SectorsService();
