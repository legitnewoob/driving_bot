const { userSessions } = require('../models/instructorModel');
const timezoneUtils = require('./timezoneUtils');
const WebhookController = require('../controllers/webhookController');
function cleanupSessions() {
    const timeOutPeriod = (process.env.SESSION_TIMEOUT_MINUTES || 60) * 60 * 1000; // default 60 minutes
    const now = timezoneUtils.getCurrentDate();
    // const oneHour = 60 * 60 * 1000;
    
    Object.keys(userSessions).forEach(phone => {
        if (now - userSessions[phone].lastActivity > timeOutPeriod) {
            delete userSessions[phone];
        }
    });
}

function cleanUpContexts() {
    const timeOutPeriod = (process.env.CONTEXT_TIMEOUT_MINUTES || 10) * 60 * 1000; // default 60 minutes
    const now = timezoneUtils.getCurrentDate();
    // const oneHour = 60(mins) * 60 * 1000;
     Object.keys(userSessions).forEach(phone => {
        if (now - userSessions[phone].lastActivity > timeOutPeriod) {
            WebhookController.clearUserConversationHistoryAndContext(phone);
        }
    });

}

async function findEarliestAvailableSlot() {
  console.log("Let's find the next available appointment...");

  const earliestSlot = await calendarService.findEarliestAvailableSlot(instructorId);

  if (earliestSlot) {
    // Here you can store the result or format a message for the user
    // For example, store it in a user session:
    // userSession.nextAvailableSlot = earliestSlot;

    console.log(
      `The next available appointment is on ${earliestSlot.date} at ${earliestSlot.time}.`
    );
    return `The next available appointment is on ${earliestSlot.date} at ${earliestSlot.time}. Would you like to book it?`;
  } else {
    console.log("Sorry, no appointments are available in the near future.");
    return "Sorry, no appointments are available in the near future. Please check back later.";
  }
}
module.exports = {
    cleanupSessions , cleanUpContexts
};