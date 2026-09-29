const fs = require('fs');
let content = fs.readFileSync('src/modules/operations/services/assignmentBatches.service.js', 'utf8');

// Replace the partner checks with a call to eligibilityService
const target = `  const partner = await partnersService.getPartner(partnerId);
  if (partner.status === 'pending') throw badRequest('Rider is not approved yet');
  if (partner.status === 'suspended') throw badRequest('Rider is suspended');
  if (partner.status === 'offline') throw badRequest('Rider is offline');
  if (partner.status !== 'available') {
    throw badRequest(\`Rider is not available (current status: \${partner.status})\`);
  }`;

const replacement = `  const partner = await partnersService.getPartner(partnerId);
  
  // Use centralized eligibility logic
  const eligibility = partnersService.isPartnerEligible(partner);
  if (!eligibility.eligible) {
    throw badRequest(\`Rider not assignable: \${eligibility.reason}\`);
  }`;

content = content.replace(target, replacement);

fs.writeFileSync('src/modules/operations/services/assignmentBatches.service.js', content);
