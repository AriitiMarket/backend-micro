// Agent management routes.
const express = require('express');
const router = express.Router();
const agentsController = require('../controllers/agents.controller');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const {
  validateCreateAgent,
  validateVerifyAgent,
  validateCommissionRate,
} = require('../validators/agents.validators');

// Admin / seller-self agent record management.
router.post('/agent/create-agent', authenticate, validateCreateAgent, agentsController.createAgent);
router.get('/agent/me', authenticate, agentsController.getMyAgent);
router.get('/agent/user/:userId', authenticate, authorize(['ADMIN', 'AGENT', 'SELLER']), agentsController.getAgentByUser);
router.get('/agent/:id', authenticate, agentsController.getAgent);

// Admin-only operations.
router.get('/agent', authenticate, authorize(['ADMIN']), agentsController.listAgents);
router.put('/agent/verify/:id', authenticate, authorize(['ADMIN']), validateVerifyAgent, agentsController.verifyAgent);
router.put('/agent/:id', authenticate, authorize(['ADMIN']), agentsController.updateAgent);
router.put('/agent/commission/:id', authenticate, authorize(['ADMIN']), validateCommissionRate, agentsController.setCommissionRate);

module.exports = router;