const fs = require('fs');
let content = fs.readFileSync('src/modules/operations/services/assignments.service.js', 'utf8');

const target = `  if (new Date() > assignment.expiresAt) {
    await assignmentsRepo.updateFields(id, { status: 'expired' });
    throw Object.assign(new Error('Assignment has expired'), { status: 410 });
  }`;

const replacement = `  if (new Date() > assignment.expiresAt) {
    await assignmentsRepo.updateFields(id, { status: 'expired' });
    await partnersService.decrementWorkload(partnerId, id, null);
    throw Object.assign(new Error('Assignment has expired'), { status: 410 });
  }`;

content = content.replace(target, replacement);
fs.writeFileSync('src/modules/operations/services/assignments.service.js', content);
