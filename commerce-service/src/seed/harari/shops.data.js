const HARAR_SHOP_DATA = [
  // Food & Grocery - Sector 1
  {
    name: 'Harar Fresh Market',
    email: 'harfresh@aritii.et',
    ownerId: 'seller_001',
    description: 'Fresh vegetables, spices, and local Ethiopian food',
    address: 'Sheikh Hussein St, Harar',
    phoneNumber: 251911123456,
    zipCode: 1000,
    avatar: {
      public_id: 'harar/fresh_market',
      url: 'https://via.placeholder.com/150?text=Fresh+Market',
    },
    status: 'ACTIVE',
    availableBalance: 15000,
  },
  {
    name: 'Sheikh Market Center',
    email: 'sheikh.market@aritii.et',
    ownerId: 'seller_002',
    description: 'Wholesale and retail food supplies',
    address: 'Central Market, Harar',
    phoneNumber: 251911223456,
    zipCode: 1001,
    avatar: {
      public_id: 'harar/sheikh_market',
      url: 'https://via.placeholder.com/150?text=Sheikh+Market',
    },
    status: 'ACTIVE',
    availableBalance: 22000,
  },

  // Pharmacy - Sector 2
  {
    name: 'Harar Medical Pharmacy',
    email: 'harar.pharmacy@aritii.et',
    ownerId: 'seller_003',
    description: 'Licensed pharmacy with prescription services',
    address: 'Erer District, Harar',
    phoneNumber: 251911323456,
    zipCode: 1002,
    avatar: {
      public_id: 'harar/medical_pharmacy',
      url: 'https://via.placeholder.com/150?text=Medical+Pharmacy',
    },
    status: 'ACTIVE',
    availableBalance: 18000,
  },
  {
    name: 'Erer Health Supplies',
    email: 'erer.health@aritii.et',
    ownerId: 'seller_004',
    description: 'Health supplements and medical equipment',
    address: 'Erer Health Center Area, Harar',
    phoneNumber: 251911423456,
    zipCode: 1003,
    avatar: {
      public_id: 'harar/health_supplies',
      url: 'https://via.placeholder.com/150?text=Health+Supplies',
    },
    status: 'ACTIVE',
    availableBalance: 12000,
  },

  // Fashion & Clothing - Sector 3
  {
    name: 'Harar Fashion Hub',
    email: 'fashion.hub@aritii.et',
    ownerId: 'seller_005',
    description: 'Modern and traditional Ethiopian clothing',
    address: 'Falls Market, Harar',
    phoneNumber: 251911523456,
    zipCode: 1004,
    avatar: {
      public_id: 'harar/fashion_hub',
      url: 'https://via.placeholder.com/150?text=Fashion+Hub',
    },
    status: 'ACTIVE',
    availableBalance: 25000,
  },
  {
    name: 'Traditional Cloth Traders',
    email: 'cloth.traders@aritii.et',
    ownerId: 'seller_006',
    description: 'Authentic Ethiopian fabrics and garments',
    address: 'Traditional Market, Falls, Harar',
    phoneNumber: 251911623456,
    zipCode: 1005,
    avatar: {
      public_id: 'harar/cloth_traders',
      url: 'https://via.placeholder.com/150?text=Cloth+Traders',
    },
    status: 'ACTIVE',
    availableBalance: 19000,
  },

  // Electronics - Sector 4
  {
    name: 'Sami Tech Store',
    email: 'sami.tech@aritii.et',
    ownerId: 'seller_007',
    description: 'Electronics, phones, and computer accessories',
    address: 'Sami Downtown, Harar',
    phoneNumber: 251911723456,
    zipCode: 1006,
    avatar: {
      public_id: 'harar/sami_tech',
      url: 'https://via.placeholder.com/150?text=Sami+Tech',
    },
    status: 'ACTIVE',
    availableBalance: 30000,
  },
  {
    name: 'Digital Solutions Harar',
    email: 'digital.solutions@aritii.et',
    ownerId: 'seller_008',
    description: 'Computing devices and IT equipment',
    address: 'Tech Plaza, Sami, Harar',
    phoneNumber: 251911823456,
    zipCode: 1007,
    avatar: {
      public_id: 'harar/digital_solutions',
      url: 'https://via.placeholder.com/150?text=Digital+Solutions',
    },
    status: 'ACTIVE',
    availableBalance: 28000,
  },
];

const seedShops = HARAR_SHOP_DATA;

module.exports = { seedShops };
