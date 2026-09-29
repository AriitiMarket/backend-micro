const fs = require('fs');
let content = fs.readFileSync('src/modules/operations/services/assignmentBatches.service.js', 'utf8');

// Inside createBatch, replace the `const batch = await batchesRepo.create({` block to include increment
const target = `  const batch = await batchesRepo.create({`;
const replacement = `  // Reserve capacity first if possible? No, we need batch ID. 
  // We'll create the batch and if increment fails, we cancel it.
  const batch = await batchesRepo.create({`;

content = content.replace(target, replacement);

const target2 = `  // Reflect the assignment on each underlying delivery.`;
const replacement2 = `  try {
    await partnersService.incrementWorkload(partner._id, batch._id, actor);
  } catch (err) {
    // Capacity exceeded race condition - rollback batch
    await batchesRepo.updateFields(batch._id, { status: 'cancelled' });
    throw err;
  }

  // Reflect the assignment on each underlying delivery.`;

content = content.replace(target2, replacement2);

fs.writeFileSync('src/modules/operations/services/assignmentBatches.service.js', content);
