const { model } = require("../../config/gemini");
const calendarService = require("../calendarService");
const dateTimeService = require("./dateTimeService");
const dateTimeUtils = require("../../utils/dateTimeUtils");
const timezoneUtils = require("../../utils/timezoneUtils");
const routeOptimizer = require("../routeOptimizer");
const { getCoordinatesFromPostalCode } = require("../mapsService");
const logger = require("../../utils/logger-advanced");
const fs = require("fs");
const path = require("path");

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const DEFAULT_BOOKING_TIMES = ["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"];

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
function isValidBookingTime(time, validTimes) {
  if (!time) return false;
  return (validTimes || DEFAULT_BOOKING_TIMES).includes(time);
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

  getSystemPrompt(instructor) {
    return this._systemPromptRaw.replaceAll("{{INSTRUCTOR_NAME}}", instructor.name || "");
  }

  // ── Pending Context Helpers ────────────────

  updatePendingContext(userPhone, extractedDateTime) {
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

    logger.info(`Pending context updated for ${userPhone}: date=${this.pendingContext[userPhone].date}, time=${this.pendingContext[userPhone].time}`);
  }

  /**
   * Stores pickup/drop-off addresses (and lazily geocoded coordinates) in
   * pending context so subsequent slot scoring can use the real pickup
   * location instead of the user's profile postal code.
   *
   * Coordinates are computed lazily on first read in getAvailabilityInfo to
   * avoid extra Maps API calls when the user is just chatting.
   */
  updatePendingPickupDropoff(userPhone, { pickupAddress, dropoffAddress } = {}) {
    if (!pickupAddress && !dropoffAddress) return;

    if (!this.pendingContext[userPhone]) {
      this.pendingContext[userPhone] = {};
    }
    const ctx = this.pendingContext[userPhone];

    if (pickupAddress && pickupAddress !== ctx.pickupAddress) {
      ctx.pickupAddress = pickupAddress;
      ctx.pickupCoords = null; // invalidate any stale geocoding
    }
    if (dropoffAddress && dropoffAddress !== ctx.dropoffAddress) {
      ctx.dropoffAddress = dropoffAddress;
      ctx.dropoffCoords = null;
    }
    ctx._updatedAt = Date.now();

    logger.info(
      `Pending pickup/dropoff updated for ${userPhone}: ` +
      `pickup="${ctx.pickupAddress || ""}", dropoff="${ctx.dropoffAddress || ""}"`
    );
  }

  /**
   * Returns geocoded pickup coords for a user from pendingContext, or null.
   * Geocodes lazily on first call and caches the result on the context.
   */
  async _getPendingPickupCoords(userPhone) {
    const ctx = this.pendingContext[userPhone];
    if (!ctx?.pickupAddress) return null;
    if (ctx.pickupCoords) return ctx.pickupCoords;

    try {
      const geo = await getCoordinatesFromPostalCode(ctx.pickupAddress);
      ctx.pickupCoords = { lat: geo.lat, long: geo.lng };
      return ctx.pickupCoords;
    } catch (err) {
      logger.warn(
        `Geocoding pending pickup "${ctx.pickupAddress}" failed for ${userPhone}: ${err.message}`
      );
      return null;
    }
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
      logger.info(`Cleared pending context for ${userPhone}`);
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
    const { finalDate, finalTime } = completeness;

    // ── CHECK 1: Is the requested time a valid slot? ──
    const validTimes = this._currentInstructorTimes || DEFAULT_BOOKING_TIMES;
    if (finalTime && !isValidBookingTime(finalTime, validTimes)) {
      return (
        `\n\n[SYSTEM: The time ${finalTime} is not an available booking slot. ` +
        `Valid times are: ${validTimes.join(", ")}. ` +
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

  async getAvailabilityInfo(dateRequested, timeRequested, instructor, userPhone) {
    try {
      if (!instructor) {
        return { error: "Instructor not found", isValidRequest: false };
      }

      // Early-exit: reject times not in the allowed list BEFORE hitting the calendar
      if (timeRequested && !isValidBookingTime(timeRequested, instructor.availableTimes)) {
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
        instructor
      );

      logger.info(`Slots for ${dateRequested} (pre-optimization): [${availableSlotsForDate}]`);

      // ROUTE OPTIMIZATION
      // If the user has already given a pickup address in this conversation,
      // use those coords (geocoded lazily) instead of their profile location.
      const pickupCoords = await this._getPendingPickupCoords(userPhone);

      const optimizedSlots = await routeOptimizer.filterAvailableSlotsByLocation(
        availableSlotsForDate,
        dateRequested,
        instructor,
        userPhone,
        pickupCoords
      );

      logger.info(`Slots for ${dateRequested} (post-optimization): [${optimizedSlots}]`);

      const isValidBusinessDay = !timezoneUtils.isWeekend(dateRequested);

      // Check against calendar truth (not route-optimized list), so a genuinely
      // available slot isn't incorrectly reported as unavailable just because the
      // route optimizer deprioritised it.
      const requestedSlotAvailable = timeRequested
        ? availableSlotsForDate.includes(timeRequested)
        : null;

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
      logger.error(`Error getting availability info: ${error.message}`);
      return { error: error.message, isValidRequest: false };
    }
  }

  // ── Main Response Handler ──────────────────

  async getResponse(userMessage, conversationHistory, userPhone, instructor) {
    try {
      // Store instructor times for use in generateSystemMessage
      this._currentInstructorTimes = instructor?.availableTimes || DEFAULT_BOOKING_TIMES;

      // 1. Extract and sanitize date/time from the user's message
      const rawDateTime = await dateTimeService.extractDateTimeFromMessage(userMessage);
      const dateTimeInfo = dateTimeUtils.sanitize(rawDateTime, this.pendingContext[userPhone]);
      logger.info(`DateTime extraction for ${userPhone}: date=${dateTimeInfo.date}, time=${dateTimeInfo.time}, hasDateTime=${dateTimeInfo.hasDateTime}`);

      // 2. Build enhanced message with system availability context
      let enhancedMessage = userMessage;

      if (dateTimeInfo.hasDateTime) {
        this.updatePendingContext(userPhone, dateTimeInfo);
        const completeness = this.checkDateTimeCompleteness(dateTimeInfo, userPhone);

        let availabilityInfo = null;
        if (completeness.finalDate) {
          try {
            availabilityInfo = await this.getAvailabilityInfo(
              completeness.finalDate,
              completeness.finalTime,
              instructor,
              userPhone
            );
          } catch (err) {
            logger.error(`Error getting availability for ${userPhone}: ${err.message}`);
          }
        }

        enhancedMessage += this.generateSystemMessage(completeness, availabilityInfo);
      }

      // 3. Build prompt and call Gemini
      const systemPrompt = this.getSystemPrompt(instructor);
      const timezone = instructor?.timezone || process.env.APP_TIMEZONE || "Asia/Kolkata";
      const today = `(${timezone}): ${timezoneUtils.getCurrentDateString()}`;
      const nextAvailableDate = computeNextAvailableDate();

      const conversationText = this.buildConversationForGemini(
        systemPrompt,
        today,
        nextAvailableDate,
        conversationHistory,
        enhancedMessage
      );

      const result = await model.generateContent(conversationText);
      const text = result.response.text();
      logger.info(`Gemini response for ${userPhone} (${text.length} chars)`);

      return text;
    } catch (error) {
      logger.error(`Error getting Gemini response: ${error.message}`);
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
      logger.error(`Error parsing action JSON: ${error.message}, raw: ${match[2]}`);
    }

    return result;
  }
}

module.exports = new AIService();