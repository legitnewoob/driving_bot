const OpenAI = require("openai");
const timezoneUtils = require("../utils/timezoneUtils");

class DateTimeService {
  static async extractDateTimeFromMessage(message) {
    console.log(`🔍 Extracting date/time from: "${message}"`);

    const result = {
      hasDateTime: false,
      date: null,
      time: null,
      confidence: "low",
      explicitDate: false,
      explicitTime: false,
      needsClarification: false,
      clarificationMessage: null
    };

    // First try local extraction for clear patterns
    const localResult = this.extractClearPatterns(message);
    
    // Only proceed with AI extraction if we have some confidence
    if (localResult.confidence === "high") {
      console.log("✅ Clear pattern detected, using local extraction");
      return localResult;
    }

    // For medium confidence or unclear cases, ask for clarification
    if (localResult.confidence === "medium" || this.containsVagueDateTimeReferences(message)) {
      return {
        ...result,
        needsClarification: true,
        clarificationMessage: "I noticed you mentioned a time or date, but I want to make sure I get it right. Could you please specify the exact date and time for your booking? (e.g., 'March 15th at 2:30 PM')"
      };
    }

    // If no date/time references at all, don't ask for clarification
    if (!localResult.hasDateTime) {
      return result;
    }

    // Only use AI for cases where we have partial but unclear information
    try {
      const aiResult = await this.useAIExtraction(message);
      
      // If AI result is not high confidence, ask for clarification
      if (aiResult.confidence !== "high") {
        return {
          ...result,
          needsClarification: true,
          clarificationMessage: "I detected a date or time reference, but I want to ensure accuracy. Could you please provide the specific date and time for your booking?"
        };
      }
      
      return aiResult;
      
    } catch (error) {
      console.error("❌ AI extraction failed:", error.message);
      return {
        ...result,
        needsClarification: true,
        clarificationMessage: "I had trouble understanding the date and time. Could you please specify when you'd like to schedule your booking?"
      };
    }
  }

  static extractClearPatterns(message) {
    const result = {
      hasDateTime: false,
      date: null,
      time: null,
      confidence: "low",
      explicitDate: false,
      explicitTime: false,
    };

    const msgLower = message.toLowerCase();

    // ONLY handle very clear, unambiguous patterns
    
    // Clear explicit dates
    const clearDatePatterns = [
      /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/, // 2024-03-15
      /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/, // 03/15/2024
    ];

    for (const pattern of clearDatePatterns) {
      const match = msgLower.match(pattern);
      if (match) {
        // Validate and format the date
        if (this.isValidDate(match)) {
          result.date = this.formatDate(match, pattern);
          result.explicitDate = true;
          result.hasDateTime = true;
          result.confidence = "high";
        }
      }
    }

    // Clear explicit times
    const clearTimePatterns = [
      /\b(\d{1,2}):(\d{2})\s*(am|pm)\b/i, // 3:30 PM
      /\b(\d{1,2}):(\d{2})\b/, // 15:30
    ];

    for (const pattern of clearTimePatterns) {
      const match = msgLower.match(pattern);
      if (match) {
        const time = this.formatTime(match);
        if (time) {
          result.time = time;
          result.explicitTime = true;
          result.hasDateTime = true;
          result.confidence = "high";
        }
      }
    }

    // Only handle very clear relative dates
    if (msgLower.includes("today") && !this.hasOtherDateReferences(msgLower)) {
      result.date = timezoneUtils.getCurrentDateString();
      result.hasDateTime = true;
      result.confidence = "high";
    }

    if (msgLower.includes("tomorrow") && !this.hasOtherDateReferences(msgLower)) {
      result.date = timezoneUtils.getTomorrowDateString();
      result.hasDateTime = true;
      result.confidence = "high";
    }

    return result;
  }

  static containsVagueDateTimeReferences(message) {
    const vaguePatterns = [
      /\b(this\s+week|next\s+week|this\s+weekend)\b/i,
      /\b(morning|afternoon|evening|night)\b/i,
      /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
      /\b(\d{1,2})(st|nd|rd|th)\b/i, // Day numbers without month
      /\b(sometime|later|soon|asap)\b/i,
      /\b(end\s+of\s+week|beginning\s+of\s+week)\b/i,
    ];

    return vaguePatterns.some(pattern => pattern.test(message.toLowerCase()));
  }

  static hasOtherDateReferences(msgLower) {
    // Check if there are other date references that might cause confusion
    const otherReferences = [
      /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
      /\b(\d{1,2})(st|nd|rd|th)\b/i,
      /\b(next\s+week|this\s+week)\b/i,
    ];
    
    return otherReferences.some(pattern => pattern.test(msgLower));
  }

  static async useAIExtraction(message) {
    // Your existing OpenAI logic here, but only for edge cases
    // that passed the initial screening
    
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    // Simplified prompt focusing on high confidence extraction only
    const prompt = `Extract ONLY clear, unambiguous dates and times from this message.
Current date: ${timezoneUtils.getCurrentDateString()}
Current time: ${timezoneUtils.getCurrentTimeString()}

Message: "${message}"

If the date/time is vague, ambiguous, or requires interpretation, set hasDateTime=false.
Only extract if you are highly confident about the exact date and time.

Respond with valid JSON only:`;

    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `Extract dates/times ONLY when explicitly clear. Be conservative.
          
JSON format:
{
  "hasDateTime": true or false,
  "date": "YYYY-MM-DD" or null,
  "time": "HH:MM" or null,
  "confidence": "high" or "medium" or "low",
  "explicitDate": true or false,
  "explicitTime": true or false
}`
        },
        { role: "user", content: prompt }
      ],
      max_tokens: 150,
      temperature: 0.0,
    });

    const content = response.choices[0].message.content.trim();
    const parsed = JSON.parse(content.replace(/```json\s*/, "").replace(/```\s*/, ""));
    
    return this.normalizeResult(parsed);
  }

  // Helper methods
  static isValidDate(match) {
    // Add date validation logic
    return true; // Simplified for example
  }

  static formatDate(match, pattern) {
    // Format date based on pattern
    const [, part1, part2, part3] = match;
    if (part1.length === 4) {
      return `${part1}-${part2.padStart(2, '0')}-${part3.padStart(2, '0')}`;
    } else {
      return `${part3}-${part1.padStart(2, '0')}-${part2.padStart(2, '0')}`;
    }
  }

  static formatTime(match) {
    let hour = parseInt(match[1]);
    let minute = match[2] ? parseInt(match[2]) : 0;
    const ampm = match[3]?.toLowerCase();

    if (ampm === "pm" && hour !== 12) hour += 12;
    else if (ampm === "am" && hour === 12) hour = 0;

    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
    }
    return null;
  }

  static normalizeResult(data) {
    return {
      hasDateTime: Boolean(data.hasDateTime),
      date: data.date,
      time: data.time,
      confidence: data.confidence,
      explicitDate: Boolean(data.explicitDate),
      explicitTime: Boolean(data.explicitTime),
      needsClarification: Boolean(data.needsClarification),
      clarificationMessage: data.clarificationMessage
    };
  }

  static validateExtractedData(data) {
    if (!data || typeof data !== "object") return false;
    if (typeof data.hasDateTime !== "boolean") return false;
    if (!["high", "medium", "low"].includes(data.confidence)) return false;
    
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

    return true;
  }
}

module.exports = DateTimeService;