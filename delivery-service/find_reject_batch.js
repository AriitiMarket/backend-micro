const fs = require('fs');
const content = fs.readFileSync('src/modules/operations/services/assignmentBatches.service.js', 'utf8');
const lines = content.split('\n');
const rejectIdx = lines.findIndex(l => l.includes('async function rejectBatch('));
console.log('REJECT:', lines.slice(rejectIdx, rejectIdx + 20).join('\n'));
const reassignIdx = lines.findIndex(l => l.includes('async function reassignBatch('));
console.log('REASSIGN:', lines.slice(reassignIdx, reassignIdx + 20).join('\n'));
