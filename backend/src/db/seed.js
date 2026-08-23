require('dotenv').config();
const { v4: uuid } = require('uuid');
const db = require('./db');
const { hashPassword } = require('../services/authService');

function upsertUser(role, name, email, password, phone) {
  const existing = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (existing) return existing;
  const id = uuid();
  db.prepare(`INSERT INTO users (id, role, name, email, phone, password_hash) VALUES (?, ?, ?, ?, ?, ?)`).run(
    id,
    role,
    name,
    email,
    phone,
    hashPassword(password)
  );
  return db.prepare('SELECT * FROM users WHERE id=?').get(id);
}

const admin = upsertUser('admin', 'Clinic Admin', 'admin@clinic.example.com', 'Admin@123', '9000000000');
const doctorUser = upsertUser('doctor', 'Anita Rao', 'anita.rao@clinic.example.com', 'Doctor@123', '9000000001');
const patientUser = upsertUser('patient', 'Ravi Kumar', 'ravi.kumar@example.com', 'Patient@123', '9000000002');

let doctorProfile = db.prepare('SELECT * FROM doctor_profiles WHERE user_id=?').get(doctorUser.id);
if (!doctorProfile) {
  const workingHours = {
    mon: [['09:00', '13:00'], ['14:00', '17:00']],
    tue: [['09:00', '13:00'], ['14:00', '17:00']],
    wed: [['09:00', '13:00'], ['14:00', '17:00']],
    thu: [['09:00', '13:00'], ['14:00', '17:00']],
    fri: [['09:00', '13:00']],
    sat: [],
    sun: [],
  };
  const id = uuid();
  db.prepare(
    `INSERT INTO doctor_profiles (id, user_id, specialisation, slot_duration_minutes, working_hours_json, bio)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, doctorUser.id, 'General Medicine', 20, JSON.stringify(workingHours), 'MBBS, MD - General Physician');
  doctorProfile = db.prepare('SELECT * FROM doctor_profiles WHERE id=?').get(id);
}

console.log('Seed complete.');
console.log('Admin login   : admin@clinic.example.com / Admin@123');
console.log('Doctor login  : anita.rao@clinic.example.com / Doctor@123');
console.log('Patient login : ravi.kumar@example.com / Patient@123');
console.log('Doctor ID     :', doctorProfile.id);
