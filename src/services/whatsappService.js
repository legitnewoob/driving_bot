const axios = require('axios');
const getChatLogger = require("../utils/chatLogger");
const getDbChatLogger = require("../utils/dbChatLogger");
const logger = require('../utils/logger-advanced');

class WhatsAppService {
    /**
     * Send a message via WhatsApp Cloud API.
     * @param {string} to - Recipient phone number
     * @param {Object} message - WhatsApp message payload
     * @param {Object} instructor - Instructor record from DB (must have phoneNumberId, whatsappToken)
     */
    async sendMessage(to, message, instructor) {
        try {
            const phoneNumberId = instructor.phoneNumberId;
            const token = instructor.whatsappToken;
            const apiUrl = `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`;

            const chatLogger = getChatLogger(to);
            const dbChatLogger = getDbChatLogger(phoneNumberId, to);
            chatLogger.info(`${message.text?.body}`);
            dbChatLogger.assistant(`${message.text?.body}`);

            const response = await axios.post(apiUrl, message, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json"
                }
            });

            return response.data;

        } catch (error) {
            logger.error(`WhatsApp send error: ${error.message}`);
            throw error;
        }
    }

    /**
     * Send a text message via WhatsApp.
     * @param {string} to - Recipient phone number
     * @param {string} text - Message body
     * @param {Object} instructor - Instructor record from DB
     */
    async sendTextMessage(to, text, instructor) {
        const message = {
            messaging_product: "whatsapp",
            to: to,
            type: "text",
            text: { body: text }
        };
        return await this.sendMessage(to, message, instructor);
    }
}

module.exports = new WhatsAppService();