const cron = require('node-cron');
const db = require('../db/db');
const { queueAndSendNow } = require('../services/emailService');

/**
 * Runs on REMINDER_CRON schedule. Handles two kinds of reminders:
 *  1. Medication reminders - due doses from medication_reminders table.
 *  2. Appointment reminders - upcoming confirmed appointments within the next 24h
 *     that haven't been reminded yet (tracked via email_outbox category+appointment_id).
 */
function startReminderJob() {
  const schedule = process.env.REMINDER_CRON || '*/15 * * * *';
  cron.schedule(schedule, async () => {
    await sendDueMedicationReminders();
    await sendUpcomingAppointmentReminders();
  });
  console.log(`[jobs] reminder job scheduled: ${schedule}`);
}

async function sendDueMedicationReminders() {
  const due = db
    .prepare(
      `SELECT mr.*, u.name as patient_name, u.email as patient_email
       FROM medication_reminders mr JOIN users u ON u.id = mr.patient_id
       WHERE mr.sent=0 AND mr.remind_at <= datetime('now')`
    )
    .all();

  for (const r of due) {
    await queueAndSendNow({
      to: r.patient_email,
      subject: 'Medication reminder',
      body: `Hi ${r.patient_name},\n\nThis is a reminder to take your medication: ${r.drug}.\n\n- Clinic Team`,
      category: 'med_reminder',
      appointmentId: r.appointment_id,
    }).catch((e) => console.error('med reminder email failed', e.message));
    db.prepare(`UPDATE medication_reminders SET sent=1 WHERE id=?`).run(r.id);
  }
  if (due.length) console.log(`[jobs] sent ${due.length} medication reminder(s)`);
}

async function sendUpcomingAppointmentReminders() {
  const upcoming = db
    .prepare(
      `SELECT a.*, p.name as patient_name, p.email as patient_email, u.name as doctor_name
       FROM appointments a
       JOIN users p ON p.id = a.patient_id
       JOIN doctor_profiles dp ON dp.id = a.doctor_id
       JOIN users u ON u.id = dp.user_id
       WHERE a.status='confirmed'
         AND a.slot_start BETWEEN datetime('now') AND datetime('now', '+24 hours')
         AND NOT EXISTS (
           SELECT 1 FROM email_outbox eo WHERE eo.related_appointment_id = a.id AND eo.category='reminder'
         )`
    )
    .all();

  for (const appt of upcoming) {
    await queueAndSendNow({
      to: appt.patient_email,
      subject: 'Reminder: upcoming appointment',
      body: `Hi ${appt.patient_name},\n\nReminder: you have an appointment with Dr. ${appt.doctor_name} at ${appt.slot_start}.\n\n- Clinic Team`,
      category: 'reminder',
      appointmentId: appt.id,
    }).catch((e) => console.error('appt reminder email failed', e.message));
  }
  if (upcoming.length) console.log(`[jobs] sent ${upcoming.length} appointment reminder(s)`);
}

module.exports = { startReminderJob };
