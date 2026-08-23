const express = require('express');
const db = require('../db/db');
const { requireAuth } = require('../middleware/auth');
const { getAvailableSlots } = require('../services/slotService');

const router = express.Router();

// Search doctors by specialisation (patients browse before booking).
router.get('/', requireAuth, (req, res) => {
  const { specialisation } = req.query;
  let rows;
  if (specialisation) {
    rows = db
      .prepare(
        `SELECT dp.id as doctorId, dp.specialisation, dp.slot_duration_minutes, dp.bio, u.name, u.email
         FROM doctor_profiles dp JOIN users u ON u.id = dp.user_id
         WHERE dp.specialisation LIKE ?`
      )
      .all(`%${specialisation}%`);
  } else {
    rows = db
      .prepare(
        `SELECT dp.id as doctorId, dp.specialisation, dp.slot_duration_minutes, dp.bio, u.name, u.email
         FROM doctor_profiles dp JOIN users u ON u.id = dp.user_id`
      )
      .all();
  }
  res.json(rows);
});

router.get('/:doctorId/slots', requireAuth, (req, res) => {
  const { date } = req.query; // YYYY-MM-DD
  if (!date) return res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' });
  const result = getAvailableSlots(req.params.doctorId, date);
  res.json(result);
});

module.exports = router;
