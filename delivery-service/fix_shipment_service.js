const fs = require('fs');
let content = fs.readFileSync('src/modules/operations/services/shipments.service.js', 'utf8');

content = content.replace(/const Shipment = require\('\.\.\/models\/Shipment'\);\n/, '');
content = content.replace(/const updated = await Shipment\.findByIdAndUpdate\(shipmentId, \{\n\s+\$set: \{ status: newStatus \},\n\s+\$push: \{ history: historyEntry \}\n\s+\}, \{ new: true \}\);/,
`const updated = await shipmentsRepo.updateFields(shipmentId, { status: newStatus });
  await shipmentsRepo.pushHistory(shipmentId, historyEntry);`);

fs.writeFileSync('src/modules/operations/services/shipments.service.js', content);
