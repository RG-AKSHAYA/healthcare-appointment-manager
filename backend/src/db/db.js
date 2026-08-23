const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const dbPath = process.env.DB_PATH || './data/app.db';
const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK(role IN ('patient','doctor','admin')),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS doctor_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  specialisation TEXT NOT NULL,
  slot_duration_minutes INTEGER NOT NULL DEFAULT 20,
  working_hours_json TEXT NOT NULL, -- {"mon":[["09:00","13:00"],["14:00","17:00"]], ...}
  bio TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS doctor_leaves (
  id TEXT PRIMARY KEY,
  doctor_id TEXT NOT NULL REFERENCES doctor_profiles(id) ON DELETE CASCADE,
  leave_date TEXT NOT NULL, -- YYYY-MM-DD
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(doctor_id, leave_date)
);

-- Appointments: unique constraint on (doctor_id, slot_start) is what prevents double-booking
-- at the database level, on top of an application-level transactional hold.
CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doctor_id TEXT NOT NULL REFERENCES doctor_profiles(id) ON DELETE CASCADE,
  slot_start TEXT NOT NULL, -- ISO datetime
  slot_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'held'
    CHECK(status IN ('held','confirmed','cancelled','completed','rescheduled')),
  hold_expires_at TEXT, -- used while status='held' to implement a short-lived slot hold
  google_event_id_patient TEXT,
  google_event_id_doctor TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(doctor_id, slot_start)
);

CREATE TABLE IF NOT EXISTS symptom_forms (
  id TEXT PRIMARY KEY,
  appointment_id TEXT NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE CASCADE,
  raw_symptoms TEXT NOT NULL,
  duration_days INTEGER,
  severity_patient_reported TEXT,
  llm_summary_json TEXT, -- {urgency, chief_complaint, suggested_questions:[...]}
  llm_status TEXT NOT NULL DEFAULT 'pending' CHECK(llm_status IN ('pending','ok','failed')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS visit_notes (
  id TEXT PRIMARY KEY,
  appointment_id TEXT NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE CASCADE,
  clinical_notes TEXT NOT NULL,
  prescription_json TEXT, -- [{drug, dosage, frequency_per_day, duration_days, notes}]
  llm_patient_summary TEXT,
  llm_status TEXT NOT NULL DEFAULT 'pending' CHECK(llm_status IN ('pending','ok','failed')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS medication_reminders (
  id TEXT PRIMARY KEY,
  appointment_id TEXT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  patient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  drug TEXT NOT NULL,
  remind_at TEXT NOT NULL, -- ISO datetime for this specific dose reminder
  sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Outbox pattern: every email is queued here first, so a transient SMTP failure
-- never breaks the booking/leave/notes flow. A background job retries 'pending'/'failed' rows.
CREATE TABLE IF NOT EXISTS email_outbox (
  id TEXT PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL, -- booking_confirmation | reminder | cancellation | leave_notice | med_reminder
  related_appointment_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_appt_doctor_slot ON appointments(doctor_id, slot_start);
CREATE INDEX IF NOT EXISTS idx_appt_patient ON appointments(patient_id);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON email_outbox(status);
CREATE INDEX IF NOT EXISTS idx_med_reminders_pending ON medication_reminders(sent, remind_at);
`;

db.exec(schema);

module.exports = db;
