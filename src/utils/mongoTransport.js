const Transport = require("winston-transport");
const ChatLog = require("../models/chatLogModel");

class MongoTransport extends Transport {
  async log(info, callback) {
    try {
      const { instructor, phoneNumber, role, message, date } = info;

      await ChatLog.create({
        instructor,
        phoneNumber,
        role,
        message,
        date
      });

      callback();
    } catch (error) {
      console.error("❌ Mongo log error:", error.message);
      callback(error);
    }
  }
}

module.exports = MongoTransport;