const { server } = require('./app');
const env = require('./config/env');

server.listen(env.port, () => {
  console.log(`[gateway] API Gateway listening on http://localhost:${env.port}`);
  console.log(`[gateway] Identity  -> ${env.identityServiceUrl}`);
  console.log(`[gateway] Commerce  -> ${env.commerceServiceUrl}`);
});
