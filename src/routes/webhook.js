const express = require('express');
const webhookController = require('../controllers/webhookController');

const router = express.Router();


router.get('/', webhookController.verifyWebhook.bind(webhookController));
router.post('/', webhookController.handleWebhook.bind(webhookController));

module.exports = router;