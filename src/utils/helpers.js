const { userSessions } = require('../models/instructorModel');

function cleanupSessions() {
    const now = new Date();
    const oneHour = 60 * 60 * 1000;
    
    Object.keys(userSessions).forEach(phone => {
        if (now - userSessions[phone].lastActivity > oneHour) {
            delete userSessions[phone];
        }
    });
}

module.exports = {
    cleanupSessions
};