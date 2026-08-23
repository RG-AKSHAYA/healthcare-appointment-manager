const db = require('../db/db');
const { v4: uuid } = require('uuid');

const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const HOLD_MINUTES = 5; // slot hold window while patient fills the symptom form / confirms

/** Generates candidate slot start times for a doctor on a given date from working hours. */
function generateSlotsForDate(doctorProfile, dateStr) {
  const wh = JSON.parse(doctorProfile.working_hours_json);
  const dow = DOW[new Date(dateStr + 'T00:00:00').getDay()];
  const ranges = wh[dow] || [];
  const duration = doctorProfile.slot_duration_minutes;
  const slots = [];

  for (const [startHHMM, endHHMM] of ranges) {
    let cursor = new Date(`${dateStr}T${startHHMM}:00`);
    const end = new Date(`${dateStr}T${endHHMM}:00`);
    while (cursor.getTime() + duration * 60000 <= end.getTime()) {
      const slotEnd = new Date(cursor.getTime() + duration * 60000);
      slots.push({ start: cursor.toISOString(), end: slotEnd.toISOString() });
      cursor = slotEnd;
    }
  }
  return slots;
}

/** Returns available slots for a doctor/date, excluding leave days and already-taken/held slots. */
function getAvailableSlots(doctorId, dateStr) {
  const doctor = db.prepare('SELECT * FROM doctor_profiles WHERE id=?').get(doctorId);
  if (!doctor) return { slots: [], onLeave: false };

  const leave = db
    .prepare('SELECT 1 FROM doctor_leaves WHERE doctor_id=? AND leave_date=?')
    .get(doctorId, dateStr);
  if (leave) return { slots: [], onLeave: true };

  releaseExpiredHolds();

  const all = generateSlotsForDate(doctor, dateStr);
  const taken = new Set(
    db
      .prepare(
        `SELECT slot_start FROM appointments
         WHERE doctor_id=? AND status IN ('held','confirmed')
         AND slot_start LIKE ?`
      )
      .all(doctorId, dateStr + '%')
      .map((r) => r.slot_start)
  );

  return { slots: all.filter((s) => !taken.has(s.start)), onLeave: false };
}

function releaseExpiredHolds() {
  db.prepare(
    `UPDATE appointments SET status='cancelled'
     WHERE status='held' AND hold_expires_at < datetime('now')`
  ).run();
}

/**
 * Atomically places a short-lived hold on a slot, then the caller confirms it.
 * Double-booking prevention has two layers:
 *  1. Application layer: this runs inside a single SQLite transaction (better-sqlite3
 *     transactions are synchronous, so no other request can interleave), and it
 *     re-checks slot availability immediately before inserting.
 *  2. Database layer: UNIQUE(doctor_id, slot_start) on the appointments table means
 *     even a race that slips past the app-layer check throws a constraint error
 *     instead of creating a duplicate booking - simultaneous requests are handled safely.
 */
function holdSlot(doctorId, patientId, slotStart, slotEnd) {
  releaseExpiredHolds();
  const tx = db.transaction(() => {
    const clash = db
      .prepare(
        `SELECT 1 FROM appointments WHERE doctor_id=? AND slot_start=? AND status IN ('held','confirmed')`
      )
      .get(doctorId, slotStart);
    if (clash) {
      const e = new Error('Slot no longer available');
      e.code = 'SLOT_TAKEN';
      throw e;
    }
    const id = uuid();
    const holdExpires = new Date(Date.now() + HOLD_MINUTES * 60000).toISOString();
    try {
      db.prepare(
        `INSERT INTO appointments (id, patient_id, doctor_id, slot_start, slot_end, status, hold_expires_at)
         VALUES (?, ?, ?, ?, ?, 'held', ?)`
      ).run(id, patientId, doctorId, slotStart, slotEnd, holdExpires);
    } catch (err) {
      // UNIQUE constraint violation = another request won the race between our
      // SELECT check and this INSERT. Surface the same friendly error.
      if (String(err.message).includes('UNIQUE')) {
        const e = new Error('Slot no longer available');
        e.code = 'SLOT_TAKEN';
        throw e;
      }
      throw err;
    }
    return id;
  });
  return tx();
}

function confirmAppointment(appointmentId) {
  const info = db
    .prepare(`UPDATE appointments SET status='confirmed', updated_at=datetime('now') WHERE id=? AND status='held'`)
    .run(appointmentId);
  if (info.changes === 0) {
    const e = new Error('Hold expired or appointment not found');
    e.code = 'HOLD_EXPIRED';
    throw e;
  }
  return db.prepare('SELECT * FROM appointments WHERE id=?').get(appointmentId);
}

module.exports = {
  generateSlotsForDate,
  getAvailableSlots,
  holdSlot,
  confirmAppointment,
  releaseExpiredHolds,
  HOLD_MINUTES,
};
