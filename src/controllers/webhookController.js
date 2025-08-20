const whatsappService = require('../services/whatsappService');
const aiService = require('../services/aiService');
const bookingService = require('../services/bookingService');
const { getUserSession, updateUserSession, getInstructor } = require('../models/instructorModel');

class WebhookController {
    async verifyWebhook(req, res) {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];
        
        if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
            console.log('Webhook verified successfully!');
            res.status(200).send(challenge);
        } else {
            res.status(403).send('Forbidden');
        }
    }

    async handleWebhook(req, res) {
        try {
            const body = req.body;
            
            if (body.object === 'whatsapp_business_account') {
                // Process each entry
                for (const entry of body.entry || []) {
                    for (const change of entry.changes || []) {
                        if (change.field === 'messages') {
                            for (const message of change.value.messages || []) {
                                const from = message.from;
                                const messageType = message.type;
                                
                                let messageContent = '';
                                if (messageType === 'text') {
                                    messageContent = message.text.body;
                                } else if (messageType === 'interactive') {
                                    if (message.interactive.type === 'button_reply') {
                                        messageContent = message.interactive.button_reply.title;
                                    } else if (message.interactive.type === 'list_reply') {
                                        messageContent = message.interactive.list_reply.title;
                                    }
                                }
                                
                                if (messageContent) {
                                    console.log(from, messageContent);
                                    // Call instance method correctly
                                    console.log(this);
                                    await this.handleIncomingMessage(from, messageContent);
                                }
                            }
                        }
                    }
                }
            }
            
            res.status(200).send('OK');
        } catch (error) {
            console.error('Webhook error:', error);
            res.status(500).send('Internal Server Error');
        }
    }

    async handleIncomingMessage(from, messageContent) {
        try {
            console.log(`📱 Incoming message from ${from}: "${messageContent}"`);
            
            const session = getUserSession(from);
            
            // Fixed typo: messageContent instead of mestsageContent
            const aiResponse = await aiService.getResponse(messageContent, session.conversationHistory, from);
            console.log("aiResponse" , aiResponse);
            const { hasBookingAction, bookingData, responseText } = aiService.extractActions(aiResponse);
            console.log(hasBookingAction , bookingData , responseText);
            if (responseText) {
                await whatsappService.sendTextMessage(from, responseText);
            }
            
            if (hasBookingAction) {
                bookingData.userPhone = from;
                await this.processBooking(from, bookingData);
            }
            
            // Update conversation history
            session.conversationHistory.push(
                { role: 'user', content: messageContent },
                { role: 'assistant', content: aiResponse }
            );
            
            if (session.conversationHistory.length > 20) {
                session.conversationHistory = session.conversationHistory.slice(-20);
            }
            
            updateUserSession(from, session);
            
        } catch (error) {
            console.error('❌ Error handling message:', error.message);
            await whatsappService.sendTextMessage(from, "Sorry, I'm having trouble processing your message right now. Please try again in a moment.");
        }
    }

    async processBooking(from, bookingData) {
        try {
            const booking = await bookingService.createBooking(bookingData);
            
            const confirmationMessage = [
                "🎉 Booking Confirmed!",
                "",
                "✅ Your driving lesson has been successfully booked:",
                "",
                `👨‍🏫 Instructor: ${booking.instructor.name}`,
                `📅 Date: ${new Date(bookingData.date).toLocaleDateString('en-US', { 
                    weekday: 'long', 
                    year: 'numeric', 
                    month: 'long', 
                    day: 'numeric' 
                })}`,
                `🕐 Time: ${bookingData.time}`,
                `🚗 Lesson Type: ${bookingData.lessonType.charAt(0).toUpperCase() + bookingData.lessonType.slice(1)} driving`,
                `💰 Price: ${booking.lessonPrice}`,
                "",
                "📧 A calendar invitation has been sent to your instructor.",
                // "📞 You'll receive a confirmation call 24 hours before your lesson.",
                "",
                "Good luck with your driving lesson! 🚗💨"
            ].join('\n');
            
            await whatsappService.sendTextMessage(from, confirmationMessage);
            
        } catch (error) {
            console.error('❌ Booking error:', error.message);
            const errorMessage = error.message.includes('validation') 
                ? `❌ ${error.message}` 
                : "❌ Sorry, there was an error processing your booking. Please try again.";
            
            await whatsappService.sendTextMessage(from, errorMessage);
        }
    }
}

module.exports = new WebhookController();