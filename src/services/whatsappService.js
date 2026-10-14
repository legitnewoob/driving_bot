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

            const logged = message.text?.body
                || message.interactive?.body?.text
                || (message.template ? `[template: ${message.template.name}]` : "");
            const chatLogger = getChatLogger(to);
            const dbChatLogger = getDbChatLogger(phoneNumberId, to);
            chatLogger.info(`${logged}`);
            dbChatLogger.assistant(`${logged}`);

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

    /**
     * Up to 3 tappable reply buttons under a message.
     * @param {{id: string, title: string}[]} buttons - titles are cut to 20 chars
     */
    async sendButtons(to, text, buttons, instructor) {
        const message = {
            messaging_product: "whatsapp",
            to,
            type: "interactive",
            interactive: {
                type: "button",
                body: { text },
                action: {
                    buttons: buttons.slice(0, 3).map((b) => ({
                        type: "reply",
                        reply: { id: b.id, title: b.title.slice(0, 20) },
                    })),
                },
            },
        };
        return await this.sendMessage(to, message, instructor);
    }

    /**
     * A list message: one button that opens up to 10 tappable rows.
     * @param {{id: string, title: string, description?: string}[]} rows
     */
    async sendList(to, text, buttonLabel, rows, instructor) {
        const message = {
            messaging_product: "whatsapp",
            to,
            type: "interactive",
            interactive: {
                type: "list",
                body: { text },
                action: {
                    button: buttonLabel.slice(0, 20),
                    sections: [{
                        title: "Options",
                        rows: rows.slice(0, 10).map((r) => ({
                            id: r.id,
                            title: r.title.slice(0, 24),
                            ...(r.description ? { description: r.description.slice(0, 72) } : {}),
                        })),
                    }],
                },
            },
        };
        return await this.sendMessage(to, message, instructor);
    }

    /**
     * A pre-approved template message (needed outside the 24h customer-service window).
     * @param {string[]} bodyParams - values for {{1}}, {{2}}, ... in the template body
     * @param {string[]} buttonPayloads - payloads for the template's quick-reply buttons, in order
     */
    async sendTemplate(to, templateName, languageCode, bodyParams, buttonPayloads, instructor) {
        const components = [];
        if (bodyParams.length) {
            components.push({
                type: "body",
                parameters: bodyParams.map((text) => ({ type: "text", text: String(text) })),
            });
        }
        buttonPayloads.forEach((payload, index) => {
            components.push({
                type: "button",
                sub_type: "quick_reply",
                index: String(index),
                parameters: [{ type: "payload", payload }],
            });
        });
        const message = {
            messaging_product: "whatsapp",
            to,
            type: "template",
            template: { name: templateName, language: { code: languageCode }, components },
        };
        return await this.sendMessage(to, message, instructor);
    }

    /**
     * Marks an incoming message as read and shows "typing…" until we reply
     * (or ~25 seconds pass). Failures are logged and ignored.
     */
    async markReadAndTyping(messageId, instructor) {
        try {
            await axios.post(
                `https://graph.facebook.com/v22.0/${instructor.phoneNumberId}/messages`,
                {
                    messaging_product: "whatsapp",
                    status: "read",
                    message_id: messageId,
                    typing_indicator: { type: "text" },
                },
                { headers: { Authorization: `Bearer ${instructor.whatsappToken}`, "Content-Type": "application/json" } }
            );
        } catch (error) {
            logger.warn(`WhatsApp read/typing failed: ${error.message}`);
        }
    }
}

module.exports = new WhatsAppService();