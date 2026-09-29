const fs = require('fs');
const content = fs.readFileSync('src/modules/operations/services/assignmentBatches.service.js', 'utf8');
const lines = content.split('\n');
const idx = lines.findIndex(l => l.includes('async function markDelivered('));
console.log(lines.slice(idx, idx + 25).join('\n'));
