const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Aritii Market API Gateway',
      version: '1.0.0',
      description: 'Multi-vendor e-commerce marketplace API - single public entry point. Auth: OAuth 2.1 authorization code + PKCE (S256) with short-lived RS256 access tokens; no cookies.',
      contact: {
        name: 'Aritii Market Team',
      },
    },
    servers: [
      {
        url: 'http://localhost:8000',
        description: 'Development server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT (RS256)',
          description: 'Short-lived RS256 access token issued by the Identity Service via the OAuth 2.1 authorization-code + PKCE flow. No cookies are used anywhere.',
        },
      },
      schemas: {
        User: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            email: { type: 'string', format: 'email' },
            role: { type: 'string', enum: ['BUYER', 'SELLER', 'PROVIDER', 'AGENT', 'ADMIN'] },
            avatar_url: { type: 'string' },
            phone_number: { type: 'string' },
            addresses: { type: 'array', items: { type: 'object' } },
          },
        },
        Shop: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            name: { type: 'string' },
            email: { type: 'string' },
            ownerId: { type: 'string' },
            address: { type: 'string' },
            phoneNumber: { type: 'string' },
            avatar: { type: 'object' },
            ratings: { type: 'number' },
          },
        },
        Product: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            category: { type: 'string' },
            originalPrice: { type: 'number' },
            discountPrice: { type: 'number' },
            stock: { type: 'integer' },
            images: { type: 'array', items: { type: 'object' } },
            shopId: { type: 'string' },
            ratings: { type: 'number' },
          },
        },
        Order: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            cart: { type: 'array' },
            shippingAddress: { type: 'object' },
            totalPrice: { type: 'number' },
            status: { type: 'string', enum: ['Pending', 'Processing', 'Shipped', 'Delivered', 'Refund'] },
            paymentInfo: { type: 'object' },
          },
        },
        Error: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            message: { type: 'string' },
            errors: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
  apis: ['./src/swagger/*.js'],
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = swaggerSpec;
