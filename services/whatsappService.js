const axios = require('axios');
const { WHATSAPP_API_URL, WHATSAPP_TOKEN } = require('../config');

async function sendWhatsAppMessage(to, message) {
  try {
    const response = await axios.post(WHATSAPP_API_URL, message, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    return response.data;
  } catch (error) {
    console.error('Error sending WhatsApp message:', error.response?.data || error.message);
    throw error;
  }
}

async function sendTextMessage(to, text) {
  return await sendWhatsAppMessage(to, {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text }
  });
}

async function sendButtonMessage(to, text, buttons) {
  return await sendWhatsAppMessage(to, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: { type: "button", body: { text }, action: { buttons } }
  });
}

async function sendListMessage(to, text, buttonText, sections) {
  return await sendWhatsAppMessage(to, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: { type: "list", body: { text }, action: { button: buttonText, sections } }
  });
}

module.exports = { sendTextMessage, sendButtonMessage, sendListMessage };