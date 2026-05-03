const { model } = require("../../config/gemini");
const timezoneUtils = require("../../utils/timezoneUtils");
const logger = require("../../utils/logger-advanced");

class DateTimeService {
  // Constants
  static CONFIDENCE_LEVELS = {
    HIGH: "high",
    MEDIUM: "medium",
    LOW: "low",
  };

  static TIME_APPROXIMATIONS = {
    morning: "09:00",
    afternoon: "14:00",
    evening: "19:00",
    night: "21:00",
  };

  static URGENCY_KEYWORDS = /\b(asap|as soon as possible|immediately|earliest|soonest|urgently|quickest)\b/i;
  static DAY_NUMBER_REGEX = /\b(\d{1,2})(?:st|nd|rd|th)\b/i;
  static MONTH_REGEX = /\b(January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|July|Jul|August|Aug|September|Sep|October|Oct|November|Nov|December|Dec)\b/i;
  static DATE_FORMAT_REGEX = /^\d{4}-\d{2}-\d{2}$/;
  static TIME_FORMAT_REGEX = /^([01]?\d|2[0-3]):([0-5]\d)$/;

  // JSON Schema for Gemini structured output
// JSON Schema for Gemini structured output (Gemini-compatible format)
  static DATE_TIME_SCHEMA = {
    type: "OBJECT",
    properties: {
      hasDateTime: {
        type: "BOOLEAN",
        description: "Whether a date or time was found in the message",
        nullable: false
      },
      date: {
        type: "STRING",
        description: "Extracted date in YYYY-MM-DD format, or null if no date found",
        nullable: true
      },
      time: {
        type: "STRING",
        description: "Extracted time in HH:MM format (24-hour), or null if no time found",
        nullable: true
      },
      confidence: {
        type: "STRING",
        description: "Confidence level of the extraction (high, medium, or low)",
        nullable: false
      },
      reasoning: {
        type: "STRING",
        description: "Brief explanation of the extraction logic",
        nullable: false
      },
      explicitDate: {
        type: "BOOLEAN",
        description: "Whether the date was explicitly mentioned",
        nullable: false
      },
      explicitTime: {
        type: "BOOLEAN",
        description: "Whether the time was explicitly mentioned",
        nullable: false
      }
    },
    required: ["hasDateTime", "date", "time", "confidence", "reasoning", "explicitDate", "explicitTime"]
  };

  /**
   * Main method to extract date/time from a message
   * @param {string} message - The message to parse
   * @returns {Promise<Object>} Extracted date/time information
   */
  static async extractDateTimeFromMessage(message) {
    if (!this.isValidInput(message)) {
      return this.getDefaultResult();
    }

    try {
      // Try local extraction first for simple cases
      const localResult = this.fallbackExtraction(message);
      if (this.isHighConfidenceResult(localResult)) {
        logger.info("DateTime: using local extraction (high confidence)");
        return localResult;
      }

      // Use Gemini for complex cases
      return await this.extractWithGemini(message);
    } catch (error) {
      logger.error(`DateTime extraction error: ${error.message}`);
      return this.fallbackExtraction(message);
    }
  }

  /**
   * Extract date/time using Gemini AI with retry logic
   * @param {string} message - The message to parse
   * @param {number} retryCount - Current retry attempt
   * @returns {Promise<Object>} Extracted date/time information
   */
  static async extractWithGemini(message, retryCount = 0) {
    const MAX_RETRIES = 2;
    
    if (!model) {
      logger.warn("Gemini model not available, using fallback");
      return this.fallbackExtraction(message);
    }

    try {
      const prompt = this.buildGeminiPrompt(message);

      // Use Gemini's JSON mode with schema
      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: this.DATE_TIME_SCHEMA,
          temperature: 0.1, // Lower temperature for more consistent outputs
        },
      });
      
      if (!this.isValidGeminiResponse(result)) {
        if (retryCount < MAX_RETRIES) {
          logger.warn(`DateTime Gemini: invalid response, retrying (${retryCount + 1}/${MAX_RETRIES})`);
          await this.delay(1000);
          return this.extractWithGemini(message, retryCount + 1);
        }
        
        return this.fallbackExtraction(message);
      }

      const content = result.response.text();

      const parsed = this.parseGeminiResponse(content);
      
      if (!parsed) {
        if (retryCount < MAX_RETRIES) {
          logger.warn(`DateTime Gemini: parse failed, retrying (${retryCount + 1}/${MAX_RETRIES})`);
          await this.delay(1000);
          return this.extractWithGemini(message, retryCount + 1);
        }
        
        return this.fallbackExtraction(message);
      }
      
      if (!this.validateExtractedData(parsed)) {
        if (retryCount < MAX_RETRIES) {
          logger.warn(`DateTime Gemini: validation failed, retrying (${retryCount + 1}/${MAX_RETRIES})`);
          await this.delay(1000);
          return this.extractWithGemini(message, retryCount + 1);
        }
        
        return this.fallbackExtraction(message);
      }

      logger.info(`DateTime extracted: date=${parsed.date}, time=${parsed.time}, confidence=${parsed.confidence}`);
      return this.normalizeResult(parsed);
      
    } catch (error) {
      logger.error(`DateTime Gemini extraction error: ${error.message}`);
      
      if (retryCount < MAX_RETRIES) {
        await this.delay(1000);
        return this.extractWithGemini(message, retryCount + 1);
      }
      
      return this.fallbackExtraction(message);
    }
  }

  /**
   * Build the prompt for Gemini AI
   * @param {string} message - The message to parse
   * @returns {string} Formatted prompt
   */
  static buildGeminiPrompt(message) {
    const context = this.getDateTimeContext();
    const dateHint = this.generateDateHint(message, context.today);
    
    return `You are a date/time parsing assistant. Extract date and time from the message below.

Current Context:
- Today's Date: ${context.todayStr}
- Today's Day: ${context.currentDay}

*** CRITICAL HINT - YOU MUST FOLLOW THIS ***
${dateHint}
***

Message: "${message}"

RULES:
1. **Follow the Hint:** The Hint provides the definitive logic for handling day numbers. It overrides all other assumptions.
2. **No Date/Time:** If the message has no date/time info and the hint is not applicable, set "hasDateTime" to false.
3. **Time Approximations:** Use these values for vague times: morning=09:00, afternoon=14:00, evening=19:00, night=21:00.
4. **explicitDate:** Set to true if the message resolves to a single, unambiguous calendar date (like "tomorrow" or "next Monday"). Set it to false only for vague date ranges (like "sometime next week" or "in a few days").
5. **explicitTime:** Set to true only if the time is clearly and specifically mentioned in the message.

Extract the date and time information according to these rules.`;
  }

  /**
   * Get current date/time context
   * @returns {Object} Context information
   */
  static getDateTimeContext() {
    return {
      today: timezoneUtils.getCurrentDate(),
      todayStr: timezoneUtils.getCurrentDateString(),
      currentTime: timezoneUtils.getCurrentTimeString(),
      tomorrowStr: timezoneUtils.getTomorrowDateString(),
      currentDay: timezoneUtils.getCurrentDay(),
      currentTimezone: process.env.APP_TIMEZONE || "Asia/Kolkata",
    };
  }

  /**
   * Generate a hint for date parsing based on the message
   * @param {string} message - The message to analyze
   * @param {Date} today - Current date
   * @returns {string} Generated hint
   */
  static generateDateHint(message, today) {
    // Check for urgency keywords first
    const urgencyMatch = message.match(this.URGENCY_KEYWORDS);
    if (urgencyMatch) {
      return `Hint: The user wants the earliest possible date/time ("${urgencyMatch[1]}"). The system handles this automatically. DO NOT RETURN ANY specific date or time. Instead, set "hasDateTime" to false and "confidence" to "medium".`;
    }

    // Check for day number
    const dayMatch = message.match(this.DAY_NUMBER_REGEX);
    if (!dayMatch) {
      return "Hint: No standalone day number was found. Evaluate the message normally.";
    }

    const dayOfMonth = parseInt(dayMatch[1], 10);
    
    // Check if month is explicitly mentioned
    const monthMatch = message.match(this.MONTH_REGEX);
    if (monthMatch) {
      return `Hint: The user explicitly mentioned a month: "${monthMatch[1]}". You MUST use ${monthMatch[1]} for the date calculation.`;
    }

    // Determine current or next month based on whether the day has passed
    const currentDay = today.getDate();
    const currentMonthName = today.toLocaleString("en-US", { month: "long" });
    const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const nextMonthName = nextMonth.toLocaleString("en-US", { month: "long" });

    if (dayOfMonth < currentDay) {
      return `Hint: The user mentioned the ${dayOfMonth}. This day has ALREADY PASSED in ${currentMonthName}. You MUST use the next month, which is ${nextMonthName}.`;
    } else {
      return `Hint: The user mentioned the ${dayOfMonth}. This day has NOT passed yet. You MUST use the current month, which is ${currentMonthName}.`;
    }
  }

  /**
   * Parse Gemini's JSON response (now much simpler with JSON mode)
   * @param {string} content - Raw response content
   * @returns {Object|null} Parsed JSON object or null
   */
  static parseGeminiResponse(content) {
    try {
      if (!content || typeof content !== 'string') {
        return null;
      }

      // With JSON mode enabled, the response should already be valid JSON
      // No need for regex extraction or cleanup
      const parsed = JSON.parse(content.trim());
      
      // Verify we got the expected structure
      if (!this.hasRequiredJsonStructure(parsed)) {
        logger.warn("DateTime: parsed JSON missing required fields");
        return null;
      }

      return parsed;
    } catch (error) {
      logger.error(`DateTime JSON parse error: ${error.message}`);
      return null;
    }
  }

  /**
   * Check if parsed JSON has required structure
   * @param {Object} parsed - Parsed JSON object
   * @returns {boolean} Whether required fields exist
   */
  static hasRequiredJsonStructure(parsed) {
    if (!parsed || typeof parsed !== 'object') {
      return false;
    }
    
    // At minimum, we need hasDateTime
    return 'hasDateTime' in parsed;
  }

  /**
   * Validate extracted data structure and values
   * @param {Object} data - Data to validate
   * @returns {boolean} Whether the data is valid
   */
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
        // Try to provide defaults for missing properties
        if (this.canProvideDefault(prop, data)) {
          data[prop] = this.getDefaultForProperty(prop);
        } else {
          return false;
        }
      }
    }

    // Validate types and values
    const validations = [
      { 
        check: typeof data.hasDateTime === "boolean", 
        msg: "hasDateTime must be boolean",
        fix: () => data.hasDateTime = Boolean(data.hasDateTime)
      },
      { 
        check: data.date === null || (typeof data.date === "string" && this.isValidDateString(data.date)), 
        msg: "Invalid date format" 
      },
      { 
        check: data.time === null || (typeof data.time === "string" && this.isValidTimeString(data.time)), 
        msg: "Invalid time format" 
      },
      { 
        check: Object.values(this.CONFIDENCE_LEVELS).includes(data.confidence), 
        msg: "Invalid confidence level",
        fix: () => data.confidence = this.CONFIDENCE_LEVELS.LOW
      },
      { 
        check: typeof data.explicitDate === "boolean", 
        msg: "explicitDate must be boolean",
        fix: () => data.explicitDate = Boolean(data.explicitDate)
      },
      { 
        check: typeof data.explicitTime === "boolean", 
        msg: "explicitTime must be boolean",
        fix: () => data.explicitTime = Boolean(data.explicitTime)
      },
    ];

    for (const validation of validations) {
      if (!validation.check) {
        if (validation.fix) {
          try {
            validation.fix();
          } catch (e) {
            return false;
          }
        } else {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Check if we can provide a safe default for a missing property
   * @param {string} prop - Property name
   * @param {Object} data - Current data object
   * @returns {boolean} Whether a default can be provided
   */
  static canProvideDefault(prop, data) {
    // Only provide defaults for non-critical fields
    const safeDefaults = ['confidence', 'explicitDate', 'explicitTime'];
    return safeDefaults.includes(prop);
  }

  /**
   * Get default value for a property
   * @param {string} prop - Property name
   * @returns {any} Default value
   */
  static getDefaultForProperty(prop) {
    const defaults = {
      confidence: this.CONFIDENCE_LEVELS.LOW,
      explicitDate: false,
      explicitTime: false,
    };
    return defaults[prop];
  }

  /**
   * Validate date string format
   * @param {string} dateStr - Date string to validate
   * @returns {boolean} Whether the date string is valid
   */
  static isValidDateString(dateStr) {
    if (!this.DATE_FORMAT_REGEX.test(dateStr)) {
      return false;
    }
    
    const date = new Date(dateStr);
    return date instanceof Date && !isNaN(date);
  }

  /**
   * Validate time string format
   * @param {string} timeStr - Time string to validate
   * @returns {boolean} Whether the time string is valid
   */
  static isValidTimeString(timeStr) {
    return this.TIME_FORMAT_REGEX.test(timeStr);
  }

  /**
   * Normalize result to ensure consistent format
   * @param {Object} result - Result to normalize
   * @returns {Object} Normalized result
   */
  static normalizeResult(result) {
    return {
      hasDateTime: Boolean(result.hasDateTime),
      date: result.date === null ? null : String(result.date),
      time: result.time === null ? null : String(result.time),
      confidence: result.confidence || this.CONFIDENCE_LEVELS.LOW,
      explicitDate: Boolean(result.explicitDate),
      explicitTime: Boolean(result.explicitTime),
    };
  }

  /**
   * Get default result object
   * @returns {Object} Default result
   */
  static getDefaultResult() {
    return {
      hasDateTime: false,
      date: null,
      time: null,
      confidence: this.CONFIDENCE_LEVELS.LOW,
      explicitDate: false,
      explicitTime: false,
    };
  }

  /**
   * Fallback extraction using local logic
   * @param {string} message - Message to parse
   * @returns {Object} Extraction result
   */
  static fallbackExtraction(message) {
    
    if (!this.isValidInput(message)) {
      return this.getDefaultResult();
    }

    // TODO: Implement sophisticated local extraction logic
    // This could include regex patterns for common date/time formats
    // For now, returning default result
    
    return this.getDefaultResult();
  }

  /**
   * Delay helper for retry logic
   * @param {number} ms - Milliseconds to delay
   * @returns {Promise} Promise that resolves after delay
   */
  static delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Helper methods

  /**
   * Validate input message
   * @param {string} message - Message to validate
   * @returns {boolean} Whether the input is valid
   */
  static isValidInput(message) {
    return message && typeof message === "string" && message.trim().length > 0;
  }

  /**
   * Check if result has high confidence
   * @param {Object} result - Result to check
   * @returns {boolean} Whether the result has high confidence
   */
  static isHighConfidenceResult(result) {
    return (
      result &&
      result.hasDateTime &&
      result.confidence === this.CONFIDENCE_LEVELS.HIGH
    );
  }

  /**
   * Check if Gemini response is valid
   * @param {Object} result - Gemini API result
   * @returns {boolean} Whether the response is valid
   */
  static isValidGeminiResponse(result) {
    return result && result.response && result.response.text;
  }
}

module.exports = DateTimeService;