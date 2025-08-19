require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const OpenAI = require('openai');
const chrono = require("chrono-node");
const app = express();


app.use(express.json());

// Configuration
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WHATSAPP_API_URL = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;

// Initialize OpenAI
const openai = new OpenAI({
    apiKey: OPENAI_API_KEY
});

// Store user sessions with conversation history
const userSessions = {};

// Instructor data - FIXED PRICING KEYS
const instructors = {
    '691332914069950': {
        name: 'Raj Agrawal',
        googleCalendarId: 'agrawalraj918@gmail.com',
        availableTimes: ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00'],
        specialties: ['Basic driving', 'Highway driving', 'Parking', 'City driving'],
        rates: {
            basic: 50,      // Fixed: was 'standard'
            highway: 60,
            parking: 45
        }
    }
};

// Google Calendar setup
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.REMOVED_SECRET,
    process.env.GOOGLE_REDIRECT_URL
);

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// Function to check calendar availability with better error handling
async function checkCalendarAvailability(date, time, instructorId) {
    try {
        console.log(`🔍 Checking availability for ${date} at ${time}...`);
        
        oauth2Client.setCredentials({
            refresh_token: process.env.REMOVED_TOKEN
        });

        const instructor = instructors[instructorId];
        if (!instructor) {
            console.error(`❌ Instructor not found: ${instructorId}`);
            return { isAvailable: false, error: 'Instructor not found' };
        }

        const startDateTime = new Date(`${date}T${time}:00`);
        const endDateTime = new Date(startDateTime.getTime() + 60 * 60 * 1000);

        // Validate date format
        if (isNaN(startDateTime.getTime())) {
            console.error(`❌ Invalid date/time format: ${date} ${time}`);
            return { isAvailable: false, error: 'Invalid date/time format' };
        }

        console.log(`📅 Querying calendar from ${startDateTime.toISOString()} to ${endDateTime.toISOString()}`);

        // Query calendar for events in the requested time slot
        const response = await calendar.events.list({
            calendarId: instructor.googleCalendarId,
            timeMin: startDateTime.toISOString(),
            timeMax: endDateTime.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
        });

        const events = response.data.items || [];
        console.log(`📋 Found ${events.length} events in the requested time slot`);
        
        // Check if there are any conflicting events
        const conflictingEvents = events.filter(event => {
            if (!event.start || !event.end) return false;
            
            const eventStart = new Date(event.start.dateTime || event.start.date);
            const eventEnd = new Date(event.end.dateTime || event.end.date);
            
            // Check for overlap
            const hasOverlap = (startDateTime < eventEnd && endDateTime > eventStart);
            
            if (hasOverlap) {
                console.log(`⚠️ Conflict found: ${event.summary} from ${eventStart.toISOString()} to ${eventEnd.toISOString()}`);
            }
            
            return hasOverlap;
        });

        const isAvailable = conflictingEvents.length === 0;
        console.log(`✅ Time slot ${date} at ${time} is ${isAvailable ? 'AVAILABLE' : 'NOT AVAILABLE'}`);

        return {
            isAvailable,
            conflictingEvents
        };
    } catch (error) {
        console.error('❌ Error checking calendar availability:', error.message);
        console.error('❌ Full error:', error);
        
        // Return available if we can't check calendar (better UX)
        return {
            isAvailable: true,
            error: `Could not verify calendar availability: ${error.message}`,
            warning: true
        };
    }
}

// Function to get available time slots for a specific date
async function getAvailableTimeSlotsForDate(date, instructorId) {
    try {
        console.log(`🔍 Getting available time slots for ${date}...`);
        const instructor = instructors[instructorId];
        const availableSlots = [];

        // Check each time slot
        for (const time of instructor.availableTimes) {
            console.log(`⏰ Checking ${time}...`);
            const availability = await checkCalendarAvailability(date, time, instructorId);
            if (availability.isAvailable) {
                availableSlots.push(time);
                console.log(`✅ ${time} is available`);
            } else {
                console.log(`❌ ${time} is busy`);
            }
        }

        console.log(`📝 Available slots for ${date}: ${availableSlots.join(', ') || 'None'}`);
        return availableSlots;
    } catch (error) {
        console.error('❌ Error getting available time slots:', error);
        return instructor.availableTimes; // Fallback to all times if error
    }
}

// Function to get calendar context for AI (extended range)
async function getCalendarContext(instructorId) {
    try {
        oauth2Client.setCredentials({
            refresh_token: process.env.REMOVED_TOKEN
        });

        const instructor = instructors[instructorId];
        const now = new Date();
        const twoWeeksFromNow = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

        console.log(`🔍 Fetching calendar events from ${now.toISOString()} to ${twoWeeksFromNow.toISOString()}`);

        // Get events for the next two weeks
        const response = await calendar.events.list({
            calendarId: instructor.googleCalendarId,
            timeMin: now.toISOString(),
            timeMax: twoWeeksFromNow.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
        });

        const events = response.data.items || [];
        console.log(`📅 Found ${events.length} events in calendar`);

        const busySlots = events.map(event => {
            if (event.start && event.start.dateTime) {
                const startTime = new Date(event.start.dateTime);
                const slot = {
                    date: startTime.toISOString().split('T')[0],
                    time: startTime.toTimeString().slice(0, 5),
                    summary: event.summary || 'Busy'
                };
                console.log(`🚫 Busy slot: ${slot.date} at ${slot.time} - ${slot.summary}`);
                return slot;
            }
            return null;
        }).filter(Boolean);

        console.log(`📝 Returning ${busySlots.length} busy slots to AI`);
        return busySlots;
    } catch (error) {
        console.error('❌ Error getting calendar context:', error.message);
        return [];
    }
}

// NEW FUNCTION: Comprehensive availability check for AI
async function getAvailabilityInfo(dateRequested, timeRequested, instructorId) {
    try {
        console.log(`🤖 AI requested availability check for ${dateRequested} at ${timeRequested}`);
        
        const instructor = instructors[instructorId];
        if (!instructor) {
            return {
                error: 'Instructor not found',
                isValidRequest: false
            };
        }

        // Check if the requested time is in available slots
        if (!instructor.availableTimes.includes(timeRequested)) {
            return {
                isValidRequest: false,
                requestedSlotAvailable: false,
                message: `${timeRequested} is not an available time slot.`,
                allAvailableTimes: instructor.availableTimes,
                availableSlotsForDate: []
            };
        }

        // Check specific slot availability
        const slotAvailability = await checkCalendarAvailability(dateRequested, timeRequested, instructorId);
        
        // Get all available slots for the requested date
        const availableSlotsForDate = await getAvailableTimeSlotsForDate(dateRequested, instructorId);
        
        // Check if the date is a valid business day
        const requestedDate = new Date(dateRequested);
        const isWeekend = requestedDate.getDay() === 0 || requestedDate.getDay() === 6;
        const isValidBusinessDay = !isWeekend;
        
        const result = {
            isValidRequest: true,
            requestedDate: dateRequested,
            requestedTime: timeRequested,
            requestedSlotAvailable: slotAvailability.isAvailable,
            isValidBusinessDay,
            availableSlotsForDate,
            allAvailableTimes: instructor.availableTimes,
            calendarError: slotAvailability.error,
            hasWarning: slotAvailability.warning
        };

        console.log(`📊 Availability info result:`, JSON.stringify(result, null, 2));
        return result;
        
    } catch (error) {
        console.error('❌ Error getting availability info:', error);
        return {
            error: error.message,
            isValidRequest: false
        };
    }
}


function extractDateTimeFromMessage(message) {
  console.log(`🔍 Extracting date/time from: "${message}"`);

  const result = chrono.parse(message, new Date(), { forwardDate: true });

  
  console.log(`📊 Extraction result:`, result);
  if (result.length > 0) {
    const parsedDate = result[0].start.date();

    return {
      hasDateTime: true,
      date: parsedDate.toDateString(),
      time: parsedDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      confidence: "high"
    };
  }
  
  return {
    hasDateTime: false,
    date: null,
    time: null,
    confidence: "low"
  };
}
// Enhanced function to extract date/time from user message

// function extractDateTimeFromMessage(message) {
//     console.log(`🔍 Extracting date/time from: "${message}"`);
    
//     const today = new Date();
//     const result = {
//         hasDateTime: false,
//         date: null,
//         time: null,
//         confidence: 'low'
//     };

//     // Common time patterns
//     const timePatterns = [
//         /\b(0?9|09):?00\b/i,          // 9:00, 09:00
//         /\b(10):?00\b/i,              // 10:00
//         /\b(11):?00\b/i,              // 11:00
//         /\b(0?2|02|14):?00\b/i,       // 2:00, 02:00, 14:00
//         /\b(0?3|03|15):?00\b/i,       // 3:00, 03:00, 15:00
//         /\b(0?4|04|16):?00\b/i,       // 4:00, 04:00, 16:00
//         /\b9\s*(?:am|a\.m\.?)\b/i,    // 9am, 9 am
//         /\b10\s*(?:am|a\.m\.?)\b/i,   // 10am
//         /\b11\s*(?:am|a\.m\.?)\b/i,   // 11am
//         /\b2\s*(?:pm|p\.m\.?)\b/i,    // 2pm
//         /\b3\s*(?:pm|p\.m\.?)\b/i,    // 3pm
//         /\b4\s*(?:pm|p\.m\.?)\b/i     // 4pm
//     ];

//     // Map patterns to 24-hour format
//     const timeMap = {
//         '9': '09:00', '09': '09:00',
//         '10': '10:00',
//         '11': '11:00',
//         '2': '14:00', '02': '14:00', '14': '14:00',
//         '3': '15:00', '03': '15:00', '15': '15:00',
//         '4': '16:00', '04': '16:00', '16': '16:00'
//     };

//     // Check for time patterns
//     for (const pattern of timePatterns) {
//         const match = message.match(pattern);
//         if (match) {
//             const timeStr = match[1] || match[0].replace(/[^\d]/g, '');
//             if (timeMap[timeStr]) {
//                 result.time = timeMap[timeStr];
//                 result.hasDateTime = true;
//                 result.confidence = 'high';
//                 console.log(`✅ Found time: ${result.time}`);
//                 break;
//             }
//         }
//     }

//     // Date patterns
//     const datePatterns = [
//         /\b(tomorrow)\b/i,
//         /\b(today)\b/i,
//         /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
//         /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/,  // MM/DD/YYYY or DD/MM/YYYY
//         /\b(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/     // YYYY/MM/DD
//     ];

//     for (const pattern of datePatterns) {
//         const match = message.match(pattern);
//         if (match) {
//             if (match[1] && match[1].toLowerCase() === 'tomorrow') {
//                 const tomorrow = new Date(today);
//                 tomorrow.setDate(today.getDate() + 1);
//                 result.date = tomorrow.toISOString().split('T')[0];
//                 result.hasDateTime = true;
//                 result.confidence = 'high';
//                 console.log(`✅ Found date: tomorrow (${result.date})`);
//                 break;
//             } else if (match[1] && match[1].toLowerCase() === 'today') {
//                 result.date = today.toISOString().split('T')[0];
//                 result.hasDateTime = true;
//                 result.confidence = 'high';
//                 console.log(`✅ Found date: today (${result.date})`);
//                 break;
//             } else if (match[1] && ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].includes(match[1].toLowerCase())) {
//                 // Find next occurrence of the day
//                 const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
//                 const targetDay = days.indexOf(match[1].toLowerCase());
//                 const currentDay = today.getDay();
//                 let daysAhead = targetDay - currentDay;
//                 if (daysAhead <= 0) daysAhead += 7;
                
//                 const targetDate = new Date(today);
//                 targetDate.setDate(today.getDate() + daysAhead);
//                 result.date = targetDate.toISOString().split('T')[0];
//                 result.hasDateTime = true;
//                 result.confidence = 'medium';
//                 console.log(`✅ Found date: ${match[1]} (${result.date})`);
//                 break;
//             }
//         }
//     }

//     console.log(`📊 Extraction result:`, result);
//     return result;
// }


// Updated system prompt with enhanced availability instructions


async function getSystemPrompt(instructorId) {
    console.log('🤖 Building system prompt with calendar context...');
    const busySlots = await getCalendarContext(instructorId);
    
    let busySlotsText = '\n\nNo current bookings found.';
    if (busySlots.length > 0) {
        busySlotsText = `\n\nCURRENTLY BOOKED TIME SLOTS (NOT AVAILABLE):\n${busySlots.map(slot => `❌ ${slot.date} at ${slot.time} - ${slot.summary}`).join('\n')}`;
        console.log(`📋 Including ${busySlots.length} busy slots in AI prompt`);
    } else {
        console.log('✅ No busy slots found - all times potentially available');
    }

    return `You are an AI assistant for Raj Agrawal's Driving School WhatsApp bot. Your role is to:

1. Have natural conversations with users about booking driving lessons
2. Collect booking information: date, time, lesson type, and any special requirements
3. Answer questions about driving lessons, instructor, pricing, and policies
4. Guide users through the booking process in a friendly, conversational way
5. When users mention specific dates/times, the system will automatically check availability for you

IMPORTANT BOOKING INFORMATION:
- Instructor: Raj Agrawal
- Available times: 9:00 AM, 10:00 AM, 11:00 AM, 2:00 PM, 3:00 PM, 4:00 PM
- Available days: Monday to Friday (no weekends)
- Lesson types: Basic driving ($50), Highway driving ($60), Parking ($45)
- Each lesson is 1 hour long
- Booking must be at least 24 hours in advance

${busySlotsText}

IMPORTANT: The system will automatically check availability when users mention dates and times. You will receive availability information to help guide the conversation. Use this information to:
- Confirm if requested slots are available
- Suggest alternative times when requested slots are busy
- Guide users toward available options

CONVERSATION RULES:
1. Be friendly, professional, and helpful
2. Ask follow-up questions to clarify user needs
3. If user wants to book, collect: preferred date, time, and lesson type
4. Use the availability information provided by the system to guide users
5. If a time slot is not available, suggest alternative times from the available options
6. Confirm all details before finalizing booking
7. Handle objections and questions naturally
8. If you need to perform a booking action, end your message with: [ACTION:BOOK] followed by booking details in JSON format

BOOKING JSON FORMAT:
[ACTION:BOOK]
{
  "date": "YYYY-MM-DD",
  "time": "HH:MM",
  "lessonType": "basic|highway|parking",
  "userPhone": "phone_number",
  "specialRequests": "any special requirements"
}

Current date: ${new Date().toISOString().split('T')[0]}

Remember to be conversational and not robotic. The system handles availability checking automatically, so focus on guiding users through the booking process naturally.`;
}

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

// Function to get available dates (next 7 business days)
function getAvailableDates() {
    const dates = [];
    const today = new Date();
    
    for (let i = 1; i <= 10; i++) {
        const date = new Date(today);
        date.setDate(today.getDate() + i);
        
        // Skip weekends
        if (date.getDay() !== 0 && date.getDay() !== 6) {
            dates.push(date.toISOString().split('T')[0]);
        }
        
        if (dates.length >= 7) break;
    }
    
    return dates;
}

// IMPROVED VALIDATION FUNCTION with detailed logging
async function validateBooking(bookingData) {
    console.log('🔍 Validating booking data:', JSON.stringify(bookingData, null, 2));
    
    const availableDates = getAvailableDates();
    const instructorId = PHONE_NUMBER_ID;
    const instructor = instructors[instructorId];
    
    const errors = [];
    
    // Check if all required fields are present
    if (!bookingData.date) {
        errors.push('Date is required');
    }
    if (!bookingData.time) {
        errors.push('Time is required');
    }
    if (!bookingData.lessonType) {
        errors.push('Lesson type is required');
    }
    
    if (errors.length > 0) {
        console.log('❌ Missing required fields:', errors);
        return errors;
    }
    
    if (!availableDates.includes(bookingData.date)) {
        errors.push('Date is not available. Please choose from available weekdays.');
        console.log(`❌ Date ${bookingData.date} not in available dates:`, availableDates.slice(0, 5));
    }
    
    if (!instructor.availableTimes.includes(bookingData.time)) {
        errors.push('Time slot is not available. Available times: ' + instructor.availableTimes.join(', '));
        console.log(`❌ Time ${bookingData.time} not in available times:`, instructor.availableTimes);
    }
    
    if (!['basic', 'highway', 'parking'].includes(bookingData.lessonType)) {
        errors.push('Invalid lesson type. Choose from: basic, highway, or parking');
        console.log(`❌ Invalid lesson type: ${bookingData.lessonType}`);
    }

    // Only check calendar availability if basic validation passes
    if (errors.length === 0) {
        console.log('✅ Basic validation passed, checking calendar availability...');
        const availability = await checkCalendarAvailability(bookingData.date, bookingData.time, instructorId);
        
        if (!availability.isAvailable && !availability.warning) {
            errors.push(`The time slot ${bookingData.time} on ${bookingData.date} is already booked.`);
            console.log(`❌ Calendar shows time slot is not available`);
            
            // Suggest alternative times
            const availableSlots = await getAvailableTimeSlotsForDate(bookingData.date, instructorId);
            if (availableSlots.length > 0) {
                errors.push(`Available times for ${bookingData.date}: ${availableSlots.join(', ')}`);
            } else {
                errors.push(`No available time slots for ${bookingData.date}. Please choose a different date.`);
            }
        } else if (availability.warning) {
            console.log(`⚠️ Calendar check failed but allowing booking: ${availability.error}`);
        }
    }
    
    console.log(`📋 Validation result: ${errors.length} errors found`);
    if (errors.length > 0) {
        console.log('❌ Validation errors:', errors);
    } else {
        console.log('✅ Booking validation passed!');
    }
    
    return errors;
}

// IMPROVED CALENDAR EVENT CREATION with better error handling
async function createCalendarEvent(bookingData) {
    try {
        console.log('📅 Creating calendar event for booking:', JSON.stringify(bookingData, null, 2));
        
        oauth2Client.setCredentials({
            refresh_token: process.env.REMOVED_TOKEN
        });

        const instructorId = PHONE_NUMBER_ID;
        const instructor = instructors[instructorId];
        const startDateTime = new Date(`${bookingData.date}T${bookingData.time}:00`);
        const endDateTime = new Date(startDateTime.getTime() + 60 * 60 * 1000);

        console.log(`📅 Event time: ${startDateTime.toISOString()} to ${endDateTime.toISOString()}`);

        const event = {
            summary: `Driving Lesson - ${bookingData.lessonType} - ${bookingData.userPhone}`,
            description: `Driving lesson booking\nPhone: ${bookingData.userPhone}\nLesson Type: ${bookingData.lessonType}\nSpecial Requests: ${bookingData.specialRequests || 'None'}`,
            start: {
                dateTime: startDateTime.toISOString(),
                timeZone: 'America/New_York',
            },
            end: {
                dateTime: endDateTime.toISOString(),
                timeZone: 'America/New_York',
            },
            attendees: [
                { email: instructor.googleCalendarId }
            ],
        };

        console.log('📧 Creating event with data:', JSON.stringify(event, null, 2));

        const response = await calendar.events.insert({
            calendarId: instructor.googleCalendarId,
            auth: oauth2Client,
            resource: event,
        });

        console.log('✅ Calendar event created successfully:', response.data.id);
        return response.data;
    } catch (error) {
        console.error('❌ Error creating calendar event:', error.message);
        console.error('❌ Full error:', error);
        throw error;
    }
}

// Enhanced function to get AI response with availability information
async function getAIResponse(userMessage, conversationHistory, userPhone) {
    try {
        // Extract potential date/time from user message
        const dateTimeInfo = extractDateTimeFromMessage(userMessage);
        
        let enhancedMessage = userMessage;
        let availabilityInfo = null;

        // If we found date/time info, check availability and enhance the message
        if (dateTimeInfo.hasDateTime && dateTimeInfo.date && dateTimeInfo.time) {
            console.log(`🤖 User mentioned ${dateTimeInfo.date} at ${dateTimeInfo.time}, checking availability...`);
            
            availabilityInfo = await getAvailabilityInfo(dateTimeInfo.date, dateTimeInfo.time, PHONE_NUMBER_ID);
            
            if (availabilityInfo.isValidRequest) {
                // Enhance the user message with availability context for AI
                enhancedMessage += `\n\n[SYSTEM AVAILABILITY INFO for ${dateTimeInfo.date} at ${dateTimeInfo.time}:
- Requested slot available: ${availabilityInfo.requestedSlotAvailable ? 'YES' : 'NO'}
- Valid business day: ${availabilityInfo.isValidBusinessDay ? 'YES' : 'NO'}
- Available times for ${dateTimeInfo.date}: ${availabilityInfo.availableSlotsForDate.length > 0 ? availabilityInfo.availableSlotsForDate.join(', ') : 'None'}
- All available times: ${availabilityInfo.allAvailableTimes.join(', ')}]`;
                
                console.log(`📊 Enhanced message with availability info`);
            }
        }

        const systemPrompt = await getSystemPrompt(PHONE_NUMBER_ID);
        const messages = [
            { role: 'system', content: systemPrompt },
            ...conversationHistory,
            { role: 'user', content: enhancedMessage }
        ];

        const response = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: messages,
            max_tokens: 500,
            temperature: 0.7
        });

        return response.choices[0].message.content;
    } catch (error) {
        console.error('Error getting AI response:', error);
        throw error;
    }
}

// Function to extract actions from AI response
function extractActions(aiResponse) {
    const result = {
        hasBookingAction: false,
        responseText: aiResponse
    };

    // Check for booking action
    const bookingMatch = aiResponse.match(/\[ACTION:BOOK\]\s*({.*?})/s);
    if (bookingMatch) {
        try {
            result.bookingData = JSON.parse(bookingMatch[1]);
            result.hasBookingAction = true;
            result.responseText = aiResponse.replace(/\[ACTION:BOOK\].*$/s, '').trim();
            console.log('🤖 AI triggered booking action:', JSON.stringify(result.bookingData, null, 2));
        } catch (error) {
            console.error('Error parsing booking JSON:', error);
        }
    }

    return result;
}

// IMPROVED MESSAGE HANDLER with automatic availability checking
async function handleIncomingMessage(from, messageContent) {
    try {
        console.log(`📱 Incoming message from ${from}: "${messageContent}"`);
        
        // Initialize or get user session
        if (!userSessions[from]) {
            userSessions[from] = {
                conversationHistory: [],
                lastActivity: new Date()
            };
            console.log(`👤 New user session created for ${from}`);
           
        }

        const session = userSessions[from];
        session.lastActivity = new Date();
        console.log(session);
        // Get AI response (availability checking happens inside this function)
        console.log('🤖 Getting AI response with automatic availability checking...');
        const aiResponse = await getAIResponse(messageContent, session.conversationHistory, from);
        console.log('🤖 AI response:', aiResponse);
        
        // Extract actions from response
        const { hasBookingAction, bookingData, responseText } = extractActions(aiResponse);
        
        // Send the response text to user
        if (responseText) {
            console.log(`📤 Sending response to user: "${responseText}"`);
            await sendTextMessage(from, responseText);
        }
        
        // Handle booking action if present
        if (hasBookingAction) {
            console.log('🎯 Processing booking request...');
            bookingData.userPhone = from;
            
            // Validate booking data (includes calendar availability check)
            const validationErrors = await validateBooking(bookingData);
            
            if (validationErrors.length > 0) {
                console.log(`❌ Booking validation failed with ${validationErrors.length} errors`);
                const errorMessage = [
                    "❌ There are some issues with your booking:",
                    "",
                    ...validationErrors,
                    "",
                    "Please provide the correct information and I'll help you book again."
                ].join('\n');
                
                await sendTextMessage(from, errorMessage);
            } else {
                console.log('✅ Booking validation passed, creating calendar event...');
                try {
                    // Create calendar event
                    const calendarEvent = await createCalendarEvent(bookingData);
                    console.log('📅 Calendar event created successfully');
                    
                    // Get instructor info for confirmation
                    const instructorId = PHONE_NUMBER_ID;
                    const instructor = instructors[instructorId];
                    const lessonPrice = instructor.rates[bookingData.lessonType];
                    
                    console.log(`💰 Lesson price for ${bookingData.lessonType}: ${lessonPrice}`);
                    
                    const confirmationMessage = [
                        "🎉 Booking Confirmed!",
                        "",
                        "✅ Your driving lesson has been successfully booked:",
                        "",
                        `👨‍🏫 Instructor: ${instructor.name}`,
                        `📅 Date: ${new Date(bookingData.date).toLocaleDateString('en-US', { 
                            weekday: 'long', 
                            year: 'numeric', 
                            month: 'long', 
                            day: 'numeric' 
                        })}`,
                        `🕐 Time: ${bookingData.time}`,
                        `🚗 Lesson Type: ${bookingData.lessonType.charAt(0).toUpperCase() + bookingData.lessonType.slice(1)} driving`,
                        `💰 Price: ${lessonPrice}`,
                        "",
                        "📧 A calendar invitation has been sent to your instructor.",
                        "📞 You'll receive a confirmation call 24 hours before your lesson.",
                        "",
                        "Good luck with your driving lesson! 🚗💨",
                        "",
                        "Feel free to message anytime if you need to reschedule or have questions!"
                    ].join('\n');
                    
                    console.log('📤 Sending booking confirmation...');
                    await sendTextMessage(from, confirmationMessage);
                    console.log('✅ Booking process completed successfully!');
                    
                } catch (error) {
                    console.error('❌ Booking error:', error.message);
                    console.error('❌ Full booking error:', error);
                    const errorMessage = [
                        "❌ Sorry, there was an error processing your booking.",
                        "",
                        "Please try again or contact us directly at:",
                        instructors[PHONE_NUMBER_ID].googleCalendarId
                    ].join('\n');
                    
                    await sendTextMessage(from, errorMessage);
                }
            }
        }
        
        // Update conversation history
        session.conversationHistory.push(
            { role: 'user', content: messageContent },
            { role: 'assistant', content: aiResponse }
        );
        
        // Keep only last 20 messages to avoid token limits
        if (session.conversationHistory.length > 20) {
            session.conversationHistory = session.conversationHistory.slice(-20);
        }
        
        userSessions[from] = session;
        
    } catch (error) {
        console.error('❌ Error handling message:', error.message);
        console.error('❌ Full error:', error);
        const errorMessage = [
            "Sorry, I'm having trouble processing your message right now.",
            "",
            "Please try again in a moment."
        ].join('\n');
        
        await sendTextMessage(from, errorMessage);
    }
}

// Google OAuth routes
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
        res.send("✅ Google Calendar linked! Save your refresh_token in your .env file.");
    } catch (err) {
        console.error(err);
        res.status(500).send("Auth Error");
    }
});

// New endpoint to check availability manually
app.post('/check-availability', async (req, res) => {
    try {
        const { date, time } = req.body;
        const availability = await checkCalendarAvailability(date, time, PHONE_NUMBER_ID);
        const availableSlots = await getAvailableTimeSlotsForDate(date, PHONE_NUMBER_ID);
        
        res.json({
            requested: { date, time },
            isAvailable: availability.isAvailable,
            availableTimesForDate: availableSlots,
            error: availability.error
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// New endpoint to test availability info function
app.post('/test-availability-info', async (req, res) => {
    try {
        const { date, time } = req.body;
        const availabilityInfo = await getAvailabilityInfo(date, time, PHONE_NUMBER_ID);
        res.json(availabilityInfo);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// New endpoint to test date/time extraction
app.post('/test-extraction', async (req, res) => {
    try {
        const { message } = req.body;
        const extractedInfo = extractDateTimeFromMessage(message);
        res.json(extractedInfo);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Test calendar connection
app.get('/test-calendar', async (req, res) => {
    try {
        console.log('🔍 Testing calendar connection...');
        const busySlots = await getCalendarContext(PHONE_NUMBER_ID);
        res.json({
            success: true,
            message: 'Calendar connection test',
            busySlots: busySlots,
            instructorId: PHONE_NUMBER_ID,
            instructor: instructors[PHONE_NUMBER_ID]
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message,
            fullError: error
        });
    }
});

// Webhook verification
app.get('/webhook', (req, res) => {
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
                                // Handle button/list interactions
                                if (message.interactive.type === 'button_reply') {
                                    messageContent = message.interactive.button_reply.title;
                                } else if (message.interactive.type === 'list_reply') {
                                    messageContent = message.interactive.list_reply.title;
                                }
                            }
                            
                            if (messageContent) {
                                await handleIncomingMessage(from, messageContent);
                            }
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

// Clean up old sessions (run periodically)
setInterval(() => {
    const now = new Date();
    const oneHour = 60 * 60 * 1000;
    
    Object.keys(userSessions).forEach(phone => {
        if (now - userSessions[phone].lastActivity > oneHour) {
            delete userSessions[phone];
        }
    });
}, 10 * 60 * 1000); // Clean every 10 minutes

// Test endpoint
app.post('/send-test-message', async (req, res) => {
    try {
        const { to, message } = req.body;
        const response = await sendTextMessage(to, message);
        res.json({ success: true, response });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/', (req, res) => {
    res.json({ 
        success: true, 
        response: "🤖 Enhanced AI WhatsApp Driving School Bot with Automatic Availability Checking! 🚗📅✨",
        features: [
            "✅ Automatic date/time extraction from user messages",
            "✅ Real-time calendar availability checking", 
            "✅ Smart availability suggestions",
            "✅ Enhanced AI responses with availability context",
            "✅ Seamless booking flow"
        ]
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🤖 Enhanced AI WhatsApp Bot server running on port ${PORT}`);
    console.log(`🔗 Webhook URL: http://localhost:${PORT}/webhook`);
    console.log(`📅 Google Auth URL: http://localhost:${PORT}/google-auth`);
    console.log(`🔍 Check Availability: POST http://localhost:${PORT}/check-availability`);
    console.log(`🧪 Test Calendar: GET http://localhost:${PORT}/test-calendar`);
    console.log(`📊 Test Availability Info: POST http://localhost:${PORT}/test-availability-info`);
    console.log(`🔤 Test Extraction: POST http://localhost:${PORT}/test-extraction`);
    console.log(`✨ Enhanced with automatic availability checking!`);
});

module.exports = { 
    app, 
    sendTextMessage, 
    checkCalendarAvailability, 
    getAvailableTimeSlotsForDate, 
    getAvailabilityInfo,
    extractDateTimeFromMessage 
};