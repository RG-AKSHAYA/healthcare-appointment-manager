const cron = require('node-cron');
const db = require('../db/db');
const { sendQueuedEmail } = require('../services/emailService');

const MAX_ATTEMPTS = 5;

/**
 * Retries failed/pending emails from the outbox. This is what makes email
 * delivery reliable despite transient SMTP provider outages: nothing in the
 * booking/leave/notes flow depends on the email actually succeeding inline.
 */
function startEmailRetryJob() {
  const schedule = process.env.EMAIL_RETRY_CRON || '*/5 * * * *';
  cron.schedule(schedule, async () => {
    const pending = db
      .prepare(`SELECT * FROM email_outbox WHERE status IN ('pending','failed') AND attempts < ?`)
      .all(MAX_ATTEMPTS);

    for (const row of pending) {
      await sendQueuedEmail(row);
    }
    if (pending.length) console.log(`[jobs] retried ${pending.length} outbox email(s)`);
  });
  console.log(`[jobs] email retry job scheduled: ${schedule}`);
}

module.exports = { startEmailRetryJob };
