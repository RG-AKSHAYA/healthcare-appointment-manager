const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db/db');
const { hashPassword } = require('../services/authService');
const { requireAuth, requireRole } = require('../middleware/auth');
const { queueAndSendNow } = require('../services/emailService');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

// Create a doctor: creates the user row + doctor_profiles row together.
router.post('/doctors', (req, res) => {
  const {
    name,
    email,
    password,
    phone,
    specialisation,
    slot_duration_minutes,
    working_hours, // {"mon":[["09:00","13:00"]], "tue":[...], ...}
    bio,
  } = req.body;

  if (!name || !email || !password || !specialisation || !working_hours) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const userId = uuid();
  const doctorId = uuid();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO users (id, role, name, email, phone, password_hash) VALUES (?, 'doctor', ?, ?, ?, ?)`
    ).run(userId, name, email, phone || null, hashPassword(password));
    db.prepare(
      `INSERT INTO doctor_profiles (id, user_id, specialisation, slot_duration_minutes, working_hours_json, bio)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(doctorId, userId, specialisation, slot_duration_minutes || 20, JSON.stringify(working_hours), bio || null);
  });
  tx();

  res.status(201).json({ userId, doctorId });
});

router.get('/doctors', (req, res) => {
  const rows = db
    .prepare(
      `SELECT dp.*, u.name, u.email, u.phone FROM doctor_profiles dp JOIN users u ON u.id = dp.user_id`
    )
    .all();
  res.json(rows.map((r) => ({ ...r, working_hours: JSON.parse(r.working_hours_json) })));
});

router.patch('/doctors/:doctorId', (req, res) => {
  const { specialisation, slot_duration_minutes, working_hours, bio } = req.body;
  const doctor = db.prepare('SELECT * FROM doctor_profiles WHERE id=?').get(req.params.doctorId);
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

  db.prepare(
    `UPDATE doctor_profiles SET specialisation=?, slot_duration_minutes=?, working_hours_json=?, bio=? WHERE id=?`
  ).run(
    specialisation || doctor.specialisation,
    slot_duration_minutes || doctor.slot_duration_minutes,
    working_hours ? JSON.stringify(working_hours) : doctor.working_hours_json,
    bio !== undefined ? bio : doctor.bio,
    doctor.id
  );
  res.json({ ok: true });
});

// Mark a doctor on leave for a date. Any existing confirmed/held appointments on that
// date are cancelled and BOTH patient and doctor are notified by email.
router.post('/doctors/:doctorId/leave', (req, res) => {
  const { date, reason } = req.body;
  if (!date) return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });

  const doctorId = req.params.doctorId;
  const doctor = db
    .prepare(`SELECT dp.*, u.name as doctor_name, u.email as doctor_email FROM doctor_profiles dp JOIN users u ON u.id=dp.user_id WHERE dp.id=?`)
    .get(doctorId);
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

  try {
    db.prepare(`INSERT INTO doctor_leaves (id, doctor_id, leave_date, reason) VALUES (?, ?, ?, ?)`).run(
      uuid(),
      doctorId,
      date,
      reason || null
    );
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Leave already recorded for this date' });
    }
    throw err;
  }

  const affected = db
    .prepare(
      `SELECT a.*, p.name as patient_name, p.email as patient_email
       FROM appointments a JOIN users p ON p.id = a.patient_id
       WHERE a.doctor_id=? AND a.status IN ('held','confirmed') AND a.slot_start LIKE ?`
    )
    .all(doctorId, date + '%');

  const notifyList = [];
  const tx = db.transaction(() => {
    for (const appt of affected) {
      db.prepare(`UPDATE appointments SET status='cancelled', updated_at=datetime('now') WHERE id=?`).run(appt.id);
      notifyList.push(appt);
    }
  });
  tx();

  // Fire notifications after the DB transaction commits (email failures must not roll back cancellations).
  notifyList.forEach((appt) => {
    queueAndSendNow({
      to: appt.patient_email,
      subject: 'Your appointment has been cancelled due to doctor leave',
      body: `Hi ${appt.patient_name},\n\nDr. ${doctor.doctor_name} is unavailable on ${date}${
        reason ? ` (${reason})` : ''
      }, so your appointment scheduled at ${appt.slot_start} has been cancelled. Please rebook at your convenience.\n\n- Clinic Team`,
      category: 'leave_notice',
      appointmentId: appt.id,
    }).catch((e) => console.error('email queue failed', e.message));
  });

  if (notifyList.length > 0) {
    queueAndSendNow({
      to: doctor.doctor_email,
      subject: `Leave recorded for ${date} - ${notifyList.length} appointment(s) cancelled`,
      body: `Hi Dr. ${doctor.doctor_name},\n\nYour leave on ${date} has been recorded. ${notifyList.length} existing appointment(s) were cancelled and the affected patients were notified automatically.\n\n- Clinic System`,
      category: 'leave_notice',
    }).catch((e) => console.error('email queue failed', e.message));
  }

  res.json({ ok: true, cancelledAppointments: notifyList.length });
});

router.get('/patients', (req, res) => {
  const rows = db.prepare(`SELECT id, name, email, phone, created_at FROM users WHERE role='patient'`).all();
  res.json(rows);
});

module.exports = router;
