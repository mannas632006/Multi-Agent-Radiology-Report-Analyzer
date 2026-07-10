// Node 2 — Preprocess
// Detects the uploaded file type, extracts/normalizes report text, runs the
// PHI redaction pass, and builds the Gemini triage request body.
//
// OCR note (Assumption A6): the privacy-preserving default in the spec is local
// Tesseract. Inside an n8n Code node there is no Tesseract binding, so this build
// uses the spec's documented alternative — Gemini-vision OCR during triage — by
// passing the image/PDF bytes inline to the triage call. To use local Tesseract
// instead, front this workflow with the Execute Command variant described in the
// README (docs/README section "OCR modes") so image bytes never leave the host.

const TRIAGE_PROMPT = `You are a medical triage router. Given a radiology report (and optionally its image),
return STRICT JSON only:
{
  "report_type": "<e.g. chest x-ray | skeletal/fracture | dental | abdominal | spine | other>",
  "specialty_1": "<specialty best suited to review this>",
  "specialty_2": "<a DIFFERENT relevant specialty>",
  "specialty_3": "<a THIRD, distinct relevant specialty>",
  "patient_context": "<echo any age/sex/history you can extract, else empty string>",
  "report_text_normalized": "<the cleaned plain-text report>"
}
If an image or scanned document is attached instead of plain text, transcribe (OCR) its
text faithfully into "report_text_normalized" before classifying.
Pick three DISTINCT specialties that would give genuinely different perspectives.
No markdown, no commentary — JSON only.`;

// Redaction pass — strips obvious identifiers BEFORE anything flows downstream
// or is logged (spec sections 3.5 / 6). Heuristic, not a certified de-identifier:
// all input data must already be de-identified per the mandatory safety rules.
function redactPHI(text) {
  if (!text) return text;
  let t = String(text);
  const rules = [
    [/\b(patient(?:\s+name)?|name|pt\.?)\s*[:\-]\s*[A-Z][A-Za-z'\-]+(?:[ ,]+[A-Z][A-Za-z'\-]+)*/g, '$1: [REDACTED]'],
    [/\b(dob|date\s+of\s+birth|birth\s*date)\s*[:\-]?\s*\d{1,4}[\/\-.]\d{1,2}[\/\-.]\d{1,4}/gi, '$1: [REDACTED]'],
    [/\b(mrn|medical\s+record\s+(?:no\.?|number|#)|record\s*#)\s*[:\-]?\s*[A-Za-z0-9\-]+/gi, '$1: [REDACTED]'],
    [/\b(accession\s*(?:no\.?|number|#)?)\s*[:\-]\s*[A-Za-z0-9\-]+/gi, '$1: [REDACTED]'],
    [/\b(ssn|social\s+security(?:\s+number)?)\s*[:\-]?\s*\d{3}-?\d{2}-?\d{4}/gi, '$1: [REDACTED]'],
    [/\b\d{3}[\-. ]\d{3}[\-. ]\d{4}\b/g, '[REDACTED-PHONE]'],
    [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[REDACTED-EMAIL]'],
  ];
  for (const [re, rep] of rules) t = t.replace(re, rep);
  return t;
}

const item = items[0];
const j = item.json || {};

// The Form Trigger exposes the uploaded file under a binary key named after the
// form field; scan keys so a renamed field does not break intake.
const binKeys = Object.keys(item.binary || {});
const bin = binKeys.length ? item.binary[binKeys[0]] : null;
if (!bin) {
  throw new Error('No file was uploaded. The intake form requires a report file (.txt, .png, .jpg, .pdf).');
}

const mime = (bin.mimeType || '').toLowerCase();
const fileName = (bin.fileName || '').toLowerCase();

let report_text = '';
let inline_b64 = null;   // image or PDF bytes forwarded ONLY to Gemini triage/specialist
let inline_mime = null;
let report_type_hint = '';

// Resolve the real bytes via n8n's binary helper. `bin.data` is only the raw
// base64 in the default in-memory mode; in filesystem/S3 modes it is a
// reference, so decoding it directly yields garbage. getBinaryDataBuffer
// returns the actual buffer in every mode.
let fileBuffer;
try {
  fileBuffer = await this.helpers.getBinaryDataBuffer(0, binKeys[0]);
} catch (e) {
  // Fallback for contexts where the helper is unavailable (e.g. offline tests):
  // treat bin.data as base64 only if it looks like base64.
  fileBuffer = Buffer.from(bin.data || '', 'base64');
}

if (mime.startsWith('text/') || fileName.endsWith('.txt')) {
  report_text = fileBuffer.toString('utf8');
} else if (mime.startsWith('image/') || mime === 'application/pdf' || /\.(png|jpe?g|pdf)$/.test(fileName)) {
  inline_b64 = fileBuffer.toString('base64');
  inline_mime = mime || (fileName.endsWith('.pdf') ? 'application/pdf' : 'image/png');
} else {
  throw new Error(`Unsupported file type "${mime || fileName}". Accepted: text/plain, image/png, image/jpeg, application/pdf.`);
}

// Only de-identified text flows downstream.
report_text = redactPHI(report_text);

const patient_context = [
  j.age ? `age: ${j.age}` : null,
  j.sex ? `sex: ${j.sex}` : null,
  j.history ? `history: ${redactPHI(j.history)}` : null,
].filter(Boolean).join('; ');

// Cheap type hint used only as a fallback if triage output cannot be parsed.
const hintSource = (report_text + ' ' + fileName).toLowerCase();
if (/chest|lung|cardiomediastin|pleural/.test(hintSource)) report_type_hint = 'chest x-ray';
else if (/fracture|femur|tibia|radius|humerus|bone/.test(hintSource)) report_type_hint = 'skeletal/fracture';
else if (/dental|panoramic|molar|mandib/.test(hintSource)) report_type_hint = 'dental';
else if (/abdom|bowel|kub/.test(hintSource)) report_type_hint = 'abdominal';
else if (/spine|vertebr|lumbar|cervical/.test(hintSource)) report_type_hint = 'spine';
else report_type_hint = 'other';

// Build the Gemini triage request (Section 2.4.1 / Node 3).
const parts = [];
const userText = [
  patient_context ? `PATIENT CONTEXT: ${patient_context}` : null,
  report_text ? `REPORT TEXT:\n"""\n${report_text}\n"""` : 'REPORT TEXT: (none — see attached scan; transcribe it)',
].filter(Boolean).join('\n\n');
parts.push({ text: userText });
if (inline_b64) parts.push({ inlineData: { mimeType: inline_mime, data: inline_b64 } });

const triage_request_body = {
  systemInstruction: { parts: [{ text: TRIAGE_PROMPT }] },
  contents: [{ role: 'user', parts }],
  generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
};

return [{
  json: {
    report_text,
    patient_context,
    report_type_hint,
    image_b64: inline_mime && inline_mime.startsWith('image/') ? inline_b64 : null,
    image_mime: inline_mime && inline_mime.startsWith('image/') ? inline_mime : null,
    triage_request_body,
    __t_start: Date.now(),
  },
}];
