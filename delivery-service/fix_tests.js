const fs = require('fs');
let content = fs.readFileSync('src/modules/operations/__tests__/shipments.test.js', 'utf8');

// Fix invalid transitions
content = content.replace(/store\.shipments\.push\(\{ _id: oid\(\), status: 'planning', history: \[\] \}\);\n\s+await assert\.rejects\(\n\s+\(\) => shipmentsService\.transitionShipmentStatus\(oid\(\), 'received', actor\)/, 
`const sId = oid();
  store.shipments.push({ _id: sId, status: 'planning', history: [] });
  await assert.rejects(
    () => shipmentsService.transitionShipmentStatus(sId, 'received', actor)`);

// Fix deconsolidation
content = content.replace(/store\.shipments\.push\(\{ _id: oid\(\), status: 'receiving', items: \[\{ deliveryId: 'd1' \}\], history: \[\] \}\);\n\n\s+await shipmentsService\.transitionShipmentStatus\(oid\(\), 'received', actor\);/,
`const sId = oid();
  store.shipments.push({ _id: sId, status: 'receiving', items: [{ deliveryId: 'd1' }], history: [] });
  await shipmentsService.transitionShipmentStatus(sId, 'received', actor);`);

// Fix hub arrival
content = content.replace(/store\.shipments\.push\(\{ _id: oid\(\), status: 'in_transit', items: \[\{ deliveryId: 'd1' \}\], history: \[\] \}\);\n\n\s+const s = await shipmentsService\.transitionShipmentStatus\(oid\(\), 'arrived', actor\);/,
`const sId = oid();
  store.shipments.push({ _id: sId, status: 'in_transit', items: [{ deliveryId: 'd1' }], history: [] });
  const s = await shipmentsService.transitionShipmentStatus(sId, 'arrived', actor);`);

fs.writeFileSync('src/modules/operations/__tests__/shipments.test.js', content);
