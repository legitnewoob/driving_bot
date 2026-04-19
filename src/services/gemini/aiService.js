const { model } = require("../../config/gemini");
const calendarService = require("../calendarService");
const dateTimeService = require("./dateTimeService");
const dateTimeUtils = require("../../utils/dateTimeUtils");
const timezoneUtils = require("../../utils/timezoneUtils");
const routeOptimizer = require("../routeOptimizer");
const { getInstructor } = require("../../models/instructorModel");
const fs = require("fs");
const path = require("path");

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const VALID_BOOKING_TIMES = ["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"];

// Max age (ms) before a user's pending context is considered stale
const PENDING_CONTEXT_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

/**
 * Returns the next available booking date (at least 24h from now, weekday only).
 * "Next available" = 2 calendar days ahead to stay safely outside 24h window.
 */
function computeNextAvailableDate() {
  let dateStr = timezoneUtils.addDays(timezoneUtils.getCurrentDateString(), 2);

  // Skip weekends
  while (timezoneUtils.isWeekend(dateStr)) {
    dateStr = timezoneUtils.addDays(dateStr, 1);
  }

  const getOrdinal = (n) => {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  const d = timezoneUtils.createDateInTimezone(dateStr, "12:00");
  const dayName = d.toLocaleDateString("en-US", { weekday: "long" });
  const month = d.toLocaleDateString("en-US", { month: "long" });
  return `${dayName}, ${month} ${getOrdinal(d.getDate())}, ${d.getFullYear()}`;
}

/**
 * Checks whether a time string (HH:MM) is one of the allowed booking slots.
 */
function isValidBookingTime(time) {
  if (!time) return false;
  return VALID_BOOKING_TIMES.includes(time);
}

// ─────────────────────────────────────────────
// SERVICE CLASS
// ─────────────────────────────────────────────

class AIService {
  constructor() {
    // Temporary store keyed by user phone number.
    // Holds partially collected date/time across turns.
    this.pendingContext = {};

    // Cache the system prompt (read once from disk)
    this._systemPromptRaw = fs.readFileSync(
      path.join(__dirname, "../../../", "SYSTEM_PROMPT.txt"),
      "utf-8"
    );
  }

  // ── System Prompt ──────────────────────────

  getSystemPrompt(instructorId) {
    return this._systemPromptRaw.replaceAll("{{INSTRUCTOR_NAME}}", process.env.INSTRUCTOR_NAME);
  }

  // ── Pending Context Helpers ────────────────

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
    this.pendingContext[userPhone]._updatedAt = Date.now();

    // Prune stale entries to prevent unbounded memory growth
    this._pruneStaleContexts();

    console.log(`Pending context for ${userPhone}:`, this.pendingContext[userPhone]);
  }

  _pruneStaleContexts() {
    const now = Date.now();
    for (const phone of Object.keys(this.pendingContext)) {
      if (now - (this.pendingContext[phone]._updatedAt || 0) > PENDING_CONTEXT_TTL_MS) {
        delete this.pendingContext[phone];
      }
    }
  }

  clearPendingContext(userPhone) {
    if (this.pendingContext[userPhone]) {
      delete this.pendingContext[userPhone];
      console.log(`🧹 Cleared pending context for ${userPhone}`);
    }
  }

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

  // ── Date/Time Validation Delegates ────────

  isWithin24Hours(date, time = null) {
    return timezoneUtils.isWithin24Hours(date, time);
  }

  isDayRestricted(date, time = null) {
    return timezoneUtils.isDayRestricted(date, time);
  }

  isWeekend(date) {
    return timezoneUtils.isWeekend(date);
  }

  getDayName(date) {
    return timezoneUtils.getDayName(date);
  }

  // ── System Message Builder ─────────────────

  /**
   * Builds the [SYSTEM ...] block appended to the user message so the AI
   * has full context about slot availability.
   *
   * ORDER OF CHECKS:
   *  1. Requested time is not a valid slot → reject immediately
   *  2. Date is within 24h / restricted    → reject
   *  3. Date is a weekend                  → reject
   *  4. Both date + time present           → show full availability
   *  5. Date only                          → show available times for that date
   *  6. Time only                          → ask for date
   *  7. Neither                            → ask for both
   */
  generateSystemMessage(completeness, availabilityInfo = null) {
    console.log("Generating system message:", completeness, availabilityInfo);
    const { finalDate, finalTime } = completeness;

    // ── CHECK 1: Is the requested time a valid slot? ──
    if (finalTime && !isValidBookingTime(finalTime)) {
      return (
        `\n\n[SYSTEM: The time ${finalTime} is not an available booking slot. ` +
        `Valid times are: ${VALID_BOOKING_TIMES.join(", ")}. ` +
        `Please ask the user to choose one of these times. Do NOT book or suggest rounding.]`
      );
    }

    // ── CHECK 2: Within 24h / restricted? ──
    if (finalDate && this.isDayRestricted(finalDate, finalTime)) {
      return `\n\n[SYSTEM: Lessons cannot be booked less than 24 hours in advance. Please choose a date and time at least 24 hours from now.]`;
    }

    // ── CHECK 3: Weekend? ──
    if (finalDate && this.isWeekend(finalDate)) {
      const dayName = this.getDayName(finalDate);
      return `\n\n[SYSTEM: ${finalDate} falls on a ${dayName}. Weekend bookings are not available. Please choose a weekday (Monday–Friday).]`;
    }

    // ── CHECK 4: Both date + time ──
    if (finalDate && finalTime) {
      if (availabilityInfo?.isValidRequest) {
        let msg = `\n\n[SYSTEM AVAILABILITY INFO for ${finalDate} at ${finalTime}:
- Requested slot available: ${availabilityInfo.requestedSlotAvailable ? "YES" : "NO"}
- Valid business day: ${availabilityInfo.isValidBusinessDay ? "YES" : "NO"}`;

        if (!availabilityInfo.isValidBusinessDay) {
          msg += `\n- Note: ${finalDate} is a ${this.getDayName(finalDate)} (weekend)`;
        }

        msg += `
- Available times for ${finalDate}: ${
          availabilityInfo.availableSlotsForDate.length > 0
            ? availabilityInfo.availableSlotsForDate.join(", ")
            : "None"
        }
- All available times: ${availabilityInfo.allAvailableTimes.join(", ")}]`;

        return msg;
      }

      // availabilityInfo is present but isValidRequest = false
      const slots = availabilityInfo?.availableSlotsForDate;
      if (!slots?.length) {
        return `\n\n[SYSTEM AVAILABILITY INFO: No time slots are available for this date. Please choose a different date.]`;
      }
      return (
        `\n\n[SYSTEM AVAILABILITY INFO: This time slot is not served by the instructor. ` +
        `Please pick a time slot from: ${slots.join(", ")}]`
      );
    }

    // ── CHECK 5: Date only ──
    if (finalDate && !finalTime) {
      if (availabilityInfo?.availableSlotsForDate) {
        let msg = `\n\n[SYSTEM AVAILABILITY INFO for ${finalDate}:`;
        if (availabilityInfo.isValidBusinessDay === false) {
          msg += `\n- Note: ${finalDate} is a ${this.getDayName(finalDate)} (weekend) – not available`;
        }
        msg += `
- Available times: ${
          availabilityInfo.availableSlotsForDate.length > 0
            ? availabilityInfo.availableSlotsForDate.join(", ")
            : "None"
        }
- User needs to specify a time slot]`;
        return msg;
      }
    }

    // ── CHECK 6: Time only ──
    if (!finalDate && finalTime) {
      return `\n\n[SYSTEM: User specified time ${finalTime} but needs to provide a date (weekdays only – Monday to Friday)]`;
    }

    // ── CHECK 7: Neither ──
    if (availabilityInfo?.availableSlotsForDate?.length > 0) {
      return `\n\n[SYSTEM: User needs to specify both date and time for booking (weekdays only – Monday to Friday)]`;
    }

    return `\n\n[SYSTEM: User cannot proceed with booking as no available slots exist.]`;
  }

  // ── Availability Info Fetcher ──────────────

  async getAvailabilityInfo(dateRequested, timeRequested, instructorId, userPhone) {
    try {
      const instructor = getInstructor(instructorId);
      if (!instructor) {
        return { error: "Instructor not found", isValidRequest: false };
      }

      // Early-exit: reject times not in the allowed list BEFORE hitting the calendar
      if (timeRequested && !isValidBookingTime(timeRequested)) {
        return {
          isValidRequest: false,
          requestedSlotAvailable: false,
          message: `${timeRequested} is not an available time slot.`,
          allAvailableTimes: instructor.availableTimes,
          availableSlotsForDate: [],
        };
      }

      const availableSlotsForDate = await calendarService.getAvailableTimeSlotsForDate(
        dateRequested,
        instructorId
      );

      console.log("Available slots for date: (pre-optimization): ", availableSlotsForDate);

      // ROUTE OPTIMIZATION
      const optimizedSlots = await routeOptimizer.filterAvailableSlotsByLocation(
        availableSlotsForDate,
        dateRequested,
        instructorId,
        userPhone
      );

      console.log("Available slots for date (post-optimization): ", optimizedSlots);

      const isValidBusinessDay = !timezoneUtils.isWeekend(dateRequested);

      // Check against calendar truth (not route-optimized list), so a genuinely
      // available slot isn't incorrectly reported as unavailable just because the
      // route optimizer deprioritised it.
      const requestedSlotAvailable = timeRequested
        ? availableSlotsForDate.includes(timeRequested)
        : null;

      console.log("Requested slot available:", requestedSlotAvailable);
      console.log("Available slots for date:", optimizedSlots);

      return {
        isValidRequest: true,
        requestedDate: dateRequested,
        requestedTime: timeRequested,
        requestedSlotAvailable,
        isValidBusinessDay,
        availableSlotsForDate: optimizedSlots,
        allAvailableTimes: instructor.availableTimes,
      };
    } catch (error) {
      console.error("❌ Error getting availability info:", error);
      return { error: error.message, isValidRequest: false };
    }
  }

  // ── Main Response Handler ──────────────────

  async getResponse(userMessage, conversationHistory, userPhone) {
    try {
      console.log("Conversation history:", conversationHistory);

      // 1. Extract and sanitize date/time from the user's message
      const rawDateTime = await dateTimeService.extractDateTimeFromMessage(userMessage);
      console.log("Pending context:", this.pendingContext);
      console.log("Extracted datetime (raw):", rawDateTime);

      const dateTimeInfo = dateTimeUtils.sanitize(rawDateTime, this.pendingContext[userPhone]);
      console.log("Sanitized datetime:", dateTimeInfo);

      // 2. Build enhanced message with system availability context
      let enhancedMessage = userMessage;

      if (dateTimeInfo.hasDateTime) {
        this.updatePendingContext(userPhone, dateTimeInfo);
        const completeness = this.checkDateTimeCompleteness(dateTimeInfo, userPhone);
        console.log("DateTime completeness:", completeness);

        let availabilityInfo = null;
        if (completeness.finalDate) {
          try {
            availabilityInfo = await this.getAvailabilityInfo(
              completeness.finalDate,
              completeness.finalTime,
              process.env.PHONE_NUMBER_ID,
              userPhone
            );
            console.log("Availability info:", availabilityInfo);
          } catch (err) {
            console.error("Error getting availability:", err);
          }
        }

        enhancedMessage += this.generateSystemMessage(completeness, availabilityInfo);
      }

      console.log("Enhanced message:", enhancedMessage);

      // 3. Build prompt and call Gemini
      const systemPrompt = this.getSystemPrompt(process.env.PHONE_NUMBER_ID);
      const today = `(${process.env.APP_TIMEZONE || "Asia/Kolkata"}): ${timezoneUtils.getCurrentDateString()}`;
      const nextAvailableDate = computeNextAvailableDate();

      console.log("Today:", today);
      console.log("Next available booking date:", nextAvailableDate);

      const conversationText = this.buildConversationForGemini(
        systemPrompt,
        today,
        nextAvailableDate,
        conversationHistory,
        enhancedMessage
      );

      console.log("Sending to Gemini:", conversationText.substring(0, 500) + "...");

      const result = await model.generateContent(conversationText);
      const text = result.response.text();
      console.log("🤖 Gemini response:", text);

      return text;
    } catch (error) {
      console.error("Error getting Gemini response:", error);
      throw error;
    }
  }

  // ── Conversation Builder ───────────────────

  buildConversationForGemini(
    systemPrompt,
    today,
    nextAvailableDate,
    conversationHistory,
    userMessage
  ) {
    let conv = `${systemPrompt}\n\nTODAY's date: ${today}\n\nCONVERSATION HISTORY:\n`;

    conversationHistory.forEach((msg) => {
      const role = msg.role === "user" ? "User" : "Assistant";
      conv += `${role}: ${msg.content}\n`;
    });

    conv += `\nUser: ${userMessage}\n\nAssistant: `;
    return conv;
  }

  // ── Action Extractor ───────────────────────

  extractActions(aiResponse) {
    const result = {
      hasAction: false,
      actionType: null,
      bookingData: null,
      responseText: aiResponse,
    };

    const ACTION_REGEX =
      /\[ACTION:(BOOK|UPDATE_BOOKING|CANCEL_BOOKING|SHOW_BOOKINGS|NEXT_AVAILABLE_SLOT|NULL)\]\s*({[\s\S]*?})?\s*$/;

    const match = aiResponse.match(ACTION_REGEX);

    if (!match) {
      console.log("NO ACTION FOUND in AI response");
      return result;
    }

    try {
      result.actionType = match[1].toLowerCase();
      result.hasAction = true;

      if (match[2]) {
        result.bookingData = JSON.parse(match[2]);
      }

      // Strip the action block from the user-facing text
      result.responseText = aiResponse.replace(ACTION_REGEX, "").trim();
    } catch (error) {
      console.error("Error parsing action JSON:", error, "Raw match:", match[2]);
    }

    return result;
  }
}

module.exports = new AIService();