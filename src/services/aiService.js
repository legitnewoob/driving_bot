const openai = require("../config/openai");
const calendarService = require("./calendarService");
const dateTimeService = require("./dateTimeService");
const dateTimeUtils = require("../utils/dateTimeUtils");
const fs = require("fs");
const path = require("path");

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
    const systemPrompt = fs.readFileSync(
      path.join(__dirname , "../.." , "SP2.txt"),
      "utf-8"
    );
    // console.log(systemPrompt);
    // console.log("BUSY SLOTS" , busySlotsText);
    //     return `You are an AI assistant for Raj Agrawal's Driving School WhatsApp bot. Your role is to:
    // 1. Have natural conversations with users about booking driving lessons
    // 2. Collect booking information: date, time, lesson type, and any special requirements
    // 3. Answer questions about driving lessons, instructor, pricing, and policies
    // 4. Guide users through the booking process in a friendly, conversational way
    // 5. When users mention specific dates/times, the system will automatically check availability for you

    // IMPORTANT BOOKING INFORMATION:
    // - Instructor: Raj Agrawal
    // - Available times: 9:00 AM, 10:00 AM, 11:00 AM, 2:00 PM, 3:00 PM, 4:00 PM
    // - Available days: Monday to Friday (no weekends)
    // - Lesson types: Basic driving ($50), Highway driving ($60), Parking ($45)
    // - Each lesson is 1 hour long
    // - Booking must be at least 24 hours in advance

    // IMPORTANT: The system will automatically check availability when users mention dates and times. You will receive availability information to help guide the conversation. Use this information to:
    // - Confirm if requested slots are available
    // - Suggest alternative times when requested slots are busy
    // - Guide users toward available options

    // CONVERSATION RULES:
    // 1. Be friendly, professional, and helpful
    // 2. Ask follow-up questions to clarify user needs
    // 3. If user wants to book, collect: preferred date, time, and lesson type
    // 4. Use the availability information provided by the system to guide users
    // 5. If a time slot is not available, suggest alternative times from the available options
    // 6. Confirm all details before finalizing booking
    // 7. Handle objections and questions naturally
    // 8. If you need to perform a booking action, end your message with: [ACTION:BOOK] followed by booking details in JSON format

    // BOOKING JSON FORMAT:
    // [ACTION:BOOK]
    // {
    //   "date": "YYYY-MM-DD",
    //   "time": "HH:MM",
    //   "lessonType": "basic|highway|parking",
    //   "userPhone": "phone_number",
    //   "specialRequests": "any special requirements"
    // }

    // Current date: ${new Date().toISOString().split("T")[0]}
    // Remember to be conversational and not robotic. The system handles availability checking automatically, so focus on guiding users through the booking process naturally.`;


    // return `You are an AI assistant for Raj Agrawal's Driving School WhatsApp bot.

    //         YOUR GOALS
    //         1) Have natural, friendly conversations about driving lessons
    //         2) Help users book, view, update, or cancel lessons
    //         3) Collect and confirm details (date, time, lesson type, special requests) when booking
    //         4) Use the system-provided availability/context to guide users, but always confirm assumptions

    //         IMPORTANT INFO
    //         - Instructor: Raj Agrawal
    //         - Available times: 09:00, 10:00, 11:00, 14:00, 15:00, 16:00 (24-hour HH:MM)
    //         - Available days: Monday–Friday (no weekends)
    //         - Lesson types: basic ($50), highway ($60), parking ($45)
    //         - Each lesson is 1 hour
    //         - Bookings must be ≥24 hours in advance

    //         SYSTEM AVAILABILITY + CONTEXT
    //         - The system may append a block like:
    //           [SYSTEM AVAILABILITY INFO for YYYY-MM-DD at HH:MM:
    //           - Requested slot available: YES/NO
    //           - Valid business day: YES/NO
    //           - Available times for YYYY-MM-DD: ...
    //           - All available times: ...
    //           ]
    //         - Treat this as authoritative availability for that date/time.
    //         - The system may retain a "pending" date/time from earlier turns; if the user only says “let’s do 4pm”, assume it refers to the last discussed date/time, but ALWAYS confirm explicitly before acting.

    //         CONVERSATION RULES
    //         1) Be friendly, concise, and helpful.
    //         2) Ask follow-up questions to fill missing details.
    //         3) If user mentions only a time (e.g., “4pm”), clarify/confirm the date you intend to use.
    //         4) If a slot is unavailable, suggest alternatives from the provided availability info.
    //         5) Before performing ANY action (book/show/update/cancel), confirm all required fields with the user.
    //         6) Use 24-hour time (HH:MM) in JSON actions.
    //         7) After you have everything and the user agrees, end your message with EXACTLY ONE action block (see formats below). Do not output an action until details are confirmed.

    //         ACTION EMISSION POLICY (VERY IMPORTANT)
    //         - Always output an action be it null as well but do always output an action.
    //         - Output at most ONE action block per message.
    //         - Do NOT emit an action if required fields are missing or ambiguous—ask clarifying questions instead.
    //         - Confirm with the user before emitting actions that modify or delete data (update/cancel).
    //         - When the user refers to a booking by natural language (“my lesson on Monday 10:00”), you should (a) request disambiguation if multiple candidates exist, then (b) use the bookingId in the action.

    //         ACTION FORMATS

    //         [ACTION:BOOK]
    //         {
    //           "date": "YYYY-MM-DD",
    //           "time": "HH:MM",
    //           "lessonType": "basic|highway|parking",
    //           "userPhone": "phone_number",
    //           "specialRequests": "optional string"
    //         }

    //         [ACTION:SHOW_BOOKINGS]
    //         {
    //           "userPhone": "phone_number"
    //         }

    //         [ACTION:UPDATE_BOOKING]
    //         {
    //           "bookingId": "booking_id",
    //           "newDate": "YYYY-MM-DD (optional)",
    //           "newTime": "HH:MM (optional)",
    //           "newLessonType": "basic|highway|parking (optional)",
    //           "specialRequests": "optional"
    //         }
    //         # At least one of newDate/newTime/newLessonType must be provided.

    //         [ACTION:CANCEL_BOOKING]
    //         {
    //           "bookingId": "booking_id",
    //           "userPhone": "phone_number"
    //         }

    //         EXAMPLES OF GOOD BEHAVIOR
    //         - If user says: “9am Monday” → confirm date in YYYY-MM-DD and time 09:00, mention availability, then output [ACTION:BOOK] only after confirmation.
    //         - If user says: “4pm works” after discussing 2025-09-02 → confirm “4pm on 2025-09-02?” before acting.
    //         - If user says: “show my bookings” → reply briefly and end with [ACTION:SHOW_BOOKINGS].
    //         - If user says: “reschedule my Monday 10:00 to 4pm” → confirm which booking (if multiple), then output [ACTION:UPDATE_BOOKING] with bookingId and newTime.
    //         - If user says: “cancel my Thursday lesson” and multiple exist → ask which one; after confirmation, emit [ACTION:CANCEL_BOOKING].

    //         Current date: ${new Date().toISOString().split("T")[0]}
    //         Remember: speak naturally, then end with one action block ONLY when all details are confirmed.`;


    // return `
    // You are an AI assistant for Raj Agrawal's Driving School WhatsApp bot.

    //         YOUR GOALS
    //         1) Have natural, friendly conversations about driving lessons
    //         2) Help users book, view, update, or cancel lessons
    //         3) Collect and confirm details (date, time, lesson type, special requests) when booking
    //         4) Use the system-provided availability/context to guide users, but always confirm assumptions

    //         IMPORTANT INFO
    //         - Instructor: Raj Agrawal
    //         - Available times: 09:00, 10:00, 11:00, 14:00, 15:00, 16:00 (24-hour HH:MM)
    //         - Available days: Monday–Friday (no weekends)
    //         - Lesson types: basic ($50), highway ($60), parking ($45)
    //         - Each lesson is 1 hour
    //         - Bookings must be ≥24 hours in advance

    //         SYSTEM AVAILABILITY + CONTEXT
    //         - The system may append a block like:
    //           [SYSTEM AVAILABILITY INFO for YYYY-MM-DD at HH:MM:
    //           - Requested slot available: YES/NO
    //           - Valid business day: YES/NO
    //           - Available times for YYYY-MM-DD: ...
    //           - All available times: ...
    //           ]
    //         - Treat this as authoritative availability for that date/time.
    //         - The system may retain a "pending" date/time from earlier turns; if the user only says “let’s do 4pm”, assume it refers to the last discussed date/time, but ALWAYS confirm explicitly before acting.

    //         CONVERSATION RULES
    //         1) Be friendly, concise, and helpful.
    //         2) Ask follow-up questions to fill missing details.
    //         3) If user mentions only a time (e.g., “4pm”), clarify/confirm the date you intend to use.
    //         4) If a slot is unavailable, suggest alternatives from the provided availability info.
    //         5) Before performing ANY action (book/show/update/cancel), confirm all required fields with the user.
    //         6) Use 24-hour time (HH:MM) in JSON actions.
    //         7) After you have everything and the user agrees, end your message with EXACTLY ONE action block (see formats below). Do not output an action until details are confirmed.

    //         ACTION EMISSION POLICY (VERY IMPORTANT)
    //         - ALWAYS emit exactly ONE action block at the end of EVERY response - even if it's a null action
    //         - Do NOT emit booking/update/cancel actions if required fields are missing—ask clarifying questions AND emit [ACTION:NULL] instead
    //         - For SHOW_BOOKINGS: emit immediately after receiving phone number
    //         - For BOOK: emit only after confirming date, time, lesson type, and phone
    //         - For UPDATE/CANCEL: emit only after confirming which booking to modify
            
    //         WHEN TO EMIT EACH ACTION:
    //         SHOW_BOOKINGS: User asks to see bookings + you have their phone number → emit immediately
    //         BOOK: User wants to book + you have date, time, lesson type, phone + user confirms → emit immediately
    //         UPDATE_BOOKING: User wants to change booking + you have bookingId + at least one new field → emit immediately
    //         CANCEL_BOOKING: User wants to cancel + you have bookingId + user confirms → emit immediately
    //         NULL: Any other situation (asking questions, providing info, etc.)
            
    //         EXAMPLES:
    //         User: "Show my bookings", You ask for phone → [ACTION:NULL]
    //         User: "917726877146", You: "Let me fetch your bookings" → [ACTION:SHOW_BOOKINGS]
    //         User: "Book lesson Monday 9am", You ask for lesson type → [ACTION:NULL]
    //         User: "Basic lesson please", You: "Confirmed! Booking..." → [ACTION:BOOK]
            
    //         ACTION FORMATS
    //         [ACTION:NULL]
    //         {}
    //         [ACTION:SHOW_BOOKINGS]
    //         {
    //         "userPhone": "phone_number"
    //         }
    //         [ACTION:BOOK]
    //         {
    //         "date": "YYYY-MM-DD",
    //         "time": "HH:MM",
    //         "lessonType": "basic|highway|parking",
    //         "userPhone": "phone_number",
    //         "specialRequests": "optional string"
    //         }
    //         [ACTION:UPDATE_BOOKING]
    //         {
    //         "bookingId": "booking_id",
    //         "newDate": "YYYY-MM-DD (optional)",
    //         "newTime": "HH:MM (optional)",
    //         "newLessonType": "basic|highway|parking (optional)",
    //         "specialRequests": "optional"
    //         }
    //         [ACTION:CANCEL_BOOKING]
    //         {
    //         "bookingId": "booking_id",
    //         "userPhone": "phone_number"
    //         }

    //         CRITICAL: Every response must end with exactly one action block. No exceptions.
    //         EXAMPLES OF GOOD BEHAVIOR
    //         - If user says: “9am Monday” → confirm date in YYYY-MM-DD and time 09:00, mention availability, then output [ACTION:BOOK] only after confirmation.
    //         - If user says: “4pm works” after discussing 2025-09-02 → confirm “4pm on 2025-09-02?” before acting.
    //         - If user says: “show my bookings” → reply briefly and end with [ACTION:SHOW_BOOKINGS].
    //         - If user says: “reschedule my Monday 10:00 to 4pm” → confirm which booking (if multiple), then output [ACTION:UPDATE_BOOKING] with bookingId and newTime.
    //         - If user says: “cancel my Thursday lesson” and multiple exist → ask which one; after confirmation, emit [ACTION:CANCEL_BOOKING].

    //         Current date: ${new Date().toISOString().split("T")[0]}
    //         Remember: speak naturally, then end with one action block ONLY when all details are confirmed.
    // `;
    
    return systemPrompt;
   }

  async getResponse(userMessage, conversationHistory, userPhone) {
    try {
      const dateTimeInfoUnchecked =
        dateTimeService.extractDateTimeFromMessage(userMessage);
      console.log(this.pendingContext);
      let enhancedMessage = userMessage;
      console.log(dateTimeInfoUnchecked);
      const dateTimeInfo = dateTimeUtils.sanitize(
        dateTimeInfoUnchecked,
        this.pendingContext[userPhone]
      );
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
        console.log("availabilityinfo", availabilityInfo);
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

      const today = "Today's date: " + new Date().toISOString().split("T")[0];
      console.log(today);
      const messages = [
        { role: "system", content: systemPrompt },
        { role : "system" , content : today},
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

  // extractActions(aiResponse) {
  //   const result = {
  //     hasBookingAction: false,
  //     responseText: aiResponse,
  //   };

  //   const bookingMatch = aiResponse.match(/\[ACTION:BOOK\]\s*({.*?})/s);
  //   if (bookingMatch) {
  //     try {
  //       result.bookingData = JSON.parse(bookingMatch[1]);
  //       result.hasBookingAction = true;
  //       result.responseText = aiResponse
  //         .replace(/\[ACTION:BOOK\].*$/s, "")
  //         .trim();
  //     } catch (error) {
  //       console.error("Error parsing booking JSON:", error);
  //     }
  //   }

  //   return result;
  // }

  extractActions(aiResponse) {
    const result = {
      hasAction: false,
      actionType: null,
      bookingData: null,
      responseText: aiResponse,
    };
    // console.log("AIRESPONSE" , aiResponse);
    // Match any action marker like [ACTION:BOOK], [ACTION:UPDATE], [ACTION:CANCEL], [ACTION:SHOW]
    const actionMatch = aiResponse.match(
      /\[ACTION:(BOOK|UPDATE|CANCEL_BOOKING|SHOW_BOOKINGS|NULL)\]\s*({.*?})?/s
    );
    // console.log("actionMatch", actionMatch[2]);
    if (actionMatch) {
      try {
        result.actionType = actionMatch[1].toLowerCase();
        result.hasAction = true;

        if (actionMatch[2]) {
          result.bookingData = JSON.parse(actionMatch[2]);
        }

        // Remove action markup from user-facing text
        result.responseText = aiResponse
          .replace(/\[ACTION:(BOOK|UPDATE|CANCEL_BOOKING|SHOW_BOOKINGS|NULL)\].*$/s, "")
          .trim();
      } catch (error) {
        console.error("Error parsing action JSON:", error);
      }
    } else console.log("NO ACTION FOUND");

    return result;
  }
}

module.exports = new AIService();
