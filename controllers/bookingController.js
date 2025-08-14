const { sendTextMessage, sendButtonMessage, sendListMessage } = require('../services/whatsappService');
const { createCalendarEvent } = require('../services/googleCalendarService');
const { getAvailableDates } = require('../utils/dateUtils');

const userSessions = {};
const instructors = {
  '691332914069950': {
    name: 'Raj Agrawal',
    googleCalendarId: 'agrawalraj918@gmail.com',
    availableTimes: ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00']
  }
};

async function handleIncomingMessage(from, message, messageType) {
  const session = userSessions[from] || { step: 'initial' };
  const instructor = instructors['691332914069950'];

  // Same booking logic as your original code...
  // (move your switch-case booking flow here)

  userSessions[from] = session;
}

module.exports = { handleIncomingMessage, instructors, userSessions };