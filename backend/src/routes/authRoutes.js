const express = require('express');
const { v4: uuid } = require('uuid');
const { body, validationResult } = require('express-validator');
const db = require('../db/db');
const { hashPassword, verifyPassword, signToken } = require('../services/authService');

const router = express.Router();

// Patients self-register. Doctors/admins are created by the admin (see adminRoutes)
// so that clinical staff can't be added by anonymous signup.
router.post(
  '/register',
  body('name').notEmpty(),
  body('email').isEmail(),
  body('password').isLength({ min: 6 }),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { name, email, password, phone } = req.body;
    const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const id = uuid();
    db.prepare(
      `INSERT INTO users (id, role, name, email, phone, password_hash) VALUES (?, 'patient', ?, ?, ?, ?)`
    ).run(id, name, email, phone || null, hashPassword(password));

    const user = { id, role: 'patient', name, email };
    res.status(201).json({ token: signToken(user), user });
  }
);

router.post('/login', body('email').isEmail(), body('password').notEmpty(), (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email, password } = req.body;
  const row = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!row || !verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const user = { id: row.id, role: row.role, name: row.name, email: row.email };
  res.json({ token: signToken(user), user });
});

module.exports = router;
