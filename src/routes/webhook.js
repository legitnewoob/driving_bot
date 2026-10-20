const express = require('express');
const webhookController = require('../controllers/webhookController');
const verifyMetaSignature = require('../middleware/verifyMetaSignature');

const router = express.Router();


router.get('/', webhookController.verifyWebhook.bind(webhookController));
// Only messages signed by Meta reach Donna
router.post('/', verifyMetaSignature, webhookController.handleWebhook.bind(webhookController));

module.exports = router;
