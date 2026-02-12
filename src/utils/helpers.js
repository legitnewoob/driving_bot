const { userSessions } = require('../models/instructorModel');
const timezoneUtils = require('./timezoneUtils');
const WebhookController = require('../controllers/webhookController');

const MAX_DAYS = 30;


function cleanupSessions() {
    if (!userSessions || Object.keys(userSessions).length === 0) {
        return; // nothing to clean
    }

    const timeOutPeriod =
        (Number(process.env.SESSION_TIMEOUT_MINUTES) || 60) * 60 * 1000;

    const now = timezoneUtils.getCurrentDate();

    Object.keys(userSessions).forEach(phone => {
        const session = userSessions[phone];

        if (!session || !session.lastActivity) return;

        if (now - session.lastActivity > timeOutPeriod) {
            delete userSessions[phone];
        }
    });
}


function cleanUpContexts() {
    if (!userSessions || Object.keys(userSessions).length === 0) {
        return; // nothing to clean
    }

    const timeOutPeriod =
        (Number(process.env.CONTEXT_TIMEOUT_MINUTES) || 10) * 60 * 1000;

    const now = timezoneUtils.getCurrentDate();

    Object.keys(userSessions).forEach(phone => {
        const session = userSessions[phone];

        if (!session || !session.lastActivity) return;

        if (now - session.lastActivity > timeOutPeriod) {
            WebhookController.clearUserConversationHistoryAndContext(phone);
        }
    });
}



// function cleanOldFolders() {
//     const basePath = "message-logs";
//     const folders = fs.readdirSync(basePath);

//     const now = new Date();

//     folders.forEach(folder => {
//         const folderDate = new Date(folder);
//         const diffDays = (now - folderDate) / (1000 * 60 * 60 * 24);

//         if (diffDays > MAX_DAYS) {
//             fs.rmSync(path.join(basePath, folder), { recursive: true, force: true });
//         }
//     });
// }

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
    cleanupSessions, cleanUpContexts
};