const chrono = require("chrono-node");

class DateTimeService {
    extractDateTimeFromMessage(message) {
        console.log(`🔍 Extracting date/time from: "${message}"`);

        const result = chrono.parse(message, new Date(), { forwardDate: true });

        if (result.length > 0) {
            const parsedDate = result[0].start.date();
            return {
                hasDateTime: true,
                date: parsedDate.toISOString().split('T')[0],
                time: parsedDate.toTimeString().slice(0, 5),
                confidence: "high"
            };
        }
        
        return {
            hasDateTime: false,
            date: null,
            time: null,
            confidence: "low"
        };
    }
}

module.exports = new DateTimeService();