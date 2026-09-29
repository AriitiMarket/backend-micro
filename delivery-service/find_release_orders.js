const fs = require('fs');
const content = fs.readFileSync('src/modules/operations/services/assignmentBatches.service.js', 'utf8');
const lines = content.split('\n');
const idx = lines.findIndex(l => l.includes('async function releaseOrders('));
console.log(lines.slice(idx, idx + 10).join('\n'));
