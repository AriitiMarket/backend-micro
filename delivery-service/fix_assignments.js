const fs = require('fs');
let content = fs.readFileSync('src/modules/operations/services/assignments.service.js', 'utf8');

// Replace assertPartnerCanServe completely
content = content.replace(/function assertPartnerCanServe[\s\S]*?\}\n\}/, '');

// Update createAssignment to use eligibility and capacity
const targetCreate = `  const partner = await partnersService.getPartner(data.partnerId);
  if (partner.status === 'suspended' || partner.status === 'offline') {
    throw Object.assign(new Error('Delivery actor is not available'), { status: 400 });
  }
  if (partner.status !== 'available') {
    throw Object.assign(new Error('Partner is not available'), { status: 400 });
  }
  assertPartnerCanServe(partner, delivery);

  const active = await assignmentsRepo.findActiveByPartnerId(data.partnerId);
  if (active.length >= 3) {
    throw Object.assign(new Error('Partner has reached maximum active assignments'), { status: 400 });
  }`;

const replacementCreate = `  const partner = await partnersService.getPartner(data.partnerId);
  const destSector = delivery.destination && delivery.destination.sectorId ? String(delivery.destination.sectorId) : null;
  const destZone = delivery.destination && delivery.destination.zoneId ? String(delivery.destination.zoneId) : null;

  const eligibility = partnersService.isPartnerEligible(partner, { 
    zoneId: destZone,
    serviceId: data.serviceId || delivery.serviceId
  });
  if (!eligibility.eligible) {
    throw Object.assign(new Error(\`Partner not eligible: \${eligibility.reason}\`), { status: 400 });
  }
  
  if (destSector && partner.sectorId && String(partner.sectorId) !== destSector) {
    throw Object.assign(new Error('Delivery actor does not serve this sector'), { status: 400 });
  }`;

content = content.replace(targetCreate, replacementCreate);

// Fix increment/decrement payload
const targetInc = `  await partnersService.setPartnerStatus(data.partnerId, 'busy');
  await partnersService.incrementWorkload(data.partnerId);`;

const replacementInc = `  // setPartnerStatus is automatically handled by incrementWorkload if capacity is full
  try {
    await partnersService.incrementWorkload(data.partnerId, assignment._id, null);
  } catch (err) {
    await assignmentsRepo.updateFields(assignment._id, { status: 'cancelled' });
    throw err;
  }`;

content = content.replace(targetInc, replacementInc);

const targetDec1 = `  await partnersService.setPartnerStatus(partnerId, 'available');
  await partnersService.decrementWorkload(partnerId);`;
const replacementDec1 = `  await partnersService.decrementWorkload(partnerId, id, null);`;
content = content.replace(targetDec1, replacementDec1);

const targetDec2 = `  if (previousPartnerId && String(previousPartnerId) !== String(newPartnerId)) {
    await partnersService.setPartnerStatus(previousPartnerId, 'available');
    await partnersService.decrementWorkload(previousPartnerId);
  }`;
const replacementDec2 = `  if (previousPartnerId && String(previousPartnerId) !== String(newPartnerId)) {
    // We would need the old assignment id here, but we can just use the active assignments list
    const oldAssignments = await assignmentsRepo.findActiveByDeliveryId(deliveryId);
    if (oldAssignments.length > 0) {
      for (const a of oldAssignments) {
        await partnersService.decrementWorkload(previousPartnerId, a._id, null);
      }
    }
  }`;
content = content.replace(targetDec2, replacementDec2);

// Re-read and apply all target replaces properly
fs.writeFileSync('src/modules/operations/services/assignments.service.js', content);
