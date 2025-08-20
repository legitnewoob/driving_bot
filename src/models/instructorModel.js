// Store user sessions with conversation history
const userSessions = {};

// Instructor data
const instructors = {
    [process.env.PHONE_NUMBER_ID]: {
        name: 'Raj Agrawal',
        googleCalendarId: 'agrawalraj918@gmail.com',
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
            lastActivity: new Date()
        };
    }
    return userSessions[phone];
}

function updateUserSession(phone, session) {
    session.lastActivity = new Date();
    userSessions[phone] = session;
}

function getInstructor(instructorId) {
    return instructors[instructorId];
}

function getAvailableDates() {
    const dates = [];
    const today = new Date();
    
    for (let i = 1; i <= 30; i++) {
        const date = new Date(today);
        date.setDate(today.getDate() + i);
        
        // Skip weekends
        if (date.getDay() !== 0 && date.getDay() !== 6) {
            dates.push(date.toISOString().split('T')[0]);
        }
        
        // if (dates.length >= 7) break;
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