const openai = require("../config/openai");
const calendarService = require("./calendarService");
const dateTimeService = require("./dateTimeService");
const dateTimeUtils = require("../utils/dateTimeUtils");

class AIService {
  constructor() {
    // temporary store keyed by user phone number
    this.pendingContext = {};
  }
  async getSystemPrompt(instructorId) {
    const busySlots = await calendarService.getCalendarContext(instructorId);

    let busySlotsText = "\n\nNo current bookings found.";
    if (busySlots.length > 0) {
      busySlotsText = `\n\nCURRENTLY BOOKED TIME SLOTS (NOT AVAILABLE):\n${busySlots
        .map((slot) => `❌ ${slot.date} at ${slot.time} - ${slot.summary}`)
        .join("\n")}`;
    }

    // console.log("BUSY SLOTS" , busySlotsText);
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

Current date: ${new Date().toISOString().split("T")[0]}
Remember to be conversational and not robotic. The system handles availability checking automatically, so focus on guiding users through the booking process naturally.`;
  }

  async getResponse(userMessage, conversationHistory, userPhone) {
    try {
      const dateTimeInfoUnchecked =
        dateTimeService.extractDateTimeFromMessage(userMessage);
      console.log(this.pendingContext);
      let enhancedMessage = userMessage;
      console.log(dateTimeInfoUnchecked);
      const dateTimeInfo = dateTimeUtils.sanitize(dateTimeInfoUnchecked, this.pendingContext[userPhone]);
      console.log(dateTimeInfo);
      
      if (dateTimeInfo.hasDateTime && dateTimeInfo.date && dateTimeInfo.time) {
        // console.log("IM HERE");
        // Save the context for this user
        this.pendingContext[userPhone] = {
          date: dateTimeInfo.date || this.pendingContext[userPhone]?.date,
          time: dateTimeInfo.time || this.pendingContext[userPhone]?.time,
        };

        const availabilityInfo = await this.getAvailabilityInfo(
          dateTimeInfo.date,
          dateTimeInfo.time,
          process.env.PHONE_NUMBER_ID
        );
        console.log("availabilityinfo" , availabilityInfo);
        if (availabilityInfo.isValidRequest) {
          enhancedMessage += `\n\n[SYSTEM AVAILABILITY INFO for ${
            dateTimeInfo.date
          } at ${dateTimeInfo.time}:
- Requested slot available: ${
            availabilityInfo.requestedSlotAvailable ? "YES" : "NO"
          }
- Valid business day: ${availabilityInfo.isValidBusinessDay ? "YES" : "NO"}
- Available times for ${dateTimeInfo.date}: ${
            availabilityInfo.availableSlotsForDate.length > 0
              ? availabilityInfo.availableSlotsForDate.join(", ")
              : "None"
          }
- All available times: ${availabilityInfo.allAvailableTimes.join(", ")}]`;
        }
      }
      console.log(enhancedMessage);
      const systemPrompt = await this.getSystemPrompt(
        process.env.PHONE_NUMBER_ID
      );
      const messages = [
        { role: "system", content: systemPrompt },
        ...conversationHistory,
        { role: "user", content: enhancedMessage },
      ];

      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: messages,
        max_tokens: 500,
        temperature: 0.7,
      });

      return response.choices[0].message.content;
    } catch (error) {
      console.error("Error getting AI response:", error);
      throw error;
    }
  }

  async getAvailabilityInfo(dateRequested, timeRequested, instructorId) {
    try {
      const instructor = require("../models/instructorModel").getInstructor(
        instructorId
      );
      if (!instructor) {
        return {
          error: "Instructor not found",
          isValidRequest: false,
        };
      }

      if (!instructor.availableTimes.includes(timeRequested)) {
        return {
          isValidRequest: false,
          requestedSlotAvailable: false,
          message: `${timeRequested} is not an available time slot.`,
          allAvailableTimes: instructor.availableTimes,
          availableSlotsForDate: [],
        };
      }

      const slotAvailability = await calendarService.checkAvailability(
        dateRequested,
        timeRequested,
        instructorId
      );
      const availableSlotsForDate =
        await calendarService.getAvailableTimeSlotsForDate(
          dateRequested,
          instructorId
        );

      const requestedDate = new Date(dateRequested);
      const isWeekend =
        requestedDate.getDay() === 0 || requestedDate.getDay() === 6;
      const isValidBusinessDay = !isWeekend;

      return {
        isValidRequest: true,
        requestedDate: dateRequested,
        requestedTime: timeRequested,
        requestedSlotAvailable: slotAvailability.isAvailable,
        isValidBusinessDay,
        availableSlotsForDate,
        allAvailableTimes: instructor.availableTimes,
        calendarError: slotAvailability.error,
        hasWarning: slotAvailability.warning,
      };
    } catch (error) {
      console.error("❌ Error getting availability info:", error);
      return {
        error: error.message,
        isValidRequest: false,
      };
    }
  }

  extractActions(aiResponse) {
    const result = {
      hasBookingAction: false,
      responseText: aiResponse,
    };

    const bookingMatch = aiResponse.match(/\[ACTION:BOOK\]\s*({.*?})/s);
    if (bookingMatch) {
      try {
        result.bookingData = JSON.parse(bookingMatch[1]);
        result.hasBookingAction = true;
        result.responseText = aiResponse
          .replace(/\[ACTION:BOOK\].*$/s, "")
          .trim();
      } catch (error) {
        console.error("Error parsing booking JSON:", error);
      }
    }

    return result;
  }
}

module.exports = new AIService();
