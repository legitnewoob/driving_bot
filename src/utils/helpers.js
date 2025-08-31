const { userSessions } = require('../models/instructorModel');
const timezoneUtils = require('./timezoneUtils');

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

module.exports = {
    cleanupSessions
};