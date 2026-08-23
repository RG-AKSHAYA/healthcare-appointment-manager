const axios = require('axios');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const TIMEOUT = Number(process.env.LLM_TIMEOUT_MS || 15000);

/**
 * Calls Claude with a single-turn prompt, requesting JSON-only output.
 * Any failure (timeout, 4xx/5xx, malformed JSON) is caught by the caller;
 * this function either resolves with parsed JSON or throws.
 */
async function callClaudeJSON(systemPrompt, userPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.includes('xxxx')) {
    throw new Error('LLM not configured (missing ANTHROPIC_API_KEY)');
  }

  const response = await axios.post(
    ANTHROPIC_URL,
    {
      model: MODEL,
      max_tokens: 700,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    },
    {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: TIMEOUT,
    }
  );

  const textBlock = (response.data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('LLM returned no text content');

  const cleaned = textBlock.text.trim().replace(/^```json\s*|```$/g, '');
  return JSON.parse(cleaned);
}

/**
 * Pre-visit summary: urgency level, chief complaint, suggested questions.
 * On failure, returns a safe fallback object with llm_status='failed' so the
 * booking flow / doctor dashboard never breaks - the doctor just sees the raw
 * symptom text instead of an AI summary.
 */
async function generatePreVisitSummary(symptoms) {
  const system =
    'You are a clinical intake assistant. Analyse patient-reported symptoms and ' +
    'respond with STRICT JSON only, no prose, no markdown fences, matching this shape: ' +
    '{"urgency":"Low|Medium|High","chief_complaint":"string","suggested_questions":["q1","q2","q3"]}';
  const user = `Analyse these symptoms and return urgency level (Low / Medium / High), chief complaint, and three suggested questions for the doctor. Symptoms: ${symptoms}`;

  try {
    const parsed = await callClaudeJSON(system, user);
    return {
      status: 'ok',
      urgency: parsed.urgency || 'Medium',
      chief_complaint: parsed.chief_complaint || symptoms.slice(0, 140),
      suggested_questions: Array.isArray(parsed.suggested_questions)
        ? parsed.suggested_questions.slice(0, 3)
        : [],
    };
  } catch (err) {
    return {
      status: 'failed',
      error: err.message,
      urgency: 'Medium', // safe default so triage queues still sort sensibly
      chief_complaint: symptoms.slice(0, 140),
      suggested_questions: [],
    };
  }
}

/**
 * Post-visit summary: patient-friendly rewrite of clinical notes + prescription.
 * On failure, falls back to the raw notes/prescription so the patient still
 * receives something useful.
 */
async function generatePostVisitSummary(clinicalNotes, prescription) {
  const system =
    'You are a medical communication assistant. Convert clinical notes into a warm, ' +
    'plain-language summary a patient with no medical background can understand. ' +
    'Respond with STRICT JSON only: {"summary":"string","medication_schedule":"string","follow_up_steps":"string"}';
  const user = `Convert these clinical notes into a patient-friendly summary with medication schedule and follow-up steps.\nNotes: ${clinicalNotes}\nPrescription: ${JSON.stringify(
    prescription || []
  )}`;

  try {
    const parsed = await callClaudeJSON(system, user);
    return {
      status: 'ok',
      summary: parsed.summary || clinicalNotes,
      medication_schedule: parsed.medication_schedule || '',
      follow_up_steps: parsed.follow_up_steps || '',
    };
  } catch (err) {
    return {
      status: 'failed',
      error: err.message,
      summary: `Here are your visit notes from the doctor: ${clinicalNotes}`,
      medication_schedule: (prescription || [])
        .map((p) => `${p.drug}: ${p.dosage}, ${p.frequency_per_day}x/day for ${p.duration_days} days`)
        .join('; '),
      follow_up_steps: 'Please contact the clinic if you have questions about your follow-up.',
    };
  }
}

module.exports = { generatePreVisitSummary, generatePostVisitSummary };
