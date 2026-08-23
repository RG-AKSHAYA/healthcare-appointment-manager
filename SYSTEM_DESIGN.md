# System Design Write-up

## 1. Double-booking prevention

Booking is split into **hold** then **confirm**, so a patient can fill out the
symptom form without losing the slot, while no two patients can ever get the
same slot.

- `POST /appointments/hold` runs inside a single synchronous SQLite transaction
  (`better-sqlite3` transactions are atomic and synchronous, so no other request
  can interleave). It re-checks that no `held`/`confirmed` row exists for
  `(doctor_id, slot_start)` immediately before inserting.
- As a second, DB-enforced layer, `appointments` has
  `UNIQUE(doctor_id, slot_start)`. If two requests race past the app-level check,
  the second `INSERT` throws a constraint violation, caught and returned as a
  friendly `409 Slot no longer available`.
- A hold expires after 5 minutes (`hold_expires_at`) and is lazily released
  (flipped to `cancelled`) whenever slots are queried or a new hold is attempted,
  so abandoned bookings free the slot automatically without a separate sweeper.
- `confirmAppointment()` only moves a row `held → confirmed`; if the hold already
  expired, it fails fast and the patient re-picks a slot.

This two-layer approach (transactional check + DB constraint) is safe under
simultaneous booking attempts without external locking infrastructure.

## 2. Doctor leave conflict handling

When an admin marks a doctor on leave for a date:

1. A row is inserted into `doctor_leaves` (unique on `(doctor_id, leave_date)`).
2. All `held`/`confirmed` appointments for that doctor/date are cancelled inside
   one transaction.
3. After commit, every affected patient is emailed individually with the reason,
   and the doctor gets a summary email. Emails go through the outbox (§4), so a
   slow/failing mail provider can't leave appointments half-cancelled.
4. Future slot queries for that doctor/date short-circuit to `onLeave: true`
   before generating candidate slots, so leave days are never offered.

Leave is date-scoped (not time-range) to keep the schema simple; this can be
extended to partial-day leave by storing a time range instead, without touching
the surrounding logic.

## 3. Slot hold mechanism

Slots are generated **on demand** from `doctor_profiles.working_hours_json` and
`slot_duration_minutes` rather than pre-materialized as rows — schema changes
(e.g. a doctor updating their hours) take effect instantly with no backfill.
Availability = generated slots − leave day − existing held/confirmed appointments.

The hold step bridges "patient picked a time" and "patient finished the
multi-field symptom form and clicked confirm." Without it, two patients could
both see a slot as free, both start the form, and one would fail at the very
end with no graceful recovery. With the hold, the second patient sees the slot
disappear (or gets a clear `409`) the moment the first patient holds it, and can
immediately pick another.

## 4. Notification failure handling

All outbound email goes through an **outbox table** (`email_outbox`) instead of
being sent synchronously in the request:

- `queueAndSendNow()` inserts a `pending` row, then attempts one immediate send.
  Success → marked `sent`. Failure (SMTP timeout, auth error, provider outage) →
  marked `failed` with the error recorded, but the **API response still
  succeeds** — users are never blocked by a mail provider being down.
- A background cron job (`emailRetryJob`, every 5 min by default) retries
  `pending`/`failed` rows with `attempts < 5`, incrementing attempts and logging
  the latest error each time. This gives bounded automatic retry without a
  separate queue system (SQS/BullMQ), appropriate at clinic scale.
- With no SMTP configured (e.g. local dev), the system logs the email to console
  and marks it sent immediately, so the full flow can be exercised without a
  real mail provider.
- The same resilience pattern applies to **LLM calls**: both pre-visit and
  post-visit summary generators wrap the Anthropic call in try/catch and return
  a safe, clearly-flagged fallback (`llm_status: 'failed'`) on any error —
  timeout, malformed JSON, missing key — instead of throwing. Bookings and
  post-visit notes always save, with or without a successful AI summary; the
  dashboards show an "AI summary unavailable" notice and fall back to raw text.

## 5. Medication reminders

When post-visit notes are submitted, one `medication_reminders` row is scheduled
per dose (frequency-per-day × duration-days) with an absolute `remind_at`
timestamp spread evenly across the day. A separate cron job (`reminderJob`,
every 15 min by default) queries due, unsent reminders and queues an email for
each — following the same outbox pattern, so a missed tick or transient failure
just means the next run picks it up.

## Trade-offs

SQLite was chosen for zero-ops demo deployment; the same transactional
check-then-insert + UNIQUE constraint pattern for double-booking works
identically on Postgres if horizontal scaling is later needed. Google Calendar
tokens currently live in an in-memory map for simplicity — production should
persist them in a `google_tokens` table keyed by user ID (noted in
`calendarService.js`). Calendar sync and email are best-effort side effects that
never block or roll back core appointment state, favoring availability of the
booking flow over perfect notification consistency.
