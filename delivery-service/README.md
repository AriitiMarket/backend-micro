# Delivery Service

Order fulfillment, logistics coordination, and real-time tracking for Aritii Marketplace.

## Overview

The Delivery Service manages the complete delivery lifecycle: order assignment, partner coordination, real-time tracking, address validation, and settlement processing. It connects sellers with delivery partners and provides customers with live tracking.

## Key Features

### Order Management
- Automatic delivery order creation from commerce orders
- Pickup and delivery scheduling
- Status tracking through entire delivery lifecycle
- Cancellation and rescheduling
- Special instructions support

### Delivery Partner Network
- Partner registration and KYC verification
- Vehicle capacity management
- Availability scheduling
- Performance tracking
- Rating and review system
- Earnings management and settlements

### Assignment Engine
- Intelligent partner assignment based on:
  - Geographic proximity
  - Vehicle capacity
  - Current workload
  - Partner rating
  - Zone coverage
- Automatic re-assignment on failure
- Fallback mechanisms

### Address Services
- Address validation and standardization
- Geocoding (convert address to coordinates)
- Zone mapping (which delivery partners serve this area)
- Distance calculation
- Route optimization

### Real-Time Tracking
- Live GPS tracking
- WebSocket connections for real-time updates
- ETA calculation and updates
- Route visualization
- Driver contact information

## API Endpoints

### Delivery Management

```http
POST /api/deliveries
{
  "orderId": "order_123",
  "pickupAddressId": "addr_seller_1",
  "deliveryAddressId": "addr_buyer_1",
  "itemWeight": 2.5,
  "itemValue": 160100,
  "specialInstructions": "Leave at reception",
  "scheduledPickupTime": "2026-09-15T10:00:00Z"
}
Response: {
  "id": "deliv_456",
  "orderId": "order_123",
  "status": "pending_assignment",
  "createdAt": "2026-09-15T03:45:00Z"
}

GET /api/deliveries/:id
Response: {
  "id": "deliv_456",
  "orderId": "order_123",
  "status": "in_transit",
  "partner": {
    "id": "partner_1",
    "name": "Ahmed",
    "phone": "+251911234567",
    "vehicle": "Motorcycle",
    "rating": 4.8
  },
  "pickup": {
    "address": { ... },
    "scheduledTime": "2026-09-15T10:00:00Z",
    "actualTime": "2026-09-15T10:05:00Z"
  },
  "delivery": {
    "address": { ... },
    "estimatedArrival": "2026-09-15T16:30:00Z",
    "currentLocation": { "latitude": 9.0320, "longitude": 38.7469 }
  },
  "cost": 75,
  "createdAt": "2026-09-15T03:45:00Z"
}

GET /api/deliveries?status=in_transit&sort=recent
Response: {
  "deliveries": [ ... ],
  "total": 24,
  "filters": { "status", "sort" }
}

PATCH /api/deliveries/:id/status
{
  "status": "delivered",
  "deliveredAt": "2026-09-15T17:15:00Z",
  "notes": "Delivered to recipient",
  "photos": ["url1", "url2"],
  "signature": "url"
}
Response: { "delivery": { ... } }

POST /api/deliveries/:id/cancel
{
  "reason": "Customer request"
}
Response: { "message": "Delivery cancelled" }

POST /api/deliveries/:id/reschedule
{
  "pickupTime": "2026-09-16T10:00:00Z",
  "deliveryWindow": { "start": "14:00", "end": "18:00" }
}
Response: { "delivery": { ... } }
```

### Tracking

```http
GET /api/deliveries/:id/track
Response: {
  "deliveryId": "deliv_456",
  "status": "in_transit",
  "currentLocation": {
    "latitude": 9.0320,
    "longitude": 38.7469,
    "accuracy": 10,
    "timestamp": "2026-09-15T16:15:30Z"
  },
  "route": [
    { "lat": 9.0254, "lon": 38.7374, "timestamp": "16:00" },
    { "lat": 9.0300, "lon": 38.7400, "timestamp": "16:10" },
    { "lat": 9.0320, "lon": 38.7469, "timestamp": "16:15" }
  ],
  "estimatedArrival": "2026-09-15T16:30:00Z",
  "distanceRemaining": 2.5,
  "driver": {
    "name": "Ahmed",
    "phone": "+251911234567",
    "rating": 4.8
  }
}

WebSocket Connection: /ws/track/:deliveryId

Events:
- tracking_update: GPS location and ETA
- status_change: Delivery status change
- eta_update: ETA recalculation
- driver_contacted: Driver called customer
```

### Delivery Partner Management

```http
POST /api/partners/register
{
  "name": "Ahmed Hassan",
  "email": "ahmed@example.com",
  "phone": "+251911234567",
  "documentType": "national_id",
  "documentNumber": "ID123456",
  "vehicleType": "motorcycle",
  "vehicleCapacity": 30,
  "zone": "addis_central"
}
Response: {
  "id": "partner_1",
  "status": "pending_verification",
  "message": "Documents received, verification in progress"
}

GET /api/partners/:id
Response: {
  "id": "partner_1",
  "name": "Ahmed Hassan",
  "status": "active",
  "rating": 4.8,
  "totalDeliveries": 1250,
  "completionRate": 98.8,
  "earnings": {
    "thisMonth": 15000,
    "thisWeek": 3500,
    "pending": 1200
  },
  "vehicleInfo": { "type": "motorcycle", "capacity": 30 },
  "zone": "addis_central"
}

PATCH /api/partners/:id/availability
{
  "available": true,
  "maxDeliveries": 10,
  "workingHours": { "start": "08:00", "end": "18:00" }
}
Response: { "partner": { ... } }

POST /api/partners/:id/accept-delivery
{
  "deliveryId": "deliv_456"
}
Response: { "message": "Delivery accepted" }

POST /api/partners/:id/reject-delivery
{
  "deliveryId": "deliv_456",
  "reason": "Too far from current location"
}
Response: { "message": "Delivery rejected" }
```

### Address Services

```http
POST /api/addresses/validate
{
  "street": "Nifas Silk Lafto",
  "city": "Addis Ababa",
  "zipCode": "1234",
  "country": "Ethiopia"
}
Response: {
  "valid": true,
  "address": { "street", "city", "zipCode", "country" },
  "coordinates": { "latitude": 9.0254, "longitude": 38.7374 },
  "zone": "addis_central",
  "serviceable": true
}

POST /api/addresses/geocode
{
  "address": "Nifas Silk Lafto, Addis Ababa"
}
Response: {
  "latitude": 9.0254,
  "longitude": 38.7374,
  "accuracy": "street",
  "formattedAddress": "Nifas Silk Lafto, Addis Ababa, Ethiopia"
}

POST /api/addresses/zone
{
  "latitude": 9.0254,
  "longitude": 38.7374
}
Response: {
  "zoneId": "zone_addis_central",
  "zoneName": "Addis Ababa - Central",
  "baseCost": 50,
  "costPerKm": 5,
  "maxDeliveryTime": 120,
  "activePartners": 45
}

POST /api/addresses/distance
{
  "from": { "latitude": 9.0254, "longitude": 38.7374 },
  "to": { "latitude": 9.0320, "longitude": 38.7469 }
}
Response: {
  "distanceKm": 9.2,
  "durationMinutes": 20,
  "route": [...]
}
```

### Billing & Settlement

```http
GET /api/partners/:id/earnings
Response: {
  "partnerId": "partner_1",
  "earnings": {
    "thisMonth": {
      "total": 45000,
      "completed": 42000,
      "pending": 3000
    },
    "thisWeek": 10500,
    "today": 2100
  },
  "settlements": [
    {
      "id": "settle_789",
      "period": "September 2026",
      "amount": 95000,
      "status": "completed",
      "paidDate": "2026-09-01T12:00:00Z"
    }
  ]
}

POST /api/settlements/process
{
  "period": "September 2026"
}
Response: {
  "settlementId": "settle_789",
  "totalAmount": 95000,
  "partnersCount": 287,
  "status": "processing",
  "estimatedCompletion": "2026-10-01T00:00:00Z"
}

GET /api/sellers/:sellerId/delivery-payouts
Response: {
  "payouts": [
    {
      "period": "September 2026",
      "deliveryFees": 12450,
      "canceled": -500,
      "net": 11950,
      "status": "pending",
      "dueDate": "2026-10-05"
    }
  ],
  "totalEarnings": 45000
}
```

## Database Schema

### Deliveries Table
```sql
CREATE TABLE deliveries (
  id UUID PRIMARY KEY,
  order_id UUID REFERENCES orders(id),
  seller_id UUID REFERENCES users(id),
  buyer_id UUID REFERENCES users(id),
  partner_id UUID REFERENCES delivery_partners(id),
  
  pickup_address_id UUID,
  delivery_address_id UUID,
  
  status ENUM('pending_assignment', 'assigned', 'pickup_scheduled', 'picked_up', 
              'in_transit', 'out_for_delivery', 'delivered', 'failed', 'cancelled'),
  
  estimated_delivery TIMESTAMP,
  actual_delivery TIMESTAMP,
  delivery_cost DECIMAL(10, 2),
  
  special_instructions TEXT,
  signature_url TEXT,
  photo_urls TEXT[],
  
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  
  INDEX (order_id),
  INDEX (partner_id),
  INDEX (status),
  INDEX (created_at)
);
```

### Delivery Tracking Events
```sql
CREATE TABLE delivery_tracking_events (
  id UUID PRIMARY KEY,
  delivery_id UUID REFERENCES deliveries(id),
  status VARCHAR(50),
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  accuracy INT,
  speed INT,
  heading INT,
  notes TEXT,
  timestamp TIMESTAMP,
  
  INDEX (delivery_id),
  INDEX (timestamp)
);
```

### Delivery Partners
```sql
CREATE TABLE delivery_partners (
  id UUID PRIMARY KEY,
  name VARCHAR(255),
  email VARCHAR(255),
  phone VARCHAR(20),
  
  document_type VARCHAR(50),
  document_number VARCHAR(100),
  document_verified BOOLEAN,
  
  vehicle_type VARCHAR(50),
  vehicle_capacity INT,
  
  status ENUM('pending_verification', 'active', 'suspended', 'inactive'),
  rating DECIMAL(3, 2),
  
  total_deliveries INT,
  completed_deliveries INT,
  
  zone_id VARCHAR(100),
  
  current_load INT,
  max_daily_deliveries INT,
  
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  
  INDEX (status),
  INDEX (zone_id),
  INDEX (rating)
);
```

### Zones
```sql
CREATE TABLE delivery_zones (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(255),
  polygon GEOMETRY,
  
  base_cost DECIMAL(10, 2),
  cost_per_km DECIMAL(10, 2),
  max_delivery_minutes INT,
  
  active_partners INT,
  
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  
  INDEX (name)
);
```

## Assignment Algorithm

```javascript
async function assignDelivery(delivery) {
  // 1. GET ZONE
  const zone = await getZone(delivery.deliveryAddress);
  if (!zone.serviceable) {
    throw new Error('Area not serviceable');
  }
  
  // 2. FIND CANDIDATES
  const candidates = await findPartners({
    zone: zone.id,
    maxDistance: 10, // km
    status: 'active',
    available: true,
    capacity: { gte: delivery.itemWeight }
  });
  
  if (candidates.length === 0) {
    throw new Error('No available partners');
  }
  
  // 3. SCORE CANDIDATES
  const scored = candidates.map(partner => {
    const distance = getDistance(
      partner.currentLocation,
      delivery.pickupAddress
    );
    
    const distanceScore = 100 - (distance / 10) * 100;
    const ratingScore = partner.rating * 20;
    const availabilityScore = (partner.remainingCapacity / partner.maxCapacity) * 50;
    
    const totalScore = (distanceScore * 0.4) + 
                       (ratingScore * 0.4) + 
                       (availabilityScore * 0.2);
    
    return { partner, score: totalScore };
  });
  
  // 4. SELECT BEST
  const selected = scored.sort((a, b) => b.score - a.score)[0];
  
  // 5. RESERVE
  await reserveCapacity(selected.partner.id, delivery.itemWeight);
  
  // 6. ASSIGN
  return await createAssignment(delivery, selected.partner);
}
```

## Real-Time Tracking Architecture

```
Driver App (Mobile)
    ↓ GPS Location (every 30s)
    ↓
WebSocket Server
    ├─ Validate location
    ├─ Store in Redis (live)
    ├─ Store in DB (history)
    └─ Broadcast to subscribers
    ↓
Connected Clients
├─ Buyer tracking page
├─ Seller shop dashboard
└─ Admin dispatch center
```

### WebSocket Events

```javascript
// Server sends
socket.emit('tracking_update', {
  deliveryId: 'deliv_456',
  location: { lat: 9.0320, lon: 38.7469 },
  eta: '2026-09-15T16:30:00Z',
  status: 'in_transit',
  distance_remaining_km: 2.5
});

socket.emit('status_change', {
  deliveryId: 'deliv_456',
  from: 'in_transit',
  to: 'out_for_delivery',
  timestamp: '2026-09-15T16:30:00Z'
});

// Client sends
socket.emit('subscribe_delivery', { deliveryId: 'deliv_456' });
socket.emit('unsubscribe_delivery', { deliveryId: 'deliv_456' });
```

## Delivery Lifecycle

```
1. ORDER PAID
   ↓
2. DELIVERY ORDER CREATED (status: pending_assignment)
   ↓
3. ASSIGNMENT ENGINE RUNS
   ↓
4. PARTNER ASSIGNED (status: assigned)
   ↓
5. PICKUP SCHEDULED
   → Driver confirms pickup time
   ↓
6. PICKED UP (status: picked_up)
   → Driver scans barcode
   → Photos captured
   ↓
7. IN TRANSIT (status: in_transit)
   → GPS tracking starts
   → ETA calculated
   ↓
8. OUT FOR DELIVERY (status: out_for_delivery)
   → Driver near delivery address
   ↓
9. DELIVERED (status: delivered)
   → Signature/photo captured
   → Timestamp recorded
   ↓
10. SETTLEMENT
    → Calculate driver earnings
    → Process payment
    → Close delivery
```

## Cost Calculation

```javascript
function calculateDeliveryCost(delivery, zone) {
  const distanceKm = getDistance(
    delivery.pickupAddress,
    delivery.deliveryAddress
  );
  
  const cost = zone.baseCost + (distanceKm * zone.costPerKm);
  
  // Surcharges
  let finalCost = cost;
  
  if (delivery.itemWeight > 10) {
    finalCost += 10; // Heavy item surcharge
  }
  
  if (delivery.itemValue > 50000) {
    finalCost += (delivery.itemValue * 0.01); // High value surcharge
  }
  
  if (isRushDelivery(delivery.scheduledPickupTime)) {
    finalCost *= 1.5; // Rush delivery multiplier
  }
  
  return finalCost;
}
```

## Error Handling & Fallbacks

### Assignment Failures
```
1. Primary assignment fails
   → Retry with expanded radius
   
2. No partners available
   → Queue for next available partner
   → Notify seller (extended timeline)
   
3. Partner cancels
   → Re-assign to next best
   → Update ETA
   → Notify buyer
   
4. No solution found
   → Offer refund or reschedule
   → Escalate to support
```

### Tracking Issues
```
1. GPS signal lost
   → Show last known location
   → Attempt reconnection
   
2. WebSocket disconnected
   → Reconnect with backoff
   → Fetch latest status on reconnect
   
3. Location stale (> 5 min)
   → Request manual update from driver
   → Show warning to customer
```

## Monitoring & Analytics

### Key Metrics
- Average assignment time
- On-time delivery rate
- Delivery success rate
- Partner utilization rate
- Customer satisfaction (NPS)
- ETA accuracy
- Cost per delivery
- Revenue per partner

### Alerts
- Delivery failed to assign
- ETA exceeded by > 30 min
- Partner offline for > 10 min
- Unusual cost calculation
- High cancellation rate

## Development

### Setup
```bash
npm install
npm run seed:zones
npm run seed:test-partners
npm run dev
```

### Testing
```bash
npm test
npm run test:assignment-engine
npm run test:tracking
npm run test:e2e-delivery-flow
```

### Environment Variables
```
POSTGRESQL_URL=postgres://localhost/aritii_delivery
MONGODB_URI=mongodb://localhost/aritii_delivery_history
REDIS_URL=redis://localhost:6379
JWT_SECRET=your_secret_key
MAPS_API_KEY=your_maps_api_key
COMMERCE_SERVICE_URL=http://commerce-service:3002
IDENTITY_SERVICE_URL=http://identity-service:3001
```

## Future Enhancements

- AI-powered route optimization
- Multi-stop deliveries
- Scheduled deliveries (future dates)
- Crowd-sourced delivery network
- Drone delivery integration
- Proof of delivery (advanced)
- Returns/reverse logistics
- Premium delivery options (early morning, evening)
