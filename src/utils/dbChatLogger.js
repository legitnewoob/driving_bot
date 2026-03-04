const { createLogger, format } = require("winston");
const MongoTransport = require("./mongoTransport");

const loggerCache = new Map();

function getDbChatLogger(instructor , phoneNumber) {
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: process.env.APP_TIMEZONE
  });

  const cacheKey = `${today}-${instructor}-${phoneNumber}`;

  if (loggerCache.has(cacheKey)) {
    return loggerCache.get(cacheKey);
  }

  const logger = createLogger({
    level: "info",
    format: format.combine(format.json()),
    transports: [new MongoTransport()]
  });

  // Wrap logger to inject metadata automatically
  const wrappedLogger = {
    user: (msg) =>
      logger.info({
        instructor,
        phoneNumber,
        role: "user",
        message: msg,
        date: today
      }),

    assistant: (msg) =>
      logger.info({
        instructor,
        phoneNumber,
        role: "assistant",
        message: msg,
        date: today
      }),

    system: (msg) =>
      logger.info({
        instructor,
        phoneNumber,
        role: "system",
        message: msg,
        date: today
      })
  };

  loggerCache.set(cacheKey, wrappedLogger);
  return wrappedLogger;
}

module.exports = getDbChatLogger;