const openai = require("../config/openai");
const calendarService = require("./calendarService");
const dateTimeService = require("./dateTimeService");

class AIService {
  async getSystemPrompt(instructorId) {
    const busySlots = await calendarService.getCalendarContext(instructorId);

    let busySlotsText = "\n\nNo current bookings found.";
    if (busySlots.length > 0) {
      busySlotsText = `\n\nCURRENTLY BOOKED TIME SLOTS (NOT AVAILABLE):\n${busySlots
        .map((slot) => `❌ ${slot.date} at ${slot.time} - ${slot.summary}`)
        .join("\n")}`;
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

BOOKING JSON FORMAT:
[ACTION:BOOK]
{
  "date": "YYYY-MM-DD",
  "time": "HH:MM",
  "lessonType": "basic|highway|parking",
  "userPhone": "phone_number",
  "specialRequests": "any special requirements"
}

Current date: ${new Date().toISOString().split("T")[0]}`;
  }

  async getResponse(userMessage, conversationHistory, userPhone) {
    try {
      const dateTimeInfo =
        dateTimeService.extractDateTimeFromMessage(userMessage);

      let enhancedMessage = userMessage;

      if (dateTimeInfo.hasDateTime && dateTimeInfo.date && dateTimeInfo.time) {
        const availabilityInfo = await this.getAvailabilityInfo(
          dateTimeInfo.date,
          dateTimeInfo.time,
          process.env.PHONE_NUMBER_ID
        );

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
