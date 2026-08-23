const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const slotService = require('../services/slotService');
const { generatePreVisitSummary } = require('../services/llmService');
const { queueAndSendNow } = require('../services/emailService');
const calendarService = require('../services/calendarService');

const router = express.Router();
router.use(requireAuth);

function getDoctorWithUser(doctorId) {
  return db
    .prepare(
      `SELECT dp.*, u.name as doctor_name, u.email as doctor_email, u.id as doctor_user_id
       FROM doctor_profiles dp JOIN users u ON u.id = dp.user_id WHERE dp.id=?`
    )
    .get(doctorId);
}

// Step 1: patient holds a slot (short-lived, prevents another patient grabbing it
// while this patient is filling out the symptom form).
router.post('/hold', requireRole('patient'), (req, res) => {
  const { doctorId, slotStart, slotEnd } = req.body;
  if (!doctorId || !slotStart || !slotEnd) {
    return res.status(400).json({ error: 'doctorId, slotStart, slotEnd are required' });
  }
  try {
    const appointmentId = slotService.holdSlot(doctorId, req.user.id, slotStart, slotEnd);
    res.status(201).json({ appointmentId, holdMinutes: slotService.HOLD_MINUTES });
  } catch (err) {
    if (err.code === 'SLOT_TAKEN') return res.status(409).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Could not hold slot' });
  }
});

// Step 2: patient submits symptoms -> LLM pre-visit summary -> confirms appointment
// -> emails + calendar events for both patient and doctor.
router.post('/:id/confirm', requireRole('patient'), async (req, res) => {
  const { symptoms, duration_days, severity } = req.body;
  if (!symptoms) return res.status(400).json({ error: 'symptoms is required' });

  const appt = db.prepare('SELECT * FROM appointments WHERE id=?').get(req.params.id);
  if (!appt || appt.patient_id !== req.user.id) return res.status(404).json({ error: 'Appointment not found' });
  if (appt.status !== 'held') return res.status(409).json({ error: `Cannot confirm appointment in status '${appt.status}'` });

  // Confirm first (this is what actually protects the slot / releases the hold window).
  let confirmed;
  try {
    confirmed = slotService.confirmAppointment(req.params.id);
  } catch (err) {
    return res.status(409).json({ error: 'Hold expired, please pick a slot again' });
  }

  // LLM call is best-effort: failure here must not undo the confirmed booking.
  const llmResult = await generatePreVisitSummary(symptoms);
  db.prepare(
    `INSERT INTO symptom_forms (id, appointment_id, raw_symptoms, duration_days, severity_patient_reported, llm_summary_json, llm_status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuid(),
    appt.id,
    symptoms,
    duration_days || null,
    severity || null,
    JSON.stringify({
      urgency: llmResult.urgency,
      chief_complaint: llmResult.chief_complaint,
      suggested_questions: llmResult.suggested_questions,
    }),
    llmResult.status
  );

  const patient = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const doctor = getDoctorWithUser(appt.doctor_id);

  // Email both sides (queued -> outbox -> retried in background if SMTP fails).
  await queueAndSendNow({
    to: patient.email,
    subject: 'Appointment confirmed',
    body: `Hi ${patient.name},\n\nYour appointment with Dr. ${doctor.doctor_name} (${doctor.specialisation}) is confirmed for ${appt.slot_start}.\n\nWe'll send a reminder before your visit.\n\n- Clinic Team`,
    category: 'booking_confirmation',
    appointmentId: appt.id,
  }).catch((e) => console.error(e));

  await queueAndSendNow({
    to: doctor.doctor_email,
    subject: `New appointment: ${patient.name} at ${appt.slot_start}`,
    body: `Hi Dr. ${doctor.doctor_name},\n\nNew appointment confirmed with ${patient.name} at ${appt.slot_start}.\nUrgency (AI triage): ${llmResult.urgency}\nChief complaint: ${llmResult.chief_complaint}\n\nSee the full pre-visit summary in your dashboard.\n\n- Clinic System`,
    category: 'booking_confirmation',
    appointmentId: appt.id,
  }).catch((e) => console.error(e));

  // Calendar sync is best-effort per user (each may or may not have connected Google Calendar).
  const patientEventId = await calendarService.createEvent(patient.id, {
    summary: `Appointment with Dr. ${doctor.doctor_name}`,
    description: `Specialisation: ${doctor.specialisation}`,
    startISO: appt.slot_start,
    endISO: appt.slot_end,
    attendeeEmail: doctor.doctor_email,
  });
  const doctorEventId = await calendarService.createEvent(doctor.doctor_user_id, {
    summary: `Patient visit: ${patient.name}`,
    description: `Chief complaint (AI): ${llmResult.chief_complaint}`,
    startISO: appt.slot_start,
    endISO: appt.slot_end,
    attendeeEmail: patient.email,
  });

  db.prepare(
    `UPDATE appointments SET google_event_id_patient=?, google_event_id_doctor=? WHERE id=?`
  ).run(patientEventId, doctorEventId, appt.id);

  res.json({
    appointment: db.prepare('SELECT * FROM appointments WHERE id=?').get(appt.id),
    preVisitSummary: llmResult,
  });
});

router.get('/mine', (req, res) => {
  let rows;
  if (req.user.role === 'patient') {
    rows = db
      .prepare(
        `SELECT a.*, dp.specialisation, u.name as doctor_name
         FROM appointments a
         JOIN doctor_profiles dp ON dp.id = a.doctor_id
         JOIN users u ON u.id = dp.user_id
         WHERE a.patient_id=? ORDER BY a.slot_start DESC`
      )
      .all(req.user.id);
  } else if (req.user.role === 'doctor') {
    const doctor = db.prepare('SELECT * FROM doctor_profiles WHERE user_id=?').get(req.user.id);
    rows = doctor
      ? db
          .prepare(
            `SELECT a.*, p.name as patient_name, p.email as patient_email
             FROM appointments a JOIN users p ON p.id = a.patient_id
             WHERE a.doctor_id=? ORDER BY a.slot_start DESC`
          )
          .all(doctor.id)
      : [];
  } else {
    rows = db
      .prepare(
        `SELECT a.*, p.name as patient_name, u.name as doctor_name
         FROM appointments a JOIN users p ON p.id=a.patient_id
         JOIN doctor_profiles dp ON dp.id=a.doctor_id JOIN users u ON u.id=dp.user_id
         ORDER BY a.slot_start DESC`
      )
      .all();
  }
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const appt = db.prepare('SELECT * FROM appointments WHERE id=?').get(req.params.id);
  if (!appt) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'patient' && appt.patient_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  if (req.user.role === 'doctor') {
    const doctor = db.prepare('SELECT * FROM doctor_profiles WHERE user_id=?').get(req.user.id);
    if (!doctor || doctor.id !== appt.doctor_id) return res.status(403).json({ error: 'Forbidden' });
  }
  const symptomForm = db.prepare('SELECT * FROM symptom_forms WHERE appointment_id=?').get(appt.id);
  const visitNotes = db.prepare('SELECT * FROM visit_notes WHERE appointment_id=?').get(appt.id);
  res.json({
    ...appt,
    symptomForm: symptomForm
      ? { ...symptomForm, llm_summary: JSON.parse(symptomForm.llm_summary_json || '{}') }
      : null,
    visitNotes: visitNotes ? { ...visitNotes, prescription: JSON.parse(visitNotes.prescription_json || '[]') } : null,
  });
});

// Cancellation by patient or doctor. Frees the slot and notifies + syncs calendar.
router.post('/:id/cancel', async (req, res) => {
  const appt = db.prepare('SELECT * FROM appointments WHERE id=?').get(req.params.id);
  if (!appt) return res.status(404).json({ error: 'Not found' });

  const isPatientOwner = req.user.role === 'patient' && appt.patient_id === req.user.id;
  const doctorProfile = req.user.role === 'doctor' ? db.prepare('SELECT * FROM doctor_profiles WHERE user_id=?').get(req.user.id) : null;
  const isDoctorOwner = doctorProfile && doctorProfile.id === appt.doctor_id;
  if (!isPatientOwner && !isDoctorOwner && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });

  db.prepare(`UPDATE appointments SET status='cancelled', updated_at=datetime('now') WHERE id=?`).run(appt.id);

  const patient = db.prepare('SELECT * FROM users WHERE id=?').get(appt.patient_id);
  const doctor = getDoctorWithUser(appt.doctor_id);

  await queueAndSendNow({
    to: patient.email,
    subject: 'Appointment cancelled',
    body: `Hi ${patient.name},\n\nYour appointment on ${appt.slot_start} with Dr. ${doctor.doctor_name} has been cancelled.\n\n- Clinic Team`,
    category: 'cancellation',
    appointmentId: appt.id,
  }).catch((e) => console.error(e));
  await queueAndSendNow({
    to: doctor.doctor_email,
    subject: 'Appointment cancelled',
    body: `Hi Dr. ${doctor.doctor_name},\n\nThe appointment with ${patient.name} on ${appt.slot_start} has been cancelled.\n\n- Clinic System`,
    category: 'cancellation',
    appointmentId: appt.id,
  }).catch((e) => console.error(e));

  if (appt.google_event_id_patient) await calendarService.deleteEvent(patient.id, appt.google_event_id_patient);
  if (appt.google_event_id_doctor) await calendarService.deleteEvent(doctor.doctor_user_id, appt.google_event_id_doctor);

  res.json({ ok: true });
});

module.exports = router;
