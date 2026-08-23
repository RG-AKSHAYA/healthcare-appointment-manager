const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { generatePostVisitSummary } = require('../services/llmService');
const { queueAndSendNow } = require('../services/emailService');

const router = express.Router();
router.use(requireAuth);

// Doctor submits post-visit clinical notes + prescription.
// prescription: [{drug, dosage, frequency_per_day, duration_days, notes}]
router.post('/:appointmentId', requireRole('doctor'), async (req, res) => {
  const { clinical_notes, prescription } = req.body;
  if (!clinical_notes) return res.status(400).json({ error: 'clinical_notes is required' });

  const appt = db.prepare('SELECT * FROM appointments WHERE id=?').get(req.params.appointmentId);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });

  const doctor = db.prepare('SELECT * FROM doctor_profiles WHERE user_id=?').get(req.user.id);
  if (!doctor || doctor.id !== appt.doctor_id) return res.status(403).json({ error: 'Forbidden' });

  const llmResult = await generatePostVisitSummary(clinical_notes, prescription || []);

  db.prepare(
    `INSERT INTO visit_notes (id, appointment_id, clinical_notes, prescription_json, llm_patient_summary, llm_status)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(appointment_id) DO UPDATE SET clinical_notes=excluded.clinical_notes,
       prescription_json=excluded.prescription_json, llm_patient_summary=excluded.llm_patient_summary,
       llm_status=excluded.llm_status`
  ).run(
    uuid(),
    appt.id,
    clinical_notes,
    JSON.stringify(prescription || []),
    JSON.stringify({
      summary: llmResult.summary,
      medication_schedule: llmResult.medication_schedule,
      follow_up_steps: llmResult.follow_up_steps,
    }),
    llmResult.status
  );

  db.prepare(`UPDATE appointments SET status='completed', updated_at=datetime('now') WHERE id=?`).run(appt.id);

  // Schedule medication reminders: one row per dose per drug, spread across each drug's duration.
  const scheduled = [];
  for (const item of prescription || []) {
    const perDay = Math.max(1, Number(item.frequency_per_day) || 1);
    const days = Math.max(1, Number(item.duration_days) || 1);
    const intervalHours = 24 / perDay;
    for (let d = 0; d < days; d++) {
      for (let dose = 0; dose < perDay; dose++) {
        const remindAt = new Date(Date.now() + d * 24 * 3600000 + dose * intervalHours * 3600000);
        const id = uuid();
        db.prepare(
          `INSERT INTO medication_reminders (id, appointment_id, patient_id, drug, remind_at) VALUES (?, ?, ?, ?, ?)`
        ).run(id, appt.id, appt.patient_id, `${item.drug} (${item.dosage})`, remindAt.toISOString());
        scheduled.push(id);
      }
    }
  }

  const patient = db.prepare('SELECT * FROM users WHERE id=?').get(appt.patient_id);
  await queueAndSendNow({
    to: patient.email,
    subject: 'Your visit summary is ready',
    body: `Hi ${patient.name},\n\n${llmResult.summary}\n\nMedication schedule: ${llmResult.medication_schedule}\n\nFollow-up: ${llmResult.follow_up_steps}\n\n- Clinic Team`,
    category: 'booking_confirmation',
    appointmentId: appt.id,
  }).catch((e) => console.error(e));

  res.json({ ok: true, postVisitSummary: llmResult, medicationRemindersScheduled: scheduled.length });
});

router.get('/:appointmentId', requireAuth, (req, res) => {
  const notes = db.prepare('SELECT * FROM visit_notes WHERE appointment_id=?').get(req.params.appointmentId);
  if (!notes) return res.status(404).json({ error: 'No visit notes yet' });
  res.json({
    ...notes,
    prescription: JSON.parse(notes.prescription_json || '[]'),
    llm_patient_summary: JSON.parse(notes.llm_patient_summary || '{}'),
  });
});

module.exports = router;
