const fs = require('fs');
let content = fs.readFileSync('src/modules/operations/services/assignments.service.js', 'utf8');

const target = `  await assignmentsRepo.cancelActiveByDelivery(deliveryId);
  if (previousPartnerId && String(previousPartnerId) !== String(newPartnerId)) {
    // We would need the old assignment id here, but we can just use the active assignments list
    const oldAssignments = await assignmentsRepo.findActiveByDeliveryId(deliveryId);`;

const replacement = `  const oldAssignments = await assignmentsRepo.findActiveByDeliveryId(deliveryId);
  await assignmentsRepo.cancelActiveByDelivery(deliveryId);
  if (previousPartnerId && String(previousPartnerId) !== String(newPartnerId)) {`;

content = content.replace(target, replacement);
fs.writeFileSync('src/modules/operations/services/assignments.service.js', content);
