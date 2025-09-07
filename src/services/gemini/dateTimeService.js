const { model } = require("../../config/gemini");
const timezoneUtils = require("../../utils/timezoneUtils");

class DateTimeService {
  static async extractDateTimeFromMessage(message) {
    console.log(`🔍 Extracting date/time from: "${message}"`);

    // Input validation
    if (!message || typeof message !== "string") {
      console.log("❌ Invalid message input");
      return this.getDefaultResult();
    }

    const today = timezoneUtils.getCurrentDate();
    const todayStr = timezoneUtils.getCurrentDateString();
    const currentTime = timezoneUtils.getCurrentTimeString();

    try {
      // Try local extraction first
      const localResult = this.fallbackExtraction(message);
      if (
        localResult &&
        localResult.hasDateTime &&
        localResult.confidence === "high"
      ) {
        console.log("✅ Using local extraction (high confidence)");
        return localResult;
      }

      // Use Gemini for complex cases
      const tomorrowStr = timezoneUtils.getTomorrowDateString();
      const currentTimezone = process.env.APP_TIMEZONE || "Asia/Kolkata";
      const currentDay = timezoneUtils.getCurrentDay();
      const currentDate = timezoneUtils.getCurrentDate();
      console.log("Current date:", currentDate);
      //    const prompt = `Extract date and time from this message. Current context (${currentTimezone}): ${todayStr} ${currentTime}

      // Message: "${message}"

      // Rules:
      // 1. Only extract explicitly mentioned dates/times
      // 2. For day numbers without month (like "17th"):
      //    - If date >= current date : (${currentDate}), assume it is in the current month (${todayStr}).
      //    - If date < current date : (${currentDate}), roll over to next month.
      //    - If message says "this [date number]" → ALWAYS use the current month, even if day < current day.
      // 3. Relative terms: today=${todayStr}, tomorrow=${tomorrowStr}
      // 4. Time approximations: morning=09:00, afternoon=14:00, evening=19:00, night=21:00
      // 5. If no clear date/time, return hasDateTime=false
      // 6. All times should be in 24-hour format (HH:MM)
      // 7. Weekdays (e.g. Monday, Tuesday, etc.): resolve to the next occurrence of that weekday after today (${todayStr}).
      // 8. If it says "next [weekday]", interpret as the weekday in the following week.

      // You must respond with ONLY valid JSON in this exact format:
      // {
      //   "hasDateTime": true or false,
      //   "date": "YYYY-MM-DD" or null,
      //   "time": "HH:MM" or null,
      //   "confidence": "high" or "medium" or "low",
      //   "explicitDate": true or false,
      //   "explicitTime": true or false
      // }

      // Be conservative - only extract clear, unambiguous date/time references.`;

      const linebreak = "\n";

      //    const prompt = `Extract date and time from this message. Your task is to act as a highly accurate date/time parser.

      //     Current Context (${currentTimezone}):
      //     - Today's Date: ${todayStr}
      //     - Current Time: ${currentTime}

      //     Message: "${message}"

      //     RULES:
      //     1.  **Crucial Rule for Day Numbers:** When a day number (e.g., "2nd", "17th") is mentioned without a month: If that day has already passed in the current month, YOU MUST assume it refers to the NEXT month. Otherwise, use the current month.
      //     2.  **Relative Terms:** Interpret "today" as ${todayStr} and "tomorrow" as ${tomorrowStr}.
      //     3.  **Weekdays:** Resolve a weekday (e.g., Monday) to the next upcoming occurrence of that day. "Next Monday" means the Monday of the following week.
      //     4.  **No Ambiguous Extraction:** If no clear date or time is mentioned, set "hasDateTime" to false.

      //     EXAMPLES:
      //     -   Current Date: 2025-09-06. Message: "Let's meet on the 2nd".
      //         -   Correct Output: {"hasDateTime": true, "date": "2025-10-02", "time": null, ...} (because Sep 2nd has passed)
      //     -   Current Date: 2025-09-06. Message: "What about the 15th?".
      //         -   Correct Output: {"hasDateTime": true, "date": "2025-09-15", "time": null, ...} (because Sep 15th has not passed)
      //     -   Current Date: 2025-09-06. Message: "Let's do Tuesday".
      //         -   Correct Output: {"hasDateTime": true, "date": "2025-09-09", "time": null, ...} (the next upcoming Tuesday)

      //     You must respond with ONLY valid JSON in this exact format:
      //     {
      //       "hasDateTime": true or false,
      //       "date": "YYYY-MM-DD" or null,
      //       "time": "HH:MM" or null,
      //       "confidence": "high" or "medium" or "low",
      //       "explicitDate": true or false,
      //       "explicitTime": true or false
      //     }`;

      // Inside your DateTimeService.js, replace the old prompt with this one.
      const linebreak2 = "\n\n";

      // const prompt = `You are a highly accurate and intelligent date/time parsing assistant. Extract the date and time from the user's message based on the provided context and rules.

      // Current Context (${currentTimezone}):
      // - Today's Date: ${todayStr} (It is a ${currentDay})
      // - Current Time: ${currentTime}

      // Message: "${message}"

      // RULES:
      // 1.  **Compound Extraction:** If a day and a time of day are mentioned (e.g., "Monday morning"), you MUST extract both the date for that day and the corresponding time.
      // 2.  **Day Number Rollover:** When a day number (e.g., "2nd", "17th") is mentioned without a month: if that day has already passed in the current month, YOU MUST assume it refers to the NEXT month. Otherwise, use the current month.
      // 3.  **Weekday Resolution:**
      //     -   A weekday ("Monday", "Tuesday") refers to the next upcoming occurrence of that day.
      //     -   "Next [weekday]" (e.g., "next Monday") refers to the weekday in the *following* week (i.e., not the one coming up in a few days, but the one after that).
      // 4.  **Time Approximations:** Use these values for vague times: morning=09:00, afternoon=14:00, evening=19:00, night=21:00.
      // 5.  **Confidence Score:** Use the 'confidence' field to indicate ambiguity. If the user says "sometime next week", the date is not explicit, so confidence should be 'medium' or 'low'. If they say "next Tuesday at 4pm", it is very explicit, so confidence should be 'high'.
      // 6.  **No Date/Time:** If the message contains no reference to a date or time, set "hasDateTime" to false.

      // EXAMPLES:
      // -   Current Date: 2025-09-06 (Saturday). Message: "Let's meet on the 2nd".
      //     -   Correct Output: {"date": "2025-10-02", "confidence": "high", ...} (Rule #2: Sep 2nd has passed)
      // -   Current Date: 2025-09-06 (Saturday). Message: "How about Tuesday morning?".
      //     -   Correct Output: {"date": "2025-09-09", "time": "09:00", "confidence": "high", ...} (Rule #1, #3: next Tuesday is the 9th)
      // -   Current Date: 2025-09-06 (Saturday). Message: "Let's plan for next Monday afternoon".
      //     -   Correct Output: {"date": "2025-09-15", "time": "14:00", "confidence": "high", ...} (Rule #3: "next Monday" is in the following week)
      // -   Current Date: 2025-09-06 (Saturday). Message: "Are you free this evening?".
      //     -   Correct Output: {"date": "2025-09-06", "time": "19:00", "confidence": "high", ...} ("this" refers to today)
      // -   Current Date: 2025-09-06 (Saturday). Message: "Let's touch base sometime next week".
      //     -   Correct Output: {"date": "2025-09-15", "time": null, "confidence": "medium", ...} (Rule #5: "next week" is vague, resolves to Monday but with medium confidence)
      // -   Current Date: 2025-09-06 (Saturday). Message: "Do you have a moment to chat?".
      //     -   Correct Output: {"hasDateTime": false, "date": null, "time": null, "confidence": "low", ...} (Rule #6: No date/time info)

      // You must respond with ONLY valid JSON in this exact format:
      // {
      //   "hasDateTime": true or false,
      //   "date": "YYYY-MM-DD" or null,
      //   "time": "HH:MM" or null,
      //   "confidence": "high" or "medium" or "low",
      //   "explicitDate": true or false,
      //   "explicitTime": true or false
      // }`;
      const dateHint = this.generateDateHint(message, today);
      console.log(`💡 Generated Hint: "${dateHint}"`);
      // 4.  **explicitDate:** Set to true only if the date / day is clearly and specifically mentioned in the message.

      const prompt = `You are a date/time parsing assistant. Your task is to extract date and time from the message below.

Current Context:
- Today's Date: ${todayStr}
- Today's Day: ${currentDay}

*** CRITICAL HINT - YOU MUST FOLLOW THIS ***
${dateHint}
***

Message: "${message}"

RULES:
1.  **Follow the Hint:** The Hint provides the definitive logic for handling day numbers. It overrides all other assumptions.
2.  **No Date/Time:** If the message has no date/time info and the hint is not applicable, set "hasDateTime" to false.
3.  **Time Approximations:** Use these values for vague times: morning=09:00, afternoon=14:00, evening=19:00, night=21:00.
4. explicitDate: Set to true if the message resolves to a single, unambiguous calendar date (like "tomorrow" or "next Monday"). Set it to false only for vague date ranges (like "sometime next week" or "in a few days").
5.  **explicitTime:** Set to true only if the time is clearly and specifically mentioned in the message.
You must respond with ONLY valid JSON in this exact format:
{
  "hasDateTime": true or false,
  "date": "YYYY-MM-DD" or null,
  "time": "HH:MM" or null,
  "confidence": "high" or "medium",
  "reasoning": "A brief explanation of your logic, confirming you followed the hint.",
  "explicitDate": true or false,
  "explicitTime": true or false
}
`;
      console.log("🤖 Sending to Gemini for datetime extraction");

      // Check if model is available
      if (!model) {
        console.log("❌ Gemini model not available, using fallback");
        return this.fallbackExtraction(message);
      }

      const result_gemini = await model.generateContent(prompt);

      if (!result_gemini || !result_gemini.response) {
        console.log("❌ Invalid Gemini response, using fallback");
        return this.fallbackExtraction(message);
      }

      const response = result_gemini.response;
      const content = response.text();

      if (!content) {
        console.log("❌ Empty Gemini response, using fallback");
        return this.fallbackExtraction(message);
      }

      console.log("🤖 Gemini raw response:", content.trim());

      // Parse Gemini response
      const parsed = this.parseGeminiResponse(content);

      if (!parsed) {
        console.log("⚠️ Failed to parse Gemini response, using fallback");
        return this.fallbackExtraction(message);
      }

      if (!this.validateExtractedData(parsed)) {
        console.log("⚠️ Gemini response failed validation, using fallback");
        return this.fallbackExtraction(message);
      }

      console.log("✅ Gemini extracted and validated:", parsed);
      return this.normalizeResult(parsed);
    } catch (error) {
      console.error("❌ Error with Gemini extraction:", error.message);
      console.error("Stack trace:", error.stack);
      return this.fallbackExtraction(message);
    }
  }

  static parseGeminiResponse(content) {
    try {
      // Clean the response to extract JSON
      let jsonStr = content.trim();

      // Remove markdown code blocks
      jsonStr = jsonStr.replace(/```json\s*/g, "").replace(/```\s*/g, "");

      // Extract JSON object
      const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonStr = jsonMatch[0];
      }

      return JSON.parse(jsonStr);
    } catch (error) {
      console.error("❌ Error parsing Gemini JSON:", error.message);
      return null;
    }
  }

  static validateExtractedData(data) {
    if (!data || typeof data !== "object") {
      return false;
    }

    // Check required properties
    const requiredProps = [
      "hasDateTime",
      "date",
      "time",
      "confidence",
      "explicitDate",
      "explicitTime",
    ];
    for (const prop of requiredProps) {
      if (!(prop in data)) {
        console.log(`❌ Missing property: ${prop}`);
        return false;
      }
    }

    // Validate types
    if (typeof data.hasDateTime !== "boolean") {
      console.log("❌ hasDateTime must be boolean");
      return false;
    }

    if (
      data.date !== null &&
      (typeof data.date !== "string" || !this.isValidDateString(data.date))
    ) {
      console.log("❌ Invalid date format");
      return false;
    }

    if (
      data.time !== null &&
      (typeof data.time !== "string" || !this.isValidTimeString(data.time))
    ) {
      console.log("❌ Invalid time format");
      return false;
    }

    if (!["high", "medium", "low"].includes(data.confidence)) {
      console.log("❌ Invalid confidence level");
      return false;
    }

    if (
      typeof data.explicitDate !== "boolean" ||
      typeof data.explicitTime !== "boolean"
    ) {
      console.log("❌ explicitDate and explicitTime must be boolean");
      return false;
    }

    return true;
  }

  static isValidDateString(dateStr) {
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(dateStr)) {
      return false;
    }
    const date = new Date(dateStr);
    return date instanceof Date && !isNaN(date);
  }

  static isValidTimeString(timeStr) {
    const timeRegex = /^([01]?\d|2[0-3]):([0-5]\d)$/;
    return timeRegex.test(timeStr);
  }

  static normalizeResult(result) {
    // Ensure the result has all required properties with correct types
    return {
      hasDateTime: Boolean(result.hasDateTime),
      date: result.date === null ? null : String(result.date),
      time: result.time === null ? null : String(result.time),
      confidence: result.confidence || "low",
      explicitDate: Boolean(result.explicitDate),
      explicitTime: Boolean(result.explicitTime),
    };
  }

  static getDefaultResult() {
    return {
      hasDateTime: false,
      date: null,
      time: null,
      confidence: "low",
      explicitDate: false,
      explicitTime: false,
    };
  }

  static fallbackExtraction(message) {
    // Placeholder for fallback extraction logic
    // This should contain your local extraction logic
    console.log("🔄 Using fallback extraction");

    if (!message || typeof message !== "string") {
      return this.getDefaultResult();
    }

    // Add your fallback logic here
    // For now, returning default result
    return this.getDefaultResult();
  }

  // Add this new function inside your DateTimeService class

  // static generateDateHint(message, today) {
  //   // Regex to find a number followed by st, nd, rd, or th (e.g., "1st", "2nd", "20th")
  //   const dayRegex = /\b(\d{1,2})(?:st|nd|rd|th)\b/i;
  //   const match = message.match(dayRegex);

  //   if (!match) {
  //     // No day number found, so no hint is needed.
  //     return "Hint: No standalone day number was found. Evaluate the message normally.";
  //   }

  //   const dayOfMonth = parseInt(match[1], 10);
  //   const currentDay = today.getDate();
  //   const currentMonthName = today.toLocaleString("en-US", { month: "long" });
  //   const nextMonthName = new Date(
  //     today.getFullYear(),
  //     today.getMonth() + 1,
  //     1
  //   ).toLocaleString("en-US", { month: "long" });

  //   if (dayOfMonth < currentDay) {
  //     // The day has passed! Give a direct order to use the next month.
  //     return `Hint: The user mentioned the ${dayOfMonth}. This day has ALREADY PASSED in ${currentMonthName}. You MUST use the next month, which is ${nextMonthName}.`;
  //   } else {
  //     // The day is in the future. Give a direct order to use the current month.
  //     return `Hint: The user mentioned the ${dayOfMonth}. This day has NOT passed yet. You MUST use the current month, which is ${currentMonthName}.`;
  //   }
  // }
  static generateDateHint(message, today) {
    // First, check for urgency keywords
    const urgencyMatch = message.match(/\b(asap|as soon as possible|immediately|earliest|soonest|urgently|quickest)\b/i);
    console.log("Urgency match:", urgencyMatch);
    if (urgencyMatch) {
      return `Hint: The user wants the earliest possible date/time ("${urgencyMatch[1]}"). The system handles this automatically, DO NOT RETURN ANY specific date or time. Instead, set "hasDateTime" to false and "confidence" to "medium". `;
    }
    // Regex for a day number (e.g., "1st", "2nd", "25th")
    const dayRegex = /\b(\d{1,2})(?:st|nd|rd|th)\b/i;
    const dayMatch = message.match(dayRegex);

    // If no day number is found, we can't generate a hint.
    if (!dayMatch) {
      return "Hint: No standalone day number was found. Evaluate the message normally.";
    }

    // --- UPDATED REGEX ---
    // Now includes common 3-letter abbreviations for each month.
    const monthRegex =
      /\b(January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|July|Jul|August|Aug|September|Sep|October|Oct|November|Nov|December|Dec)\b/i;
    const monthMatch = message.match(monthRegex);

    const dayOfMonth = parseInt(dayMatch[1], 10);


    // Case 1: A month was explicitly mentioned (full or abbreviated).
    if (monthMatch) {
      // monthMatch[1] will capture whichever version was found (e.g., "October" or "Oct")
      const monthName = monthMatch[1];
      return `Hint: The user explicitly mentioned a month: "${monthName}". You MUST use ${monthName} for the date calculation.`;
    }

    // Case 2: No month was mentioned. Fall back to the original logic.
    else {
      const currentDay = today.getDate();
      const currentMonthName = today.toLocaleString("en-US", { month: "long" });
      const nextMonthName = new Date(
        today.getFullYear(),
        today.getMonth() + 1,
        1
      ).toLocaleString("en-US", { month: "long" });

      if (dayOfMonth < currentDay) {
        // The day has passed in the current month, so they must mean next month.
        return `Hint: The user mentioned the ${dayOfMonth}. This day has ALREADY PASSED in ${currentMonthName}. You MUST use the next month, which is ${nextMonthName}.`;
      } else {
        // The day is in the future, so they likely mean the current month.
        return `Hint: The user mentioned the ${dayOfMonth}. This day has NOT passed yet. You MUST use the current month, which is ${currentMonthName}.`;
      }
    }
  }
  // Add other static methods that might be referenced elsewhere
  // ... (keep all other methods unchanged)
}

module.exports = DateTimeService;
