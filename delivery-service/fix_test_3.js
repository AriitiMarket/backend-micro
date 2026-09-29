const fs = require('fs');
let content = fs.readFileSync('src/modules/operations/__tests__/shipments.test.js', 'utf8');

const target = `test('Shipment: invalid transitions', async () => {
  reset();
  store.shipments.push({ _id: oid(), status: 'planning', history: [] });
  console.log("STORE:", store.shipments);
  
  await assert.rejects(
    () => shipmentsService.transitionShipmentStatus(oid(), 'received', actor),
    /Invalid shipment status transition/
  );
});`;

const replacement = `test('Shipment: invalid transitions', async () => {
  reset();
  const sId = oid();
  store.shipments.push({ _id: sId, status: 'planning', history: [] });
  await assert.rejects(
    () => shipmentsService.transitionShipmentStatus(sId, 'received', actor),
    /Invalid shipment status transition/
  );
});`;

content = content.replace(target, replacement);
fs.writeFileSync('src/modules/operations/__tests__/shipments.test.js', content);
