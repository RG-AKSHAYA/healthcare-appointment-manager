const nodemailer = require('nodemailer');
const { v4: uuid } = require('uuid');
const db = require('../db/db');

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST || process.env.SMTP_PASS === 'your_sendgrid_api_key') {
    return null; // not configured -> dev/log mode
  }
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

/**
 * Queue an email in the outbox table instead of sending it inline.
 * This means a booking / leave-notification / prescription flow can never
 * be broken by an SMTP outage - the row just sits as 'pending' and the
 * background retry job (jobs/emailRetryJob.js) picks it up later.
 */
function queueEmail({ to, subject, body, category, appointmentId = null }) {
  const id = uuid();
  db.prepare(
    `INSERT INTO email_outbox (id, to_email, subject, body, category, related_appointment_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, to, subject, body, category, appointmentId);
  return id;
}

async function sendQueuedEmail(row) {
  const t = getTransporter();
  if (!t) {
    // Dev/log fallback: mark as sent so the outbox doesn't loop forever in demo/dev mode.
    console.log(`[EMAIL:DEV-MODE] To:${row.to_email} | Subject:${row.subject}\n${row.body}\n`);
    db.prepare(`UPDATE email_outbox SET status='sent', sent_at=datetime('now') WHERE id=?`).run(row.id);
    return true;
  }
  try {
    await t.sendMail({
      from: process.env.EMAIL_FROM,
      to: row.to_email,
      subject: row.subject,
      text: row.body,
    });
    db.prepare(`UPDATE email_outbox SET status='sent', sent_at=datetime('now') WHERE id=?`).run(row.id);
    return true;
  } catch (err) {
    db.prepare(
      `UPDATE email_outbox SET status='failed', attempts=attempts+1, last_error=? WHERE id=?`
    ).run(err.message, row.id);
    return false;
  }
}

/** Attempts to send immediately; on failure it just stays queued for the retry job. */
async function queueAndSendNow(args) {
  const id = queueEmail(args);
  const row = db.prepare('SELECT * FROM email_outbox WHERE id=?').get(id);
  await sendQueuedEmail(row);
  return id;
}

module.exports = { queueEmail, sendQueuedEmail, queueAndSendNow };
