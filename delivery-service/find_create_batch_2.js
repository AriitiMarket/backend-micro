const fs = require('fs');
const content = fs.readFileSync('src/modules/operations/services/assignmentBatches.service.js', 'utf8');
const lines = content.split('\n');
const start = lines.findIndex(l => l.includes('const batch = await batchesRepo.create({'));
console.log(lines.slice(start, start + 30).join('\n'));
