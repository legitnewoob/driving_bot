const axios = require('axios');

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WHATSAPP_API_URL = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;

class WhatsAppService {
    async sendMessage(to, message) {
        try {
            const response = await axios.post(WHATSAPP_API_URL, message, {
                headers: {
                    'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            });
            return response.data;
        } catch (error) {
            console.error('Error sending WhatsApp message:', error.response?.data || error.message);
            throw error;
        }
    }

    async sendTextMessage(to, text) {
        const message = {
            messaging_product: "whatsapp",
            to: to,
            type: "text",
            text: { body: text }
        };
        return await this.sendMessage(to, message);
    }
}

module.exports = new WhatsAppService();