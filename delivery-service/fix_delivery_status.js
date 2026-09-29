const fs = require('fs');
let content = fs.readFileSync('src/modules/delivery-fulfillment/services/delivery-status.service.js', 'utf8');

content = content.replace(`async function _releasePartner(partnerId) {
  if (!partnerId) return;
  await partnersService.decrementWorkload(partnerId);
  const stillActive = await deliveriesRepo.findByPartnerId(partnerId);
  if (stillActive.length === 0) {
    await partnersService.setPartnerStatus(partnerId, 'available');
  }
}`, `async function _releasePartner(partnerId, assignmentId) {
  if (!partnerId) return;
  if (assignmentId) await partnersService.decrementWorkload(partnerId, assignmentId);
  // Status transition is now handled automatically by decrementWorkload!
}`);

content = content.replace(`    if (delivery.partnerId) {
      await partnersService.completeDelivery(delivery.partnerId);
      await partnersService.setPartnerStatus(delivery.partnerId, 'available');
      await assignmentsRepo.cancelActiveByDelivery(id);
    }`, `    if (delivery.partnerId) {
      if (delivery.assignmentId) await partnersService.completeDelivery(delivery.partnerId, delivery.assignmentId);
      await assignmentsRepo.cancelActiveByDelivery(id);
    }`);

content = content.replace(`  } else if (newStatus === 'failed' || newStatus === 'cancelled') {
    if (delivery.partnerId) {
      await _releasePartner(delivery.partnerId);
      await assignmentsRepo.cancelActiveByDelivery(id);
    }
  } else if (newStatus === 'reassigned') {
    if (delivery.partnerId) await partnersService.decrementWorkload(delivery.partnerId);
  }`, `  } else if (newStatus === 'failed' || newStatus === 'cancelled') {
    if (delivery.partnerId) {
      await _releasePartner(delivery.partnerId, delivery.assignmentId);
      await assignmentsRepo.cancelActiveByDelivery(id);
    }
  } else if (newStatus === 'reassigned') {
    if (delivery.partnerId && delivery.assignmentId) {
      await partnersService.decrementWorkload(delivery.partnerId, delivery.assignmentId);
    }
  }`);

fs.writeFileSync('src/modules/delivery-fulfillment/services/delivery-status.service.js', content);
