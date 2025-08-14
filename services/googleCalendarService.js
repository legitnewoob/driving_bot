const { google } = require('googleapis');
const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URL, GOOGLE_REFRESH_TOKEN } = require('../config');

const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URL
);

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

async function createCalendarEvent(instructor, date, time, userPhone) {
  oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });

  const startDateTime = new Date(`${date}T${time}:00`);
  const endDateTime = new Date(startDateTime.getTime() + 60 * 60 * 1000);

  const event = {
    summary: `Driving Test - ${userPhone}`,
    description: `Driving test booking for phone number: ${userPhone}`,
    start: { dateTime: startDateTime.toISOString(), timeZone: 'America/New_York' },
    end: { dateTime: endDateTime.toISOString(), timeZone: 'America/New_York' },
    attendees: [{ email: instructor.googleCalendarId }]
  };

  const res = await calendar.events.insert({
    calendarId: instructor.googleCalendarId,
    resource: event,
  });

  console.log("Event created:", res.data.htmlLink);
  return res.data;
}

module.exports = { createCalendarEvent, oauth2Client };