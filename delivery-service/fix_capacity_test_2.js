const fs = require('fs');
let content = fs.readFileSync('src/modules/operations/__tests__/assignmentBatches.test.js', 'utf8');

const target = `/maximum of 1 active assignments/,`;
const replacement = `/maximum assignment limit reached/,`;

content = content.replace(target, replacement);
fs.writeFileSync('src/modules/operations/__tests__/assignmentBatches.test.js', content);
