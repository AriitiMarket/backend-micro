const fs = require('fs');
let content = fs.readFileSync('src/modules/operations/services/assignmentBatches.service.js', 'utf8');

// Inside releaseOrders
const target1 = `async function releaseOrders(batch) {`;
const replacement1 = `async function releaseOrders(batch) {
  try {
    await partnersService.decrementWorkload(batch.partnerId, batch._id, null);
  } catch (err) {}`;
content = content.replace(target1, replacement1);

// Inside markDelivered, when allDelivered is true, call completeDelivery
const target2 = `  const history = toPlain(batch.history);`;
const replacement2 = `  if (allDelivered) {
    try {
      await partnersService.completeDelivery(batch.partnerId, batch._id, actor);
    } catch (err) {}
  }
  const history = toPlain(batch.history);`;
content = content.replace(target2, replacement2);

fs.writeFileSync('src/modules/operations/services/assignmentBatches.service.js', content);
