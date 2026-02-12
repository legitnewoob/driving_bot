const OpenAI = require("openai");
const timezoneUtils = require("../src/utils/timezoneUtils");

class DateTimeService {
  static async extractDateTimeFromMessage(message) {

    console.log(`🔍 Extracting date/time from: "${message}"`);

    // Use timezone-aware current date/time
    const today = timezoneUtils.getCurrentDate();
    const todayStr = timezoneUtils.getCurrentDateString();
    const currentTime = timezoneUtils.getCurrentTimeString();

    const result = {
      hasDateTime: false,
      date: null,
      time: null,
      confidence: "low",
      explicitDate: false,
      explicitTime: false,
    };

    try {
      // First try local extraction for common patterns (more reliable)
      const localResult = this.fallbackExtraction(message);
      if (localResult.hasDateTime && localResult.confidence === "high") {
        console.log("✅ Using local extraction (high confidence)");
        return localResult;
      }

      // Use OpenAI for complex cases
      const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });

      // Enhanced prompt with timezone context
      const tomorrowStr = timezoneUtils.getTomorrowDateString();
      const currentTimezone = process.env.APP_TIMEZONE || "Asia/Kolkata";

      const prompt = `Extract date and time from this message. Current context (${currentTimezone}): ${todayStr} ${currentTime}

Message: "${message}"

Rules:
1. Only extract explicitly mentioned dates/times
2. For day numbers without month (like "17th"): if day < current day (${timezoneUtils.getCurrentDay()}), use next month
3. Relative terms: today=${todayStr}, tomorrow=${tomorrowStr}
4. Time approximations: morning=09:00, afternoon=14:00, evening=19:00, night=21:00
5. If no clear date/time, return hasDateTime=false
6. All times should be in 24-hour format (HH:MM)
7. Weekdays (e.g. Monday, Tuesday, etc.): resolve to the next occurrence of that weekday after today (${todayStr}).
8. If it says "next [weekday]", interpret as the weekday in the following week.

Respond with valid JSON only:`;

      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "system",
            content: `You extract dates and times from text using ${currentTimezone} timezone. CRITICAL: You must respond with ONLY valid JSON, no other text.

Required JSON format:
{
  "hasDateTime": true or false,
  "date": "YYYY-MM-DD" or null,
  "time": "HH:MM" or null,
  "confidence": "high" or "medium" or "low",
  "explicitDate": true or false,
  "explicitTime": true or false
}

Be conservative - only extract clear, unambiguous date/time references. Do not guess or infer dates/times that aren't clearly stated.`,
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        max_tokens: 150,
        temperature: 0.0,
        stop: ["\n\n", "```"],
      });

      const content = response.choices[0].message.content.trim();
      console.log("🤖 OpenAI raw response:", content);

      // Clean the response to extract just the JSON part
      let jsonStr = content;
      jsonStr = jsonStr.replace(/```json\s*/g, "").replace(/```\s*/g, "");

      const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonStr = jsonMatch[0];
      }

      const parsed = JSON.parse(jsonStr);

      if (!this.validateExtractedData(parsed)) {
        console.log("⚠️ OpenAI response failed validation, using fallback");
        return this.fallbackExtraction(message);
      }

      console.log("✅ OpenAI extracted and validated:", parsed);
      return this.normalizeResult(parsed);
    } catch (error) {
      console.error("❌ Error with OpenAI extraction:", error.message);
      return this.fallbackExtraction(message);
    }
  }

  static validateExtractedData(data) {
    if (!data || typeof data !== "object") return false;

    if (typeof data.hasDateTime !== "boolean") return false;
    if (!["high", "medium", "low"].includes(data.confidence)) return false;
    if (typeof data.explicitDate !== "boolean") return false;
    if (typeof data.explicitTime !== "boolean") return false;

    // Validate date format if present
    if (data.date !== null) {
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(data.date)) return false;

      const testDate = new Date(data.date);
      if (isNaN(testDate.getTime())) return false;
    }

    // Validate time format if present
    if (data.time !== null) {
      const timeRegex = /^\d{2}:\d{2}$/;
      if (!timeRegex.test(data.time)) return false;

      const [hours, minutes] = data.time.split(":").map(Number);
      if (hours > 23 || minutes > 59) return false;
    }

    if (!data.hasDateTime && (data.date !== null || data.time !== null)) {
      return false;
    }

    return true;
  }

  static normalizeResult(data) {
    return {
      hasDateTime: Boolean(data.hasDateTime),
      date: data.date,
      time: data.time,
      confidence: data.confidence,
      explicitDate: Boolean(data.explicitDate),
      explicitTime: Boolean(data.explicitTime),
    };
  }

  static fallbackExtraction(message) {
    console.log("🔄 Using enhanced fallback extraction");
    const result = {
      hasDateTime: false,
      date: null,
      time: null,
      confidence: "low",
      explicitDate: false,
      explicitTime: false,
    };

    const msgLower = message.toLowerCase();

    // Use timezone-aware date extraction
    this.extractDate(msgLower, result);
    this.extractTime(msgLower, result);

    if (result.date || result.time) {
      result.hasDateTime = true;
    }

    console.log("🔄 Fallback result:", result);
    return result;
  }

  //   static extractDate(msgLower, result) {
  //     // Explicit date patterns (YYYY-MM-DD, MM/DD/YYYY, etc.)
  //     const explicitDatePatterns = [
  //       /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/,
  //       /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/,
  //       /\b(\d{1,2})-(\d{1,2})-(\d{4})\b/
  //     ];

  //     for (const pattern of explicitDatePatterns) {
  //       const match = msgLower.match(pattern);
  //       if (match) {
  //         if (pattern.source.includes('(\\d{4})')) {
  //           const [, part1, part2, part3] = match;
  //           if (part1.length === 4) { // YYYY-MM-DD
  //             result.date = `${part1}-${part2.padStart(2, '0')}-${part3.padStart(2, '0')}`;
  //           } else { // MM/DD/YYYY
  //             result.date = `${part3}-${part1.padStart(2, '0')}-${part2.padStart(2, '0')}`;
  //           }
  //         }
  //         result.explicitDate = true;
  //         result.confidence = "high";
  //         return;
  //       }
  //     }

  //     // Relative date patterns using timezone utils
  //     if (msgLower.includes('today')) {
  //       result.date = timezoneUtils.getCurrentDateString();
  //       result.confidence = "high";
  //       return;
  //     }

  //     if (msgLower.includes('tomorrow')) {
  //       result.date = timezoneUtils.getTomorrowDateString();
  //       result.confidence = "high";
  //       return;
  //     }

  //     if (msgLower.includes('yesterday')) {
  //       result.date = timezoneUtils.getYesterdayDateString();
  //       result.confidence = "high";
  //       return;
  //     }

  //     // Day number patterns using timezone-aware logic
  //     const dayMatch = msgLower.match(/\b(\d{1,2})(st|nd|rd|th)\b/);
  //     if (dayMatch) {
  //       const requestedDay = parseInt(dayMatch[1]);
  //       const currentDay = timezoneUtils.getCurrentDay();

  //       if (requestedDay >= 1 && requestedDay <= 31) {
  //         result.date = timezoneUtils.getNextOccurrenceOfDay(requestedDay);
  //         result.explicitDate = true;
  //         result.confidence = "medium";
  //         console.log(`📅 Day ${requestedDay}: Current day ${currentDay}, using ${result.date}`);
  //       }
  //     }

  //     // Week-based relative dates
  //     if (msgLower.includes('next week')) {
  //       result.date = timezoneUtils.addDays(timezoneUtils.getCurrentDateString(), 7);
  //       result.confidence = "medium";
  //     }
  //   }
  static extractDate(msgLower, result) {
    // Explicit date patterns (YYYY-MM-DD, MM/DD/YYYY, etc.)
    const explicitDatePatterns = [
      /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/,
      /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/,
      /\b(\d{1,2})-(\d{1,2})-(\d{4})\b/,
    ];

    for (const pattern of explicitDatePatterns) {
      const match = msgLower.match(pattern);
      if (match) {
        if (pattern.source.includes("(\\d{4})")) {
          const [, part1, part2, part3] = match;
          if (part1.length === 4) {
            // YYYY-MM-DD
            result.date = `${part1}-${part2.padStart(2, "0")}-${part3.padStart(
              2,
              "0"
            )}`;
          } else {
            // MM/DD/YYYY
            result.date = `${part3}-${part1.padStart(2, "0")}-${part2.padStart(
              2,
              "0"
            )}`;
          }
        }
        result.explicitDate = true;
        result.confidence = "high";
        return;
      }
    }

    // Relative date patterns
    if (msgLower.includes("today")) {
      result.date = timezoneUtils.getCurrentDateString();
      result.confidence = "high";
      return;
    }

    if (msgLower.includes("tomorrow")) {
      result.date = timezoneUtils.getTomorrowDateString();
      result.confidence = "high";
      return;
    }

    if (msgLower.includes("yesterday")) {
      result.date = timezoneUtils.getYesterdayDateString();
      result.confidence = "high";
      return;
    }

    // ✅ NEW: Day of week mapping
    const weekdays = {
      sunday: 0,
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6,
    };

    for (const [dayName, dayIndex] of Object.entries(weekdays)) {
      if (msgLower.includes(dayName)) {
        const todayIndex = timezoneUtils.getCurrentDay(); // 0-6
        let offset = (dayIndex - todayIndex + 7) % 7;
        if (offset === 0) offset = 7; // "Wednesday" on a Wednesday means NEXT Wednesday
        result.date = timezoneUtils.addDays(
          timezoneUtils.getCurrentDateString(),
          offset
        );
        result.explicitDate = true;
        result.confidence = "high";
        console.log(`📅 Interpreted "${dayName}" as ${result.date}`);
        return;
      }
    }

    // Day number patterns like "17th"
    const dayMatch = msgLower.match(/\b(\d{1,2})(st|nd|rd|th)\b/);
    if (dayMatch) {
      const requestedDay = parseInt(dayMatch[1]);
      const currentDay = timezoneUtils.getCurrentDay();

      if (requestedDay >= 1 && requestedDay <= 31) {
        result.date = timezoneUtils.getNextOccurrenceOfDay(requestedDay);
        result.explicitDate = true;
        result.confidence = "medium";
        console.log(
          `📅 Day ${requestedDay}: Current day ${currentDay}, using ${result.date}`
        );
      }
    }

    // "next week"
    if (msgLower.includes("next week")) {
      result.date = timezoneUtils.addDays(
        timezoneUtils.getCurrentDateString(),
        7
      );
      result.confidence = "medium";
    }
  }

  static extractTime(msgLower, result) {
    // Explicit time patterns
    const timePatterns = [
      /\b(\d{1,2}):(\d{2})\s*(am|pm)\b/i,
      /\b(\d{1,2}):(\d{2})\b/,
      /\b(\d{1,2})\s*(am|pm)\b/i,
    ];

    for (const pattern of timePatterns) {
      const match = msgLower.match(pattern);
      if (match) {
        let hour = parseInt(match[1]);
        let minute = match[2] ? parseInt(match[2]) : 0;
        const ampm = match[3]?.toLowerCase();

        // Convert to 24-hour format
        if (ampm === "pm" && hour !== 12) {
          hour += 12;
        } else if (ampm === "am" && hour === 12) {
          hour = 0;
        }

        if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
          result.time = `${hour.toString().padStart(2, "0")}:${minute
            .toString()
            .padStart(2, "0")}`;
          result.explicitTime = true;
          result.confidence = "high";
          return;
        }
      }
    }

    // Relative time patterns
    const timeKeywords = {
      morning: "09:00",
      noon: "12:00",
      afternoon: "14:00",
      evening: "19:00",
      night: "21:00",
      midnight: "00:00",
    };

    for (const [keyword, time] of Object.entries(timeKeywords)) {
      if (msgLower.includes(keyword)) {
        result.time = time;
        result.confidence = "medium";
        break;
      }
    }
  }

  static async testExtraction(testMessages) {
    console.log("🧪 Testing DateTime Extraction");
    console.log(
      `🌍 Using timezone: ${process.env.APP_TIMEZONE || "Asia/Kolkata"}`
    );
    console.log(
      `📅 Current date/time: ${timezoneUtils.getCurrentDateString()} ${timezoneUtils.getCurrentTimeString()}`
    );
    console.log("================================");

    for (const msg of testMessages) {
      console.log(`\nTesting: "${msg}"`);
      const result = await this.extractDateTimeFromMessage(msg);
      console.log("Result:", result);
      console.log("---");
    }
  }
}

if (require.main === module) {
  const testMessages = [
    "Let's meet tomorrow at 3 PM",
    "Schedule for the 17th",
    "Can we do this on 2024-03-15 at 14:30?",
    "How about this morning?",
    "Let's talk next week",
    "Random message with no dates",
    "Meet me at noon today",
    "The meeting is on March 15th at 2:30 PM",
  ];

  DateTimeService.testExtraction(testMessages);
}

module.exports = DateTimeService;
