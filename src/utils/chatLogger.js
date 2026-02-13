const fs = require("fs");
const path = require("path");
const { createLogger, format, transports } = require("winston");
const DailyRotateFile = require("winston-daily-rotate-file");

const loggerCache = new Map();

const timeOnlyFormat = format.printf(({ timestamp, message }) => {
    return `${timestamp} : ${message}`;
});

function getChatLogger(phoneNumber) {
    //const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const today = new Date().toLocaleDateString("en-CA", {
        timeZone: process.env.APP_TIMEZONE
    });
    const folderPath = path.join("message-logs", today);

    // create date folder if not exists
    if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
    }

    const logFilePath = path.join(folderPath, `${phoneNumber}.log`);

    // Return cached logger if exists
    //   if (loggerCache.has(logFilePath)) {
    //     return loggerCache.get(logFilePath);
    //   }

    const cacheKey = `${today}-${phoneNumber}`;

    if (loggerCache.has(cacheKey)) {
        return loggerCache.get(cacheKey);
    }

    const logger = createLogger({
        level: "info",
        format: format.combine(
            format.timestamp({
                format: () =>
                    new Date().toLocaleTimeString("en-CA", {
                        timeZone: process.env.APP_TIMEZONE,
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                        hour12: true
                    })
            }),
            timeOnlyFormat
        ),
        transports: [
            new transports.File({
                filename: logFilePath,
                handleExceptions: true
            })
        ]
    });

    // loggerCache.set(logFilePath, logger);
    loggerCache.set(cacheKey, logger);
    return logger;
}

module.exports = getChatLogger;