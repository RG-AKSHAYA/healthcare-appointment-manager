# Healthcare Appointment & Follow-up Manager

A clinic platform with separate **patient**, **doctor**, and **admin** portals.
Patients book appointments and share symptoms in advance; an LLM generates a
pre-visit summary (with urgency) for the doctor and a patient-friendly
post-visit summary after the visit. Both sides get email + Google Calendar
notifications throughout.

- `backend/` — Node.js/Express API, SQLite database (via `better-sqlite3`)
- `frontend/` — Vanilla HTML/CSS/JS, three static portals (patient / doctor / admin)
- `SYSTEM_DESIGN.md` — write-up on double-booking prevention, leave conflicts,
  slot holds, and notification failure handling

---

## 1. Quick start

### Prerequisites
- Node.js 18+
- No external database server needed (SQLite file is created automatically)

### Backend

```bash
cd backend
npm install
cp .env.example .env      # then fill in the values described in section 3
npm run seed               # creates demo admin/doctor/patient accounts
npm run dev                 # starts the API on http://localhost:4000
```

Demo accounts created by `npm run seed`:

| Role    | Email                          | Password    |
|---------|---------------------------------|-------------|
| Admin   | admin@clinic.example.com        | Admin@123   |
| Doctor  | anita.rao@clinic.example.com    | Doctor@123  |
| Patient | ravi.kumar@example.com          | Patient@123 |

### Frontend

The frontend is static HTML/JS — no build step. Serve it with any static file
server, e.g.:

```bash
cd frontend
python3 -m http.server 5500
# open http://localhost:5500/index.html
```

By default the frontend calls the API at `http://localhost:4000/api`. To point
it at a different backend (e.g. after deploying), set `window.API_BASE` before
`js/api.js` loads — e.g. add this to the `<head>` of each HTML file:

```html
<script>window.API_BASE = "https://your-backend.example.com/api";</script>
```

---

## 2. Deploying

🔗 **Live app:** https://healthcare-appointment-manager.netlify.app
🔗 **Live backend API:** https://healthcare-appointment-manager-2qf7.onrender.com/api

**Backend** (Render / Railway / Fly.io / any Node host):
- Set the build command to `npm install` and start command to `npm start`.
- Set all environment variables from `.env.example` in the host's dashboard.
- SQLite's file needs a **persistent disk** — on platforms with ephemeral
  filesystems (e.g. Vercel serverless), either attach a persistent volume or
  swap `better-sqlite3` for a hosted Postgres connection (the schema in
  `src/db/db.js` is close to drop-in ANSI SQL).

**Frontend** (Vercel / Netlify / Render static site):
- Deploy the `frontend/` folder as a static site.
- Set `window.API_BASE` (see above) to your deployed backend URL.
- Add your frontend's deployed origin to CORS if you lock down `cors()` in
  `src/server.js` (it currently allows all origins for ease of grading/demo).

---

## 3. Environment variables (`.env`)

See `backend/.env.example` for the full list with inline comments. Key groups:

- **Server/Auth**: `PORT`, `JWT_SECRET`, `JWT_EXPIRES_IN`
- **Database**: `DB_PATH` (SQLite file location)
- **LLM**: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` — if unset, the app **still
  runs**: LLM calls fail gracefully and fall back to raw text with
  `llm_status: 'failed'` shown in the UI (see SYSTEM_DESIGN.md §4).
- **Email (SMTP)**: `SMTP_HOST/PORT/USER/PASS`, `EMAIL_FROM` — works with
  SendGrid, Mailgun, or Gmail app-password SMTP. If unset, emails are logged to
  the console instead of sent (dev mode) so you can still test the full flow.
- **Google Calendar**: `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI` — see section 6.
- **Background jobs**: `REMINDER_CRON`, `EMAIL_RETRY_CRON` (cron expressions)

---

## 4. Database schema

SQLite file, created automatically by `src/db/db.js` on first run. Key tables:

| Table | Purpose |
|---|---|
| `users` | All accounts (`role` = patient / doctor / admin), bcrypt password hash |
| `doctor_profiles` | Specialisation, slot duration, working hours (JSON), one per doctor user |
| `doctor_leaves` | Leave dates per doctor, unique per `(doctor_id, leave_date)` |
| `appointments` | Core booking record; `status` = held/confirmed/cancelled/completed/rescheduled; `UNIQUE(doctor_id, slot_start)` prevents double-booking |
| `symptom_forms` | Patient-submitted pre-visit symptoms + LLM urgency/summary JSON |
| `visit_notes` | Doctor's clinical notes + prescription JSON + LLM patient-friendly summary |
| `medication_reminders` | One row per scheduled dose reminder, derived from prescription frequency/duration |
| `email_outbox` | Outbox pattern for all email — queued, sent, or failed-with-retry (see SYSTEM_DESIGN.md §4) |

Full column definitions with comments are in `backend/src/db/db.js`.

---

## 5. API reference (summary)

All endpoints except `/auth/*` require `Authorization: Bearer <token>`.

### Auth
- `POST /api/auth/register` — patient self-registration `{name, email, password, phone?}`
- `POST /api/auth/login` — `{email, password}` → `{token, user}`

### Admin (role: admin)
- `POST /api/admin/doctors` — create a doctor `{name, email, password, phone, specialisation, slot_duration_minutes, working_hours, bio}`
- `GET /api/admin/doctors` — list doctors
- `PATCH /api/admin/doctors/:doctorId` — update doctor profile
- `POST /api/admin/doctors/:doctorId/leave` — `{date, reason}` → cancels affected appointments + notifies
- `GET /api/admin/patients` — list patients

### Doctor discovery (any authenticated role)
- `GET /api/doctors?specialisation=` — search doctors
- `GET /api/doctors/:doctorId/slots?date=YYYY-MM-DD` — available slots for a date

### Appointments
- `POST /api/appointments/hold` (patient) — `{doctorId, slotStart, slotEnd}` → short-lived hold
- `POST /api/appointments/:id/confirm` (patient) — `{symptoms, duration_days?, severity?}` → runs LLM pre-visit summary, confirms booking, sends emails + calendar events
- `GET /api/appointments/mine` — role-scoped list (patient sees own, doctor sees their patients, admin sees all)
- `GET /api/appointments/:id` — full detail incl. symptom form + visit notes
- `POST /api/appointments/:id/cancel` — cancels + notifies + removes calendar events

### Visit notes
- `POST /api/visit-notes/:appointmentId` (doctor) — `{clinical_notes, prescription: [{drug, dosage, frequency_per_day, duration_days}]}` → runs LLM post-visit summary, marks appointment completed, schedules medication reminders, emails patient
- `GET /api/visit-notes/:appointmentId` — fetch notes + prescription + AI summary

### Calendar
- `GET /api/calendar/connect` — returns Google OAuth consent URL for the logged-in user
- `GET /api/calendar/oauth2callback` — OAuth redirect target (used by Google, not called directly)
- `GET /api/calendar/status` — `{connected: boolean}`

---

## 6. Google Calendar setup

1. Go to the [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
   and create (or select) a project.
2. Enable the **Google Calendar API** for that project (APIs & Services → Library).
3. Under **APIs & Services → Credentials**, create an **OAuth 2.0 Client ID**
   (type: Web application).
4. Add an authorized redirect URI matching `GOOGLE_REDIRECT_URI` in your `.env`,
   e.g. `http://localhost:4000/api/calendar/oauth2callback` for local dev, or
   your deployed backend URL + `/api/calendar/oauth2callback` in production.
5. Copy the generated **Client ID** and **Client Secret** into
   `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env`.
6. In the app, a logged-in patient or doctor clicks **"Connect Google Calendar"**
   in their dashboard, completes Google's consent screen, and is redirected back.
   From then on, confirmed/cancelled appointments automatically create/delete
   events on their primary calendar. Calendar sync is best-effort — if a user
   never connects, booking still works normally, just without a calendar event.

Note: OAuth tokens are currently held in memory (`calendarService.js`) for
simplicity; restarting the backend requires reconnecting. For production,
persist tokens in a `google_tokens` table keyed by user ID (the file has a
comment marking exactly where to add this).

---

## 7. LLM prompts

Both prompts request **strict JSON** output so responses can be parsed and
stored directly in the database (`symptom_forms.llm_summary_json`,
`visit_notes.llm_patient_summary`).

**Pre-visit summary** (`src/services/llmService.js → generatePreVisitSummary`):
> "Analyse these symptoms and return urgency level (Low / Medium / High), chief
> complaint, and three suggested questions for the doctor. Symptoms: `<symptoms>`"
>
> System prompt constrains output to:
> `{"urgency":"Low|Medium|High","chief_complaint":"string","suggested_questions":["q1","q2","q3"]}`

**Post-visit summary** (`generatePostVisitSummary`):
> "Convert these clinical notes into a patient-friendly summary with medication
> schedule and follow-up steps. Notes: `<notes>` Prescription: `<prescription>`"
>
> System prompt constrains output to:
> `{"summary":"string","medication_schedule":"string","follow_up_steps":"string"}`

If the LLM call fails for any reason (missing/invalid API key, timeout,
malformed JSON), both functions catch the error and return a fallback object
with `status: 'failed'` plus the raw notes/symptoms as a usable substitute —
callers never need their own try/catch and the booking/notes flow never breaks.

---

## 8. Testing the flow locally without real credentials

The system is designed to be fully testable with **zero external services
configured**:
- No `ANTHROPIC_API_KEY` → pre/post-visit "summaries" fall back to the raw text,
  clearly flagged in the UI.
- No SMTP credentials → emails are printed to the backend console instead of
  sent, and marked `sent` in the outbox so the retry job doesn't loop forever.
- No Google OAuth credentials configured / user never connects → calendar event
  creation is silently skipped (`google_event_id_* ` stays `null`).

This means you can seed the database, start the backend, and click through the
entire patient → doctor → admin flow before wiring up any real API keys.
