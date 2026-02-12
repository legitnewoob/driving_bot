const chrono = require("chrono-node");

class DateTimeService {
  static extractDateTimeFromMessage(message) {
    console.log(`🔍 Extracting date/time from: "${message}"`);
    const today = new Date();
    const result = {
      hasDateTime: false,
      date: null,
      time: null,
      confidence: "low",
      explicitDate: false,
      explicitTime: false
    };

    const parsed = chrono.parse(message, today, { forwardDate: true });
    if (parsed.length > 0) {
      const start = parsed[0].start;
      const known = start.knownValues;
      const implied = start.impliedValues;

      // Extract date
      if (known.year || known.month || known.day || known.weekday) {
        result.explicitDate = true;
      }
      if (start.date()) {
        result.date = start.date().toISOString().split("T")[0];
      }

      // Extract time
      if (known.hour !== undefined) {
        result.explicitTime = true;
      }
      if (known.hour !== undefined || implied.hour !== undefined) {
        const d = start.date();
        result.time = d.toTimeString().slice(0, 5); // HH:mm
      }

      result.hasDateTime = true;
      result.confidence = "high";
    }

    return result;
  }
}

module.exports = DateTimeService;