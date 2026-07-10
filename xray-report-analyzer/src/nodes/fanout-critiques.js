// Node 5 — Fan-out Critiques (Assumption A7: true concurrency via Promise.all)
// Fires Gemini + Ollama + DeepSeek specialists concurrently, validates each
// response against the SpecialistCritique schema, retries once with a stricter
// JSON reminder on malformed output, and never lets one backend stall the run
// (per-call timeout 30 s, hard branch ceiling 35 s).
//
// Credentials: n8n Code nodes cannot read the encrypted Credentials store, so
// keys come from process environment variables set for the n8n service
// (GEMINI_API_KEY, DEEPSEEK_API_KEY, OLLAMA_BASE_URL). The HTTP Request nodes in
// this workflow (triage, synthesis) DO use the Credentials store. See README
// "Credentials & environment".

const t = $json;

// Ollama (local) is much slower than the cloud backends, so it gets its own,
// longer per-call budget and the whole fan-out ceiling is sized to match.
const CALL_TIMEOUT_MS = 60000;                                   // gemini / deepseek
const OLLAMA_TIMEOUT_MS = Number($env.OLLAMA_TIMEOUT_MS || 115000);
const HARD_CEILING_MS = Number($env.XRAY_FANOUT_CEILING_MS || 120000);

// When DeepSeek is unavailable (e.g. no account balance -> HTTP 402), route the
// third specialist to Gemini instead. Matches the local runner's --no-deepseek.
const NO_DEEPSEEK = ['1', 'true', 'yes'].includes(String($env.XRAY_NO_DEEPSEEK || '').toLowerCase());

const GEMINI_MODEL = $env.GEMINI_SPECIALIST_MODEL || 'gemini-3.5-flash';
const OLLAMA_MODEL = $env.OLLAMA_MODEL || 'llama3.1:8b';
const DEEPSEEK_MODEL = $env.DEEPSEEK_SPECIALIST_MODEL || 'deepseek-v4-flash';
const OLLAMA_BASE = ($env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');

// ---------------------------------------------------------------- prompts ---
const SCHEMA_FIELDS_HELP = `The JSON object MUST have exactly these fields:
{
  "specialty_role": string,
  "key_observations": string[],            // findings salient to your specialty, grounded in the source
  "areas_of_concern": string[],            // ambiguous findings, missing views, absent priors, red flags
  "differential_considerations": string[], // plausible diagnoses, most-to-least likely
  "confidence_level": { "level": "low"|"medium"|"high", "rationale": string },
  "disagreements_with_original_report": string[], // empty array if none
  "recommended_next_steps": string[]
}`;

function specialistSystemPrompt(job) {
  return `You are a board-certified ${job.specialty} reviewing a radiology report as a second-opinion
consultant. You are one of three independent specialists; you cannot see the others' opinions.

Your job is to critique the report below from the specific viewpoint of a ${job.specialty} —
not to re-write it. Focus on what your specialty would notice, question, or add.

INPUT YOU ARE GIVEN
- Report type: ${t.report_type}
- Patient context (may be partial or empty): ${t.patient_context || '(none provided)'}
- Radiology report text:
  """
  ${t.report_text}
  """
${job.withImage ? '- An X-ray image is also attached for your direct inspection.' : ''}

RULES
1. Base every observation ONLY on the report text (and image, if attached). Do NOT invent findings,
   measurements, or history that are not present or reasonably inferable from the input.
2. If the report is text-only and you are a text model, analyze the WORDS of the report — do not
   claim to have seen the image.
3. If something important is missing from the report (e.g. no lateral view, no prior comparison),
   say so under areas_of_concern.
4. State your confidence honestly and explain it.
5. Output STRICT JSON matching the schema. No markdown, no commentary outside the JSON.

${SCHEMA_FIELDS_HELP}

Return ONLY the JSON object described in the schema.`;
}

function userPayload(job) {
  return JSON.stringify({
    specialty_role: job.specialty,
    report_type: t.report_type,
    patient_context: t.patient_context || '',
    report_text: t.report_text,
    image_provided: !!job.withImage,
  });
}

const STRICT_REMINDER = 'REMINDER: Your previous output was not valid. Return ONLY one valid JSON object exactly matching the schema — no markdown fences, no prose, no trailing text.';

// ------------------------------------------------------- schema validation ---
// Hand-rolled validator (external modules like ajv are not importable in a
// stock n8n Code node). Mirrors schemas/specialist-critique.schema.json.
function validateCritique(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
  if (typeof c.specialty_role !== 'string' || !c.specialty_role.trim()) return false;
  const strArr = k => Array.isArray(c[k]) && c[k].every(x => typeof x === 'string');
  for (const k of ['key_observations', 'areas_of_concern', 'differential_considerations',
                   'disagreements_with_original_report', 'recommended_next_steps']) {
    if (!strArr(k)) return false;
  }
  const cl = c.confidence_level;
  if (!cl || typeof cl !== 'object' || Array.isArray(cl)) return false;
  if (!['low', 'medium', 'high'].includes(cl.level)) return false;
  if (typeof cl.rationale !== 'string') return false;
  return true;
}

function extractJson(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
}

// -------------------------------------------------------- request builders ---
// Gemini-flavored response schema (enforced server-side, Section 2.4.1).
const GEMINI_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    specialty_role: { type: 'string' },
    key_observations: { type: 'array', items: { type: 'string' } },
    areas_of_concern: { type: 'array', items: { type: 'string' } },
    differential_considerations: { type: 'array', items: { type: 'string' } },
    confidence_level: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['low', 'medium', 'high'] },
        rationale: { type: 'string' },
      },
      required: ['level', 'rationale'],
    },
    disagreements_with_original_report: { type: 'array', items: { type: 'string' } },
    recommended_next_steps: { type: 'array', items: { type: 'string' } },
  },
  required: ['specialty_role', 'key_observations', 'areas_of_concern', 'differential_considerations',
             'confidence_level', 'disagreements_with_original_report', 'recommended_next_steps'],
};

function buildRequest(job, strict) {
  const sys = specialistSystemPrompt(job) + (strict ? '\n\n' + STRICT_REMINDER : '');
  if (job.backend === 'gemini') {
    if (!$env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY env var is not set for the n8n process');
    const parts = [{ text: userPayload(job) }];
    if (job.withImage) parts.push({ inlineData: { mimeType: t.image_mime || 'image/png', data: t.image_b64 } });
    return {
      method: 'POST',
      url: `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      headers: { 'x-goog-api-key': $env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
      body: {
        systemInstruction: { parts: [{ text: sys }] },
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
          responseSchema: GEMINI_RESPONSE_SCHEMA,
        },
      },
      json: true,
      timeout: CALL_TIMEOUT_MS,
    };
  }
  if (job.backend === 'ollama') {
    return {
      method: 'POST',
      url: `${OLLAMA_BASE}/api/chat`,
      headers: { 'Content-Type': 'application/json' },
      body: {
        model: OLLAMA_MODEL,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: userPayload(job) },
        ],
        format: 'json',
        stream: false,
        options: { temperature: 0.2 },
      },
      json: true,
      timeout: OLLAMA_TIMEOUT_MS,
    };
  }
  if (job.backend === 'deepseek') {
    if (!$env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY env var is not set for the n8n process');
    return {
      method: 'POST',
      url: 'https://api.deepseek.com/chat/completions',
      headers: { Authorization: `Bearer ${$env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
      body: {
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: userPayload(job) },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        thinking: { type: 'disabled' },
      },
      json: true,
      timeout: CALL_TIMEOUT_MS,
    };
  }
  throw new Error(`Unknown backend: ${job.backend}`);
}

function extractText(backend, raw) {
  if (backend === 'gemini') return raw?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') ?? '';
  if (backend === 'ollama') return raw?.message?.content ?? '';
  if (backend === 'deepseek') return raw?.choices?.[0]?.message?.content ?? '';
  return '';
}

// ------------------------------------------------------------------ runner ---
const jobs = [
  { backend: 'gemini', model: GEMINI_MODEL, specialty: t.specialty_1, withImage: !!t.image_b64 },
  { backend: 'ollama', model: OLLAMA_MODEL, specialty: t.specialty_2, withImage: false },
  NO_DEEPSEEK
    ? { backend: 'gemini', model: GEMINI_MODEL, specialty: t.specialty_3, withImage: false }
    : { backend: 'deepseek', model: DEEPSEEK_MODEL, specialty: t.specialty_3, withImage: false },
];

// Cloud backends occasionally return a transient 5xx/429 (e.g. Gemini 503
// "overloaded"). Retry such calls once after a short backoff before giving up.
function isTransient(e) {
  const s = e && (e.statusCode || e.httpCode || e.status);
  if (s && [429, 500, 502, 503, 504].includes(Number(s))) return true;
  return /\b(429|500|502|503|504)\b|overloaded|ETIMEDOUT|ECONNRESET|socket hang up/i.test(String(e && e.message ? e.message : e));
}
async function httpWithTransientRetry(req) {
  try {
    return await this.helpers.httpRequest(req);
  } catch (e) {
    if (!isTransient(e)) throw e;
    await new Promise(r => setTimeout(r, 1500));
    return await this.helpers.httpRequest(req);
  }
}

const callAgent = async (job) => {
  const started = Date.now();
  try {
    const raw = await httpWithTransientRetry.call(this, buildRequest(job, false));
    let critique = extractJson(extractText(job.backend, raw));
    let rawText = extractText(job.backend, raw);
    if (!validateCritique(critique)) {
      // One retry with the stricter "return ONLY valid JSON" reminder (Section 2.6).
      const raw2 = await httpWithTransientRetry.call(this, buildRequest(job, true));
      rawText = extractText(job.backend, raw2);
      critique = extractJson(rawText);
    }
    if (!validateCritique(critique)) {
      return {
        backend: job.backend, model: job.model, specialty: job.specialty,
        parse_failed: true, raw_text_fallback: String(rawText).slice(0, 4000),
        ms: Date.now() - started,
      };
    }
    critique.__backend = job.backend;
    critique.__model = job.model;
    critique.__image_provided = !!job.withImage;
    critique.__ms = Date.now() - started;
    // Keep the persona honest even if the model paraphrased it.
    critique.specialty_role = critique.specialty_role || job.specialty;
    return critique;
  } catch (e) {
    return {
      backend: job.backend, model: job.model, specialty: job.specialty,
      failed: true, error: String(e && e.message ? e.message : e).slice(0, 500),
      ms: Date.now() - started,
    };
  }
};

// Hard ceiling: the fan-out resolves when all three settle OR at HARD_CEILING_MS,
// whichever comes first, so one hung backend cannot stall the pipeline.
const withCeiling = (p, job) => Promise.race([
  p,
  new Promise(res => setTimeout(() => res({
    backend: job.backend, model: job.model, specialty: job.specialty,
    failed: true, error: `branch ceiling ${HARD_CEILING_MS} ms exceeded`, ms: HARD_CEILING_MS,
  }), HARD_CEILING_MS)),
]);

const results = await Promise.all(jobs.map(j => withCeiling(callAgent(j), j)));

const critiques = results.filter(r => !r.failed && !r.parse_failed);
const failures = results.filter(r => r.failed || r.parse_failed);

return [{
  json: {
    critiques,
    failures,
    original: {
      report_text: t.report_text,
      report_type: t.report_type,
      patient_context: t.patient_context,
      image_provided: !!t.image_b64,
      triage_fallback_used: !!t.triage_fallback_used,
      specialties: [t.specialty_1, t.specialty_2, t.specialty_3],
    },
    // Image bytes are intentionally dropped here — nothing downstream needs
    // them and they must not be persisted (Section 4 / 6).
    __t_start: t.__t_start,
    __t_triage_ms: t.__t_triage_ms,
    __t_fanout_ms: Math.max(...results.map(r => r.ms || r.__ms || 0)),
    __agent_timings: results.map(r => ({
      backend: r.backend || r.__backend, model: r.model || r.__model,
      ms: r.ms || r.__ms, failed: !!r.failed, parse_failed: !!r.parse_failed,
    })),
  },
}];
