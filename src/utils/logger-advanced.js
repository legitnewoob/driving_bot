const { createLogger, format, transports } = require("winston");
const DailyRotateFile = require("winston-daily-rotate-file");

const logFormat = format.printf(({ level, message, timestamp, stack }) => {
  return `${timestamp} [${level.toUpperCase()}]: ${stack || message}`;
});

const logger = createLogger({
  level: "info",
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }), // log stack traces
    format.json()
  ),
  transports: [
    // Console (for development)
    new transports.Console({
      format: format.combine(format.colorize(), logFormat),
    }),

    // Error logs
    new DailyRotateFile({
      filename: "w-logs/error-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      level: "error",
    }),

    // All logs
    new DailyRotateFile({
      filename: "w-logs/combined-%DATE%.log",
      datePattern: "YYYY-MM-DD",
    }),
  ],
});

module.exports = logger;