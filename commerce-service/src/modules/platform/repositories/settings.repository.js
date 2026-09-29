const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
  key: { type: String, unique: true, required: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const Settings = mongoose.model('Settings', settingsSchema);

class SettingsRepository {
  async findOne(key) {
    return Settings.findOne({ key });
  }

  async updateOrCreate(key, value) {
    return Settings.findOneAndUpdate(
      { key },
      { key, value, updatedAt: new Date() },
      { new: true, upsert: true, runValidators: true }
    );
  }

  async find(filter = {}) {
    return Settings.find(filter);
  }

  async deleteOne(key) {
    return Settings.deleteOne({ key });
  }
}

module.exports = new SettingsRepository();
