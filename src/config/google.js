const { google } = require('googleapis');

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.REMOVED_SECRET,
    process.env.GOOGLE_REDIRECT_URL
);

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

module.exports = {
    oauth2Client,
    calendar
};