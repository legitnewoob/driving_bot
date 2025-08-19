require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const app = express();

app.use(express.json());

// Configuration
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_API_URL = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;



// Store user sessions (in production, use a database)
const userSessions = {};

// Instructor data (in production, store in database)
const instructors = {
    '691332914069950': {
        name: 'Raj Agrawal',
        googleCalendarId: 'agrawalraj918@gmail.com',
        availableTimes: ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00']
    }
};

// Google Calendar setup (you'll need to set up OAuth2 credentials)
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URL
);

// // Set credentials (you'll get this from OAuth2 flow)
// oauth2Client.setCredentials({
//     refresh_token: 'YOUR_REFRESH_TOKEN'
// });

app.get("/google-auth", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/calendar"],
    prompt: "consent"
  });
  res.redirect(url);
});

app.get("/oauth2callback", async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    oauth2Client.setCredentials(tokens);
    console.log("Tokens:", tokens);
    res.send("✅ Google Calendar linked! Save your refresh_token.");
  } catch (err) {
    console.error(err);
    res.status(500).send("Auth Error");
  }
});

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// Helper function to send WhatsApp messages
async function sendWhatsAppMessage(to, message) {
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

// Function to send text message
async function sendTextMessage(to, text) {
    const message = {
        messaging_product: "whatsapp",
        to: to,
        type: "text",
        text: { body: text }
    };
    return await sendWhatsAppMessage(to, message);
}

// Function to send interactive button message
async function sendButtonMessage(to, text, buttons) {
    const message = {
        messaging_product: "whatsapp",
        to: to,
        type: "interactive",
        interactive: {
            type: "button",
            body: { text: text },
            action: {
                buttons: buttons
            }
        }
    };
    return await sendWhatsAppMessage(to, message);
}

// Function to send list message
async function sendListMessage(to, text, buttonText, sections) {
    const message = {
        messaging_product: "whatsapp",
        to: to,
        type: "interactive",
        interactive: {
            type: "list",
            body: { text: text },
            action: {
                button: buttonText,
                sections: sections
            }
        }
    };
    return await sendWhatsAppMessage(to, message);
}

// Function to get available dates (next 7 days, excluding weekends)
function getAvailableDates() {
    const dates = [];
    const today = new Date();
    
    for (let i = 1; i <= 10; i++) {
        const date = new Date(today);
        date.setDate(today.getDate() + i);
        
        // Skip weekends
        if (date.getDay() !== 0 && date.getDay() !== 6) {
            dates.push({
                value: date.toISOString().split('T')[0],
                display: date.toLocaleDateString('en-US', { 
                    weekday: 'long', 
                    year: 'numeric', 
                    month: 'long', 
                    day: 'numeric' 
                })
            });
        }
        
        if (dates.length >= 7) break;
    }
    
    return dates;
}

// Function to create Google Calendar event
// async function createCalendarEvent(instructorId, date, time, userPhone) {
//     try {
//         const instructor = instructors[instructorId];
//         const startDateTime = new Date(`${date}T${time}:00`);
//         const endDateTime = new Date(startDateTime.getTime() + 60 * 60 * 1000); // 1 hour duration
        
//         const event = {
//             summary: `Driving Test - ${userPhone}`,
//             description: `Driving test booking for phone number: ${userPhone}`,
//             start: {
//                 dateTime: startDateTime.toISOString(),
//                 timeZone: 'America/New_York', // Change to your timezone
//             },
//             end: {
//                 dateTime: endDateTime.toISOString(),
//                 timeZone: 'America/New_York',
//             },
//             attendees: [
//                 { email: instructor.googleCalendarId }
//             ],
//         };
        
//         const response = await calendar.events.insert({
//             calendarId: instructor.googleCalendarId,
//             resource: event,
//         });
        
//         return response.data;
//     } catch (error) {
//         console.error('Error creating calendar event:', error);
//         throw error;
//     }
// }

async function createCalendarEvent(instructorId, date, time, userPhone) {
  try {
    // Set OAuth credentials using your refresh token
    oauth2Client.setCredentials({
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN
    });

    const instructor = instructors[instructorId];
    const startDateTime = new Date(`${date}T${time}:00`);
    const endDateTime = new Date(startDateTime.getTime() + 60 * 60 * 1000); // 1 hour duration

    const event = {
      summary: `Driving Test - ${userPhone}`,
      description: `Driving test booking for phone number: ${userPhone}`,
      start: {
        dateTime: startDateTime.toISOString(),
        timeZone: 'America/New_York', // change to your timezone
      },
      end: {
        dateTime: endDateTime.toISOString(),
        timeZone: 'America/New_York',
      },
      attendees: [
        { email: instructor.googleCalendarId }
      ],
    };

    const res = await calendar.events.insert({
      calendarId: instructor.googleCalendarId, // could be "primary" for own calendar
      auth: oauth2Client,
      resource: event,
    });

    console.log("Event created:", res.data.htmlLink);
    return res.data;

  } catch (error) {
    console.error("Error creating calendar event:", error);
    throw error;
  }
}


// Main message handler
async function handleIncomingMessage(from, message, messageType) {
    const session = userSessions[from] || { step: 'initial' };
    const instructorId = PHONE_NUMBER_ID; // In production, map phone number to instructor
    const instructor = instructors[instructorId];
    
    try {
        switch (session.step) {
            case 'initial':
                if (messageType === 'text' && (message.toLowerCase().includes('hi') || message.toLowerCase().includes('hello'))) {
                    await sendButtonMessage(from, 
                        `Hello! Welcome to ${instructor.name}'s Driving School 🚗\n\nAre you looking to book a driving test?`,
                        [
                            {
                                type: "reply",
                                reply: { id: "book_yes", title: "Yes, book test" }
                            },
                            {
                                type: "reply",
                                reply: { id: "book_no", title: "Just browsing" }
                            }
                        ]
                    );
                    session.step = 'confirm_booking';
                } else {
                    await sendTextMessage(from, 
                        `Hello! 👋 Welcome to ${instructor.name}'s Driving School.\n\nPlease type "Hi" or "Hello" to get started with booking your driving test.`
                    );
                }
                break;
                
            case 'confirm_booking':
                if (messageType === 'interactive' && message === 'book_yes') {
                    const availableDates = getAvailableDates();
                    const dateRows = availableDates.map(date => ({
                        id: `date_${date.value}`,
                        title: date.display.split(',')[0], // Day name
                        description: date.display.split(',')[1] // Date
                    }));
                    
                    await sendListMessage(from,
                        "Great! Let's book your driving test 📅\n\nPlease select your preferred date:",
                        "Select Date",
                        [{
                            title: "Available Dates",
                            rows: dateRows
                        }]
                    );
                    session.step = 'select_date';
                } else if (messageType === 'interactive' && message === 'book_no') {
                    await sendTextMessage(from, 
                        "No problem! Feel free to contact us anytime when you're ready to book your driving test. Have a great day! 😊"
                    );
                    delete userSessions[from];
                    return;
                } else {
                    await sendTextMessage(from, "Please select one of the options above.");
                }
                break;
                
            case 'select_date':
                if (messageType === 'interactive' && message.startsWith('date_')) {
                    const selectedDate = message.replace('date_', '');
                    session.selectedDate = selectedDate;
                    
                    const timeRows = instructor.availableTimes.map(time => ({
                        id: `time_${time}`,
                        title: time,
                        description: `Book at ${time}`
                    }));
                    
                    await sendListMessage(from,
                        `Perfect! You selected ${new Date(selectedDate).toLocaleDateString('en-US', { 
                            weekday: 'long', 
                            year: 'numeric', 
                            month: 'long', 
                            day: 'numeric' 
                        })} 📅\n\nNow please select your preferred time:`,
                        "Select Time",
                        [{
                            title: "Available Times",
                            rows: timeRows
                        }]
                    );
                    session.step = 'select_time';
                } else {
                    await sendTextMessage(from, "Please select a date from the list.");
                }
                break;
                
            case 'select_time':
                if (messageType === 'interactive' && message.startsWith('time_')) {
                    const selectedTime = message.replace('time_', '');
                    session.selectedTime = selectedTime;
                    
                    const confirmationText = `📋 Please confirm your driving test booking:\n\n` +
                        `👨‍🏫 Instructor: ${instructor.name}\n` +
                        `📅 Date: ${new Date(session.selectedDate).toLocaleDateString('en-US', { 
                            weekday: 'long', 
                            year: 'numeric', 
                            month: 'long', 
                            day: 'numeric' 
                        })}\n` +
                        `🕐 Time: ${selectedTime}\n` +
                        `📱 Phone: ${from}\n\n` +
                        `Is this correct?`;
                    
                    await sendButtonMessage(from, confirmationText,
                        [
                            {
                                type: "reply",
                                reply: { id: "confirm_yes", title: "✅ Confirm" }
                            },
                            {
                                type: "reply",
                                reply: { id: "confirm_no", title: "❌ Cancel" }
                            }
                        ]
                    );
                    session.step = 'confirm_details';
                } else {
                    await sendTextMessage(from, "Please select a time from the list.");
                }
                break;
                
            case 'confirm_details':
                if (messageType === 'interactive' && message === 'confirm_yes') {
                    try {
                        // Create calendar event
                        await createCalendarEvent(instructorId, session.selectedDate, session.selectedTime, from);
                        
                        await sendTextMessage(from,
                            `🎉 Booking Confirmed!\n\n` +
                            `Your driving test has been successfully booked:\n\n` +
                            `👨‍🏫 Instructor: ${instructor.name}\n` +
                            `📅 Date: ${new Date(session.selectedDate).toLocaleDateString('en-US', { 
                                weekday: 'long', 
                                year: 'numeric', 
                                month: 'long', 
                                day: 'numeric' 
                            })}\n` +
                            `🕐 Time: ${session.selectedTime}\n\n` +
                            `📧 A calendar invitation has been sent to the instructor.\n` +
                            `📞 You'll receive a confirmation call 24 hours before your test.\n\n` +
                            `Good luck with your driving test! 🚗💨\n\n` +
                            `Type "Hi" anytime to book another test.`
                        );
                        
                        delete userSessions[from];
                        
                    } catch (error) {
                        await sendTextMessage(from,
                            "❌ Sorry, there was an error booking your test. Please try again or contact us directly."
                        );
                        session.step = 'initial';
                        console.log(error);
                    }
                } else if (messageType === 'interactive' && message === 'confirm_no') {
                    await sendTextMessage(from,
                        "Booking cancelled. Type 'Hi' anytime to start a new booking."
                    );
                    delete userSessions[from];
                } else {
                    await sendTextMessage(from, "Please confirm or cancel your booking.");
                }
                break;
                
            default:
                await sendTextMessage(from,
                    "I didn't understand that. Type 'Hi' to start booking your driving test."
                );
                session.step = 'initial';
                break;
        }
        
        userSessions[from] = session;
        
    } catch (error) {
        console.error('Error handling message:', error);
        await sendTextMessage(from, 
            "Sorry, something went wrong. Please try again or contact support."
        );
    }
}

// Webhook verification (for WhatsApp)
app.get('/webhook', (req, res) => {
    const VERIFY_TOKEN = 'your_verify_token_here'; // Set this in your webhook configuration
    
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

// Webhook to receive messages
app.post('/webhook', async (req, res) => {
    console.log('Incoming webhook message:', JSON.stringify(req.body, null, 2));
    
    try {
        const body = req.body;
        
        if (body.object === 'whatsapp_business_account') {
            body.entry?.forEach(entry => {
                entry.changes?.forEach(change => {
                    if (change.field === 'messages') {
                        change.value.messages?.forEach(async message => {
                            const from = message.from;
                            const messageType = message.type;
                            let messageContent = '';
                            
                            if (messageType === 'text') {
                                messageContent = message.text.body;
                            } else if (messageType === 'interactive') {
                                if (message.interactive.type === 'button_reply') {
                                    messageContent = message.interactive.button_reply.id;
                                } else if (message.interactive.type === 'list_reply') {
                                    messageContent = message.interactive.list_reply.id;
                                }
                            }
                            
                            await handleIncomingMessage(from, messageContent, messageType);
                        });
                    }
                });
            });
        }
        
        res.status(200).send('OK');
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).send('Internal Server Error');
    }
});

// Test endpoint to send a message
app.post('/send-test-message', async (req, res) => {
    try {
        const { to, message } = req.body;
        const response = await sendTextMessage(to, message);
        res.json({ success: true, response });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/', async (req, res) => {
    res.json({success : true , response : "I AM ALIVEEEE"});
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`WhatsApp Bot server running on port ${PORT}`);
    console.log(`Webhook URL: http://localhost:${PORT}/webhook`);
});

// Export for testing
module.exports = { app, sendTextMessage, sendButtonMessage, sendListMessage };