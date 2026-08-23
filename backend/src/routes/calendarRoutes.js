const express = require('express');
const { requireAuth } = require('../middleware/auth');
const calendarService = require('../services/calendarService');

const router = express.Router();

// Step 1: frontend redirects the logged-in user here to start Google OAuth consent.
router.get('/connect', requireAuth, (req, res) => {
  const url = calendarService.getAuthUrl(req.user.id); // pass userId as state
  res.json({ url });
});

// Step 2: Google redirects back here after consent.
router.get('/oauth2callback', async (req, res) => {
  const { code, state: userId } = req.query;
  if (!code || !userId) return res.status(400).send('Missing code or state');
  try {
    await calendarService.handleOAuthCallback(code, userId);
    res.send('<h2>Google Calendar connected. You can close this tab and return to the app.</h2>');
  } catch (err) {
    console.error(err);
    res.status(500).send('Calendar connection failed. Please try again.');
  }
});

router.get('/status', requireAuth, (req, res) => {
  res.json({ connected: calendarService.isConnected(req.user.id) });
});

module.exports = router;
