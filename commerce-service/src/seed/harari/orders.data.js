const generateOrders = () => {
  const customers = [
    { id: 'customer_001', name: 'Amina Hassan', email: 'amina@example.et' },
    { id: 'customer_002', name: 'Mohamed Ali', email: 'mohamed@example.et' },
    { id: 'customer_003', name: 'Fatima Ibrahim', email: 'fatima@example.et' },
    { id: 'customer_004', name: 'Hassan Ahmed', email: 'hassan@example.et' },
    { id: 'customer_005', name: 'Leila Yusuf', email: 'leila@example.et' },
  ];

  const carts = [
    // Sector 1 - Food orders
    {
      items: [
        { name: 'Tomatoes 1kg', price: 250, qty: 2 },
        { name: 'Onions 1kg', price: 180, qty: 1 },
      ],
      total: 680,
    },
    {
      items: [
        { name: 'Ethiopian Spice Mix', price: 320, qty: 1 },
        { name: 'Fresh Ginger', price: 150, qty: 1 },
      ],
      total: 470,
    },
    // Sector 2 - Pharmacy orders
    {
      items: [
        { name: 'Paracetamol 500mg', price: 45, qty: 2 },
        { name: 'Vitamin C', price: 120, qty: 1 },
      ],
      total: 210,
    },
    {
      items: [
        { name: 'First Aid Kit', price: 450, qty: 1 },
      ],
      total: 450,
    },
    // Sector 3 - Fashion orders
    {
      items: [
        { name: 'Traditional Harar Dress', price: 1200, qty: 1 },
        { name: 'Shawl', price: 350, qty: 1 },
      ],
      total: 1550,
    },
    {
      items: [
        { name: 'Men\'s Cotton Shirt', price: 650, qty: 2 },
      ],
      total: 1300,
    },
    // Sector 4 - Electronics orders
    {
      items: [
        { name: 'Phone Charger', price: 280, qty: 1 },
        { name: 'USB Cable', price: 95, qty: 2 },
      ],
      total: 470,
    },
    {
      items: [
        { name: 'Power Bank 10000mAh', price: 850, qty: 1 },
      ],
      total: 850,
    },
  ];

  // Customer destinations with full location hierarchy
  const destinations = [
    {
      regionName: 'Hararghe', cityName: 'Harar', areaName: 'Sheikh Hussein',
      fullAddress: 'Near the Old Walled City, Harar',
      landmark: 'Behind Big Market', building: 'House #42',
      phone: '+251911111111', additionalInstructions: 'Ring the doorbell twice',
    },
    {
      regionName: 'Hararghe', cityName: 'Harar', areaName: 'Erer',
      fullAddress: 'Erer District Road 5',
      landmark: 'Next to Erer Hotel', building: 'Apartment 3B',
      phone: '+251922222222', additionalInstructions: '',
    },
    {
      regionName: 'Hararghe', cityName: 'Harar', areaName: 'Sheikh Hussein',
      fullAddress: 'Falls Market Area, Harar',
      landmark: 'Near Harar Falls', building: '',
      phone: '+251933333333', additionalInstructions: 'Leave at reception if not home',
    },
    {
      regionName: 'Dire Dawa', cityName: 'Dire Dawa City', areaName: 'Kezira',
      fullAddress: 'Kezira Sub-City, Dire Dawa',
      landmark: 'Opposite Dire Dawa Stadium', building: 'Block C, Unit 5',
      phone: '+251944444444', additionalInstructions: '',
    },
  ];

  const orders = [];
  const statuses = ['Processing', 'Confirmed', 'Shipped', 'Delivered'];
  const paymentStatuses = ['CONFIRMED', 'CONFIRMED', 'CONFIRMED', 'PENDING'];

  for (let i = 0; i < 20; i++) {
    const customer = customers[i % customers.length];
    const cart = carts[i % carts.length];
    const dest = destinations[i % destinations.length];
    const status = statuses[Math.floor(Math.random() * statuses.length)];

    orders.push({
      cart: cart.items,
      shippingAddress: {
        address: dest.fullAddress,
        city: dest.cityName,
        zipCode: 1000 + i,
      },
      user: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        phone: dest.phone,
      },
      buyerId: customer.id,
      totalPrice: cart.total,
      status,
      paymentStatus: paymentStatuses[Math.floor(Math.random() * paymentStatuses.length)],
      paymentInfo: {
        id: `pay_${Date.now()}_${i}`,
        status: 'completed',
        type: 'card',
      },
      destination: {
        regionName: dest.regionName,
        cityName: dest.cityName,
        areaName: dest.areaName,
        fullAddress: dest.fullAddress,
        landmark: dest.landmark,
        building: dest.building,
        phone: dest.phone,
        additionalInstructions: dest.additionalInstructions,
        coordinates: { latitude: null, longitude: null },
      },
      paidAt: new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000),
      createdAt: new Date(Date.now() - Math.random() * 14 * 24 * 60 * 60 * 1000),
    });
  }

  return orders;
};

const seedOrders = generateOrders();

module.exports = { seedOrders };
