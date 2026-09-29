const fs = require('fs');
let content = fs.readFileSync('src/modules/operations/__tests__/assignmentBatches.test.js', 'utf8');

const target = `test('refuses riders that are unavailable or over capacity', async () => {
  reset();
  seedPartner('busyRider', 'busy');
  const d = seedDelivery('AM-4', 'A');
  await assert.rejects(
    () => svc.createBatch({ deliveryIds: [d._id], partnerId: 'busyRider', actor }),
    /not available/,
  );`;

const replacement = `test('refuses riders that are unavailable or over capacity', async () => {
  reset();
  // An offline rider cannot be assigned
  seedPartner('busyRider', 'offline', { availability: { isOnline: false } });
  const d = seedDelivery('AM-4', 'A');
  await assert.rejects(
    () => svc.createBatch({ deliveryIds: [d._id], partnerId: 'busyRider', actor }),
    /offline/,
  );`;

content = content.replace(target, replacement);
fs.writeFileSync('src/modules/operations/__tests__/assignmentBatches.test.js', content);
