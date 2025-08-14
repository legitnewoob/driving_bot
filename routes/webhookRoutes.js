const express = require('express');
const router = express.Router();
const { handleIncomingMessage } = require('../controllers/bookingController');
const { VERIFY_TOKEN } = require('../config');

router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified successfully!');
    res.status(200).send(challenge);
  } else {
    res.status(403).send('Forbidden');
  }
});

router.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    if (body.object === 'whatsapp_business_account') {
      body.entry?.forEach(entry => {
        entry.changes?.forEach(change => {
          change.value.messages?.forEach(async message => {
            let messageContent = '';
            if (message.type === 'text') {
              messageContent = message.text.body;
            } else if (message.type === 'interactive') {
              if (message.interactive.type === 'button_reply') {
                messageContent = message.interactive.button_reply.id;
              } else if (message.interactive.type === 'list_reply') {
                messageContent = message.interactive.list_reply.id;
              }
            }
            await handleIncomingMessage(message.from, messageContent, message.type);
          });
        });
      });
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Internal Server Error');
  }
});

module.exports = router;