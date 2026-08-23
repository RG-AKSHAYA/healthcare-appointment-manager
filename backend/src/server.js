require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const doctorRoutes = require('./routes/doctorRoutes');
const appointmentRoutes = require('./routes/appointmentRoutes');
const visitNotesRoutes = require('./routes/visitNotesRoutes');
const calendarRoutes = require('./routes/calendarRoutes');

const { startReminderJob } = require('./jobs/reminderJob');
const { startEmailRetryJob } = require('./jobs/emailRetryJob');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/doctors', doctorRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/visit-notes', visitNotesRoutes);
app.use('/api/calendar', calendarRoutes);

// Centralised error handler so an unexpected exception in any route
// returns JSON instead of crashing the process.
app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Healthcare Appointment API listening on port ${PORT}`);
  startReminderJob();
  startEmailRetryJob();
});
