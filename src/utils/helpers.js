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
    console.log("🧹 Running context cleanup...");
    const timeOutPeriod = (process.env.CONTEXT_TIMEOUT_MINUTES || 10) * 60 * 1000; // default 60 minutes
    const now = timezoneUtils.getCurrentDate();
    // const oneHour = 60(mins) * 60 * 1000;
     Object.keys(userSessions).forEach(phone => {
        if (now - userSessions[phone].lastActivity > timeOutPeriod) {
            WebhookController.clearUserConversationHistoryAndContext(phone);
        }
    });

}
module.exports = {
    cleanupSessions , cleanUpContexts
};