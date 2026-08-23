const { google } = require('googleapis');
const db = require('../db/db');

// Tokens are stored per-user in a simple key/value fashion inside the users table
// via a JSON column would be cleaner, but to keep the schema minimal we store them
// in-memory + optionally persisted; for production, add a `google_tokens` table
// keyed by user_id. This module degrades gracefully if a user never connected Calendar.
const tokenStore = new Map(); // userId -> {access_token, refresh_token, expiry_date}

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getAuthUrl(state) {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar.events'],
    state,
  });
}

async function handleOAuthCallback(code, userId) {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  tokenStore.set(userId, tokens);
  return tokens;
}

function isConnected(userId) {
  return tokenStore.has(userId);
}

async function getClientForUser(userId) {
  const tokens = tokenStore.get(userId);
  if (!tokens) return null;
  const client = getOAuthClient();
  client.setCredentials(tokens);
  return client;
}

/**
 * Creates a calendar event for a user if they've connected Google Calendar.
 * If not connected, or if the API call fails, this returns null instead of
 * throwing - calendar sync is best-effort and must never block a booking.
 */
async function createEvent(userId, { summary, description, startISO, endISO, attendeeEmail }) {
  try {
    const auth = await getClientForUser(userId);
    if (!auth) return null;
    const calendar = google.calendar({ version: 'v3', auth });
    const res = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary,
        description,
        start: { dateTime: startISO },
        end: { dateTime: endISO },
        attendees: attendeeEmail ? [{ email: attendeeEmail }] : undefined,
        reminders: { useDefault: true },
      },
    });
    return res.data.id;
  } catch (err) {
    console.error(`[calendar] createEvent failed for user ${userId}:`, err.message);
    return null;
  }
}

async function updateEvent(userId, eventId, patch) {
  try {
    const auth = await getClientForUser(userId);
    if (!auth || !eventId) return false;
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.patch({ calendarId: 'primary', eventId, requestBody: patch });
    return true;
  } catch (err) {
    console.error(`[calendar] updateEvent failed for user ${userId}:`, err.message);
    return false;
  }
}

async function deleteEvent(userId, eventId) {
  try {
    const auth = await getClientForUser(userId);
    if (!auth || !eventId) return false;
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.delete({ calendarId: 'primary', eventId });
    return true;
  } catch (err) {
    console.error(`[calendar] deleteEvent failed for user ${userId}:`, err.message);
    return false;
  }
}

module.exports = {
  getAuthUrl,
  handleOAuthCallback,
  isConnected,
  createEvent,
  updateEvent,
  deleteEvent,
};
