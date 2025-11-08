const { model } = require("../../config/gemini");
const calendarService = require("../calendarService");
const dateTimeService = require("./dateTimeService");
const dateTimeUtils = require("../../utils/dateTimeUtils");
const timezoneUtils = require("../../utils/timezoneUtils");
const RouteOptimizer = require("../routeOptimizer");
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
      path.join(__dirname, "../../../", "SP8.txt"),
      "utf-8"
    );

    return systemPrompt;
  }

  // Helper method to check what datetime info we have
  checkDateTimeCompleteness(extractedDateTime, userPhone) {
    const pending = this.pendingContext[userPhone] || {};

    return {
      hasExtractedDate: !!extractedDateTime.date,
      hasExtractedTime: !!extractedDateTime.time,
      hasPendingDate: !!pending.date,
      hasPendingTime: !!pending.time,
      finalDate: extractedDateTime.date || pending.date,
      finalTime: extractedDateTime.time || pending.time,
    };
  }

  // Helper method to check if booking is within 24 hours
  // isWithin24Hours(dateRequested, timeRequested = null) {
  //   if (!dateRequested) return false;

  //   const now = new Date();
  //   const requestedDateTime = new Date(dateRequested);

  //   // If time is provided, set it on the date
  //   if (timeRequested) {
  //     const [hours, minutes] = timeRequested.split(":").map(Number);
  //     requestedDateTime.setHours(hours, minutes, 0, 0);
  //   } else {
  //     // If no time provided, assume start of day for the check
  //     requestedDateTime.setHours(0, 0, 0, 0);
  //   }

  //   const timeDifference = requestedDateTime.getTime() - now.getTime();
  //   const hoursUntilBooking = timeDifference / (1000 * 60 * 60);

  //   return hoursUntilBooking < 24;
  // }
  isWithin24Hours(dateRequested, timeRequested = null) {
    return timezoneUtils.isWithin24Hours(dateRequested, timeRequested);
  }

  isDayRestricted(dateRequested, timeRequested = null) {
    return timezoneUtils.isDayRestricted(dateRequested, timeRequested);
  }

  // Helper method to check if date is weekend
  // isWeekend(dateRequested) {
  //   if (!dateRequested) return false;

  //   const requestedDate = new Date(dateRequested);
  //   const dayOfWeek = requestedDate.getDay();
  //   return dayOfWeek === 0 || dayOfWeek === 6; // Sunday = 0, Saturday = 6
  // }
  isWeekend(dateRequested) {
    return timezoneUtils.isWeekend(dateRequested);
  }

  // Helper method to get day name
  // getDayName(dateRequested) {
  //   if (!dateRequested) return null;

  //   const requestedDate = new Date(dateRequested);
  //   const days = [
  //     "Sunday",
  //     "Monday",
  //     "Tuesday",
  //     "Wednesday",
  //     "Thursday",
  //     "Friday",
  //     "Saturday",
  //   ];
  //   return days[requestedDate.getDay()];
  // }
  getDayName(dateRequested) {
    return timezoneUtils.getDayName(dateRequested);
  }

  // Helper method to update pending context
  updatePendingContext(userPhone, extractedDateTime) {
    console.log("Extracted datetime for update:", extractedDateTime);
    
    if (!this.pendingContext[userPhone]) {
      this.pendingContext[userPhone] = {};
    }

    if (extractedDateTime.date) {
      this.pendingContext[userPhone].date = extractedDateTime.date;
    }
    if (extractedDateTime.time) {
      this.pendingContext[userPhone].time = extractedDateTime.time;
    }
    console.log("Updating pending context for" , userPhone , ":" , this.pendingContext[userPhone]);  

  }

  // Helper method to clear pending context after action completion
  clearPendingContext(userPhone) {
    if (this.pendingContext[userPhone]) {
      delete this.pendingContext[userPhone];
      console.log(`🧹 Cleared pending context for ${userPhone}`);
    } else console.log(`🧼 No pending context to clear for ${userPhone}`);
  }

  // Helper method to generate system messages based on what's missing
  generateSystemMessage(completeness, availabilityInfo = null) {
    console.log("Generating system message with:", completeness, availabilityInfo);
    const { finalDate, finalTime } = completeness;
    console.log("Is it within 24hours" ,this.isWithin24Hours(finalDate, finalTime));
    // Check for 24-hour advance booking requirement first
    if (finalDate && this.isDayRestricted(finalDate, finalTime)) {
      return `\n\n[SYSTEM: Lessons cannot be booked less than 24 hours in advance. Please choose a date and time at least 24 hours from now.]`;
    }

    // Check for weekend booking
    if (finalDate && this.isWeekend(finalDate)) {
      const dayName = this.getDayName(finalDate);
      return `\n\n[SYSTEM: ${finalDate} falls on a ${dayName}. Weekend bookings are not available. Please choose a weekday (Monday-Friday).]`;
    }

    // Case 1: Have both date and time - show full availability
    if (finalDate && finalTime) {
      if (availabilityInfo?.isValidRequest) {
        let systemMsg = `\n\n[SYSTEM AVAILABILITY INFO for ${finalDate} at ${finalTime}:
- Requested slot available: ${
          availabilityInfo.requestedSlotAvailable ? "YES" : "NO"
        }
- Valid business day: ${availabilityInfo.isValidBusinessDay ? "YES" : "NO"}`;

        // Add weekend information if applicable
        if (!availabilityInfo.isValidBusinessDay) {
          const dayName = this.getDayName(finalDate);
          systemMsg += `\n- Note: ${finalDate} is a ${dayName} (weekend)`;
        }

        systemMsg += `
- Available times for ${finalDate}: ${
          availabilityInfo.availableSlotsForDate.length > 0
            ? availabilityInfo.availableSlotsForDate.join(", ")
            : "None"
        }
- All available times: ${availabilityInfo.allAvailableTimes.join(", ")}]`;

        return systemMsg;
      } else {
        const availableSlots = availabilityInfo?.availableSlotsForDate;

        if (!availableSlots?.length) {
          return `\n\n[SYSTEM AVAILABILITY INFO: No time slots are available for this date. Please choose a different date.]`;
        }

        return `\n\n[SYSTEM AVAILABILITY INFO: This time slot is not served by the instructor. Please pick a time slot from: ${availableSlots.join(
          ", "
        )}]`;
      }
    }

    // Case 2: Have date but no time - show available times for that date
    if (finalDate && !finalTime) {
      if (availabilityInfo?.availableSlotsForDate) {
        let systemMsg = `\n\n[SYSTEM AVAILABILITY INFO for ${finalDate}:`;

        // Add weekend information if applicable
        if (availabilityInfo.isValidBusinessDay === false) {
          const dayName = this.getDayName(finalDate);
          systemMsg += `\n- Note: ${finalDate} is a ${dayName} (weekend) - not available for bookings`;
        }

        systemMsg += `
- Available times: ${
          availabilityInfo.availableSlotsForDate.length > 0
            ? availabilityInfo.availableSlotsForDate.join(", ")
            : "None"
        }
- User needs to specify a time slot]`;

        return systemMsg;
      }
    }

    // Case 3: Have time but no date - prompt for date
    if (!finalDate && finalTime) {
      return `\n\n[SYSTEM: User specified time ${finalTime} but needs to provide a date (weekdays only - Monday to Friday)]`;
    }

    // Case 4: Have neither - prompt for both
    if (
      !finalDate &&
      !finalTime &&
      availabilityInfo?.availableSlotsForDate?.length > 0
    ) {
      return `\n\n[SYSTEM: User needs to specify both date and time for booking (weekdays only - Monday to Friday)]`;
    } else {
      return `\n\n[SYSTEM: User cannot proceed with booking as no available slots exist.]`;
    }

    return "";
  }

  async getResponse(userMessage, conversationHistory, userPhone) {
    try {
      console.log("Conversation history:", conversationHistory);
      const dateTimeInfoUnchecked =
        await dateTimeService.extractDateTimeFromMessage(userMessage);

      console.log("Pending context:", this.pendingContext);
      console.log("Extracted datetime (unchecked):", dateTimeInfoUnchecked);

      const dateTimeInfo = dateTimeUtils.sanitize(
        dateTimeInfoUnchecked,
        this.pendingContext[userPhone]
      );

      console.log("Sanitized datetime:", dateTimeInfo);

      let enhancedMessage = userMessage;
      let availabilityInfo = null;

      if (dateTimeInfo.hasDateTime) {
        this.updatePendingContext(userPhone, dateTimeInfo);
        const completeness = this.checkDateTimeCompleteness(
          dateTimeInfo,
          userPhone
        );
        console.log("DateTime completeness:", completeness);

        if (completeness.finalDate) {
          try {
            availabilityInfo = await this.getAvailabilityInfo(
              completeness.finalDate,
              completeness.finalTime,
              process.env.PHONE_NUMBER_ID,
              userPhone
            );
            console.log("Availability info:", availabilityInfo);
          } catch (error) {
            console.error("Error getting availability:", error);
          }
        }

        const systemMessage = this.generateSystemMessage(
          completeness,
          availabilityInfo
        );
        enhancedMessage += systemMessage;
      }

      console.log("Enhanced message:", enhancedMessage);

      const systemPrompt = await this.getSystemPrompt(
        process.env.PHONE_NUMBER_ID
      );
      const today = `(${
        process.env.APP_TIMEZONE || "Asia/Kolkata"
      }): ${timezoneUtils.getCurrentDateString()}`;

      // const nextAvailableDate = (() => {
      //   const now = new Date(timezoneUtils.getCurrentDate());
      //   const next = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      //   let dayOfWeek = next.getDay();

      //   if (dayOfWeek === 0 || dayOfWeek === 6) {
      //     const daysToAdd = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
      //     next.setDate(next.getDate() + daysToAdd);
      //   }

      //   const dayName = next.toLocaleDateString("en-US", { weekday: "long" });
      //   const month = next.toLocaleDateString("en-US", { month: "long" });
      //   const day = next.getDate();
      //   const year = next.getFullYear();

      //   const getOrdinal = (n) => {
      //     const s = ["th", "st", "nd", "rd"];
      //     const v = n % 100;
      //     return n + (s[(v - 20) % 10] || s[v] || s[0]);
      //   };

      //   return `${dayName}, ${month} ${getOrdinal(day)}, ${year}`;
      // })();

      const nextAvailableDate = (() => {
        const now = new Date(timezoneUtils.getCurrentDate());
        // The key change is here: add 2 days instead of 1
        const next = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
        let dayOfWeek = next.getDay();

        // This weekend logic still works perfectly
        if (dayOfWeek === 0 || dayOfWeek === 6) {
          // 0 = Sunday, 6 = Saturday
          const daysToAdd = dayOfWeek === 0 ? 1 : 2; // If Sunday, add 1 day to get Monday. If Saturday, add 2 days.
          next.setDate(next.getDate() + daysToAdd);
        }

        const dayName = next.toLocaleDateString("en-US", { weekday: "long" });
        const month = next.toLocaleDateString("en-US", { month: "long" });
        const day = next.getDate();
        const year = next.getFullYear();

        const getOrdinal = (n) => {
          const s = ["th", "st", "nd", "rd"];
          const v = n % 100;
          return n + (s[(v - 20) % 10] || s[v] || s[0]);
        };

        return `${dayName}, ${month} ${getOrdinal(day)}, ${year}`;
      })();
      console.log("Today:", today);
      console.log("Next available booking date:", nextAvailableDate);

      // **KEY CHANGE: Building conversation for Gemini**
      const conversationText = this.buildConversationForGemini(
        systemPrompt,
        today,
        nextAvailableDate,
        conversationHistory,
        enhancedMessage
      );

      console.log(
        "Sending to Gemini:",
        conversationText.substring(0, 500) + "..."
      );

      // **Gemini API call**
      const result = await model.generateContent(conversationText);
      const response = result.response;
      const text = response.text();

      console.log("🤖 Gemini response:", text);
      return text;
    } catch (error) {
      console.error("Error getting Gemini response:", error);
      throw error;
    }
  }

  buildConversationForGemini(
    systemPrompt,
    today,
    nextAvailableDate,
    conversationHistory,
    userMessage
  ) {
    let conversation = `${systemPrompt}\n\n`;
    conversation += `TODAY's date: ${today}\n\n`;
    // conversation += `[nextAvailableDate]: ${nextAvailableDate}\n\n`;

    conversation += "CONVERSATION HISTORY:\n";
    conversationHistory.forEach((msg, index) => {
      const role = msg.role === "user" ? "User" : "Assistant";
      conversation += `${role}: ${msg.content}\n`;
    });

    conversation += `\nUser: ${userMessage}\n\n`;
    conversation += "Assistant: ";

    return conversation;
  }

  async getAvailabilityInfo(dateRequested, timeRequested, instructorId , userPhone) {
    try {
      const instructor = require("../../models/instructorModel").getInstructor(
        instructorId
      );
      if (!instructor) {
        return {
          error: "Instructor not found",
          isValidRequest: false,
        };
      }

      // If time is provided, check if it's in available times
      // if (timeRequested && !instructor.availableTimes.includes(timeRequested)) {
      //   return {
      //     isValidRequest: false,
      //     requestedSlotAvailable: false,
      //     message: `${timeRequested} is not an available time slot.`,
      //     allAvailableTimes: instructor.availableTimes,
      //     availableSlotsForDate: [],
      //   };
      // }

      // Get available slots for the date
      let availableSlotsForDate =
        await calendarService.getAvailableTimeSlotsForDate(
          dateRequested,
          instructorId
        );
      
      const routeOptimizer = new RouteOptimizer();
      const filteredAvailableSlots =  await routeOptimizer.filterAvailableSlotsByLocation(
        availableSlotsForDate,
        dateRequested,
        instructorId,
        userPhone
      );


      console.log("Filtered available slots:", filteredAvailableSlots);

      availableSlotsForDate = filteredAvailableSlots;
      // return;
      // const requestedDate = new Date(dateRequested);
      // const isWeekend =
      //   requestedDate.getDay() === 0 || requestedDate.getDay() === 6;
      const isWeekend = timezoneUtils.isWeekend(dateRequested);
      const isValidBusinessDay = !isWeekend;

      // If specific time is requested, check its availability
      let slotAvailability = { isAvailable: null };
      if (timeRequested) {
        slotAvailability = await calendarService.checkAvailability(
          dateRequested,
          timeRequested,
          instructorId
        );
      }

      console.log("THINGS TO CHECK");
      console.log("Slot availability:", slotAvailability);  
      console.log("Available slots for date:", availableSlotsForDate);
      return {
        isValidRequest: true,
        requestedDate: dateRequested,
        requestedTime: timeRequested,
        requestedSlotAvailable: timeRequested
          ? slotAvailability.isAvailable
          : null,
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
      hasAction: false,
      actionType: null,
      bookingData: null,
      responseText: aiResponse,
    };

    const actionMatch = aiResponse.match(
      /\[ACTION:(BOOK|UPDATE_BOOKING|CANCEL_BOOKING|SHOW_BOOKINGS|NEXT_AVAILABLE_SLOT|NULL)\]\s*({.*?})?/s
    );

    if (actionMatch) {
      try {
        result.actionType = actionMatch[1].toLowerCase();
        result.hasAction = true;

        if (actionMatch[2]) {
          result.bookingData = JSON.parse(actionMatch[2]);
        }

        result.responseText = aiResponse
          .replace(
            /\[ACTION:(BOOK|UPDATE_BOOKING|CANCEL_BOOKING|SHOW_BOOKINGS|NEXT_AVAILABLE_SLOT|NULL)\].*$/s,
            ""
          )
          .trim();
      } catch (error) {
        console.error("Error parsing action JSON:", error);
      }
    } else {
      console.log("NO ACTION FOUND");
    }

    return result;
  }
}

module.exports = new AIService();
