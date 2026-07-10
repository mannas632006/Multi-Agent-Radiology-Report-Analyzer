// Node 4 — Parse Triage
// Validates the triage JSON; on failure falls back to a default specialty triad
// for the detected report_type_hint (the HTTP node already retried once).

const pre = $('Preprocess').first().json;

const DEFAULT_TRIADS = {
  'chest x-ray': ['pulmonologist', 'thoracic radiologist', 'cardiothoracic surgeon'],
  'skeletal/fracture': ['orthopedic surgeon', 'musculoskeletal radiologist', 'emergency physician'],
  'dental': ['oral & maxillofacial radiologist', 'endodontist', 'oral surgeon'],
  'abdominal': ['abdominal radiologist', 'gastroenterologist', 'general surgeon'],
  'spine': ['neuroradiologist', 'spine surgeon', 'physiatrist'],
  'other': ['diagnostic radiologist', 'internal medicine physician', 'emergency physician'],
};

function extractJson(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
}

const rawText = $json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') ?? '';
let t = extractJson(rawText);

let triage_fallback_used = false;
const valid = t && typeof t === 'object'
  && typeof t.report_type === 'string'
  && [t.specialty_1, t.specialty_2, t.specialty_3].every(s => typeof s === 'string' && s.trim());

if (!valid) {
  triage_fallback_used = true;
  const triad = DEFAULT_TRIADS[pre.report_type_hint] || DEFAULT_TRIADS.other;
  t = {
    report_type: pre.report_type_hint || 'other',
    specialty_1: triad[0], specialty_2: triad[1], specialty_3: triad[2],
    patient_context: pre.patient_context,
    report_text_normalized: pre.report_text,
  };
}

// Enforce three DISTINCT specialties; backfill duplicates from the default triad.
const triad = DEFAULT_TRIADS[t.report_type?.toLowerCase?.()] || DEFAULT_TRIADS[pre.report_type_hint] || DEFAULT_TRIADS.other;
const seen = new Set();
const specs = [t.specialty_1, t.specialty_2, t.specialty_3].map(s => String(s || '').trim());
for (let i = 0; i < 3; i++) {
  const key = specs[i].toLowerCase();
  if (!specs[i] || seen.has(key)) {
    specs[i] = triad.find(d => !seen.has(d.toLowerCase())) || triad[i];
  }
  seen.add(specs[i].toLowerCase());
}

const report_text = (t.report_text_normalized && String(t.report_text_normalized).trim())
  ? String(t.report_text_normalized).trim()
  : pre.report_text;

if (!report_text) {
  throw new Error('No report text could be extracted from the upload (empty file and OCR produced nothing).');
}

return [{
  json: {
    report_type: t.report_type || 'other',
    specialty_1: specs[0],
    specialty_2: specs[1],
    specialty_3: specs[2],
    patient_context: t.patient_context || pre.patient_context || '',
    report_text,
    image_b64: pre.image_b64,
    image_mime: pre.image_mime,
    triage_fallback_used,
    __t_start: pre.__t_start,
    __t_triage_ms: Date.now() - pre.__t_start,
  },
}];
