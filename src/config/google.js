const { google } = require('googleapis');

const newClient = () =>
  new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URL
  );

/**
 * A fresh Google client for one instructor's refresh token. Never share one
 * client between instructors: credentials set on a shared client can leak into
 * another instructor's request that's running at the same time.
 */
function clientFor(refreshToken) {
  const client = newClient();
  if (refreshToken) client.setCredentials({ refresh_token: refreshToken });
  return client;
}

// Calls must pass `auth: clientFor(...)`; this has no credentials of its own
const calendar = google.calendar({ version: 'v3' });

module.exports = {
  newClient,
  clientFor,
  calendar,
};
