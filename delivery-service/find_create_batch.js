const fs = require('fs');
const content = fs.readFileSync('src/modules/operations/services/assignmentBatches.service.js', 'utf8');
const lines = content.split('\n');
const start = lines.findIndex(l => l.includes('async function createBatch('));
console.log(lines.slice(start, start + 30).join('\n'));
