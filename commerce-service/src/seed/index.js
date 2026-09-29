const mongoose = require('mongoose');
const env = require('../app/config/env');
const { seedHarariRegion } = require('./harari');

async function seed() {
  try {
    console.log('[seed] Connecting to MongoDB...');
    await mongoose.connect(env.MONGODB_URI);
    
    console.log('[seed] Connected. Starting data seeding...');
    
    await seedHarariRegion();
    
    console.log('[seed] ✅ All data seeded successfully');
    process.exit(0);
  } catch (err) {
    console.error('[seed] Error:', err.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  seed();
}

module.exports = seed;
