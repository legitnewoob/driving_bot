const timezoneUtils = require("../utils/timezoneUtils");
// Store user sessions with conversation history
const userSessions = {};

// Instructor data
const instructors = {
    [process.env.PHONE_NUMBER_ID]: {
        name: 'UAT Instructor',
        googleCalendarId: 'dummyinstructor57@gmail.com',
        availableTimes: ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00'],
        specialties: ['Basic driving', 'Highway driving', 'Parking', 'City driving'],
        rates: {
            basic: 50,
            highway: 60,
            parking: 45
        }
    }
};

function getUserSession(phone) {
    if (!userSessions[phone]) {
        userSessions[phone] = {
            conversationHistory: [],
            lastActivity: timezoneUtils.getCurrentDate()
        };
    }
    return userSessions[phone];
}

function updateUserSession(phone, session) {
    session.lastActivity = timezoneUtils.getCurrentDate();
    userSessions[phone] = session;
}

function getInstructor(instructorId) {
    return instructors[instructorId];
}

// function getAvailableDates() {
//     const dates = [];
//     const today = new Date();
    
//     for (let i = 1; i <= 90; i++) {
//         const date = new Date(today);
//         date.setDate(today.getDate() + i);
        
//         // Skip weekends
//         if (date.getDay() !== 0 && date.getDay() !== 6) {
//             dates.push(date.toISOString().split('T')[0]);
//         }
        
//         // if (dates.length >= 7) break;
//     }
    
//     return dates;
// }


function getAvailableDates() {
    const dates = [];
    const today = timezoneUtils.getCurrentDate(); // gets current date in IST
    
    // Create today's date at midnight (local)
    const todayLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    for (let i = 1; i <= 90; i++) {
        const date = new Date(todayLocal);
        date.setDate(todayLocal.getDate() + i);

        const dayOfWeek = date.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
        if (dayOfWeek >= 1 && dayOfWeek <= 5) {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            dates.push(`${year}-${month}-${day}`);
        }
    }

    return dates;
}


module.exports = {
    userSessions,
    instructors,
    getUserSession,
    updateUserSession,
    getInstructor,
    getAvailableDates
};