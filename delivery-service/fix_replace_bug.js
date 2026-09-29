const fs = require('fs');
let content = fs.readFileSync('src/modules/operations/services/assignmentBatches.service.js', 'utf8');

content = content.replace(`  if (allDelivered) {
    try {
      await partnersService.completeDelivery(batch.partnerId, batch._id, actor);
    } catch (err) {}
  }
  const history = toPlain(batch.history);`, `  const history = toPlain(batch.history);`);

const target = `  const allDelivered = batch.deliveries.every((d) => d.status === 'delivered');
  const history = toPlain(batch.history);`;

const replacement = `  const allDelivered = batch.deliveries.every((d) => d.status === 'delivered');
  if (allDelivered) {
    try {
      await partnersService.completeDelivery(batch.partnerId, batch._id, actor);
    } catch (err) {}
  }
  const history = toPlain(batch.history);`;

content = content.replace(target, replacement);

fs.writeFileSync('src/modules/operations/services/assignmentBatches.service.js', content);
