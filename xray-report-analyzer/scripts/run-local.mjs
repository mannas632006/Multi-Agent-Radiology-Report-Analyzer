// Standalone local runner for the Multi-LLM X-Ray Report Analysis pipeline.
//
// Runs the SAME pipeline as the n8n workflow (triage -> 3 concurrent specialist
// critiques -> synthesis -> render), against the real Gemini / Ollama / DeepSeek
// backends, without needing n8n. Node's native Promise.all gives the true
// concurrency the spec calls for (A7). Prompts, schemas, failure handling, PHI
// redaction and the mandatory disclaimer all match src/nodes/*.
//
// Usage:
//   node scripts/run-local.mjs test-data/case-2-ambiguous.txt --age 54 --sex F --history "cough x5d"
//
// Secrets are read from C:\xray-agent\secrets.env (or process.env):
//   GEMINI_API_KEY, DEEPSEEK_API_KEY, OLLAMA_BASE_URL, XRAY_OUT_DIR, model overrides.

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISCLAIMER } from './build-workflow.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// --------------------------------------------------------------- env loading ---
const SECRETS = 'C:\\xray-agent\\secrets.env';
function loadEnv() {
  const env = { ...process.env };
  if (existsSync(SECRETS)) {
    for (const line of readFileSync(SECRETS, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const i = t.indexOf('=');
      const k = t.slice(0, i).trim(), v = t.slice(i + 1).trim();
      if (v && !/PASTE/.test(v) && env[k] == null) env[k] = v;
    }
  }
  return env;
}
const ENV = loadEnv();
const cfg = {
  GEMINI_API_KEY: ENV.GEMINI_API_KEY,
  DEEPSEEK_API_KEY: ENV.DEEPSEEK_API_KEY,
  OLLAMA_BASE: (ENV.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
  OUT_DIR: ENV.XRAY_OUT_DIR || 'C:\\xray-agent\\out',
  GEMINI_TRIAGE_MODEL: ENV.GEMINI_TRIAGE_MODEL || 'gemini-2.5-flash',
  GEMINI_SPECIALIST_MODEL: ENV.GEMINI_SPECIALIST_MODEL || 'gemini-3.5-flash',
  DEEPSEEK_SPECIALIST_MODEL: ENV.DEEPSEEK_SPECIALIST_MODEL || 'deepseek-v4-flash',
  DEEPSEEK_SYNTHESIS_MODEL: ENV.DEEPSEEK_SYNTHESIS_MODEL || 'deepseek-v4-pro',
  OLLAMA_MODEL: ENV.OLLAMA_MODEL || 'llama3.1:8b',
};

// ------------------------------------------------------------------- helpers ---
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

function extractJson(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

async function withTimeout(promise, ms, label) {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); });
  try { return await Promise.race([promise, t]); } finally { clearTimeout(timer); }
}

async function postJson(url, headers, body, timeoutMs) {
  const res = await withTimeout(fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  }), timeoutMs, url);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { throw new Error(`non-JSON response: ${text.slice(0, 200)}`); }
}

// -------------------------------------------------------- schema validation ---
function validateCritique(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
  if (typeof c.specialty_role !== 'string' || !c.specialty_role.trim()) return false;
  const strArr = k => Array.isArray(c[k]) && c[k].every(x => typeof x === 'string');
  for (const k of ['key_observations', 'areas_of_concern', 'differential_considerations',
                   'disagreements_with_original_report', 'recommended_next_steps']) if (!strArr(k)) return false;
  const cl = c.confidence_level;
  if (!cl || typeof cl !== 'object') return false;
  if (!['low', 'medium', 'high'].includes(cl.level)) return false;
  if (typeof cl.rationale !== 'string') return false;
  return true;
}

// ------------------------------------------------------------------ prompts ---
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
Pick three DISTINCT specialties that would give genuinely different perspectives.
No markdown, no commentary — JSON only.`;

const SCHEMA_HELP = `The JSON object MUST have exactly these fields:
{
  "specialty_role": string,
  "key_observations": string[],
  "areas_of_concern": string[],
  "differential_considerations": string[],
  "confidence_level": { "level": "low"|"medium"|"high", "rationale": string },
  "disagreements_with_original_report": string[],
  "recommended_next_steps": string[]
}`;

function specialistPrompt(specialty, t, withImage) {
  return `You are a board-certified ${specialty} reviewing a radiology report as a second-opinion
consultant. You are one of three independent specialists; you cannot see the others' opinions.

Your job is to critique the report below from the specific viewpoint of a ${specialty} —
not to re-write it. Focus on what your specialty would notice, question, or add.

INPUT YOU ARE GIVEN
- Report type: ${t.report_type}
- Patient context (may be partial or empty): ${t.patient_context || '(none provided)'}
- Radiology report text:
  """
  ${t.report_text}
  """
${withImage ? '- An X-ray image is also attached for your direct inspection.' : ''}

RULES
1. Base every observation ONLY on the report text (and image, if attached). Do NOT invent findings.
2. If the report is text-only and you are a text model, analyze the WORDS of the report — do not claim to have seen the image.
3. If something important is missing (e.g. no lateral view, no prior comparison), say so under areas_of_concern.
4. State your confidence honestly and explain it.
5. Output STRICT JSON matching the schema. No markdown, no commentary outside the JSON.

${SCHEMA_HELP}

Return ONLY the JSON object described in the schema.`;
}

function synthesisPrompt() {
  return `You are the Chief Diagnostician. Three independent specialists have each critiqued the same
radiology report. Your job is NOT to concatenate their opinions — it is to RECONCILE them.

You are given: the original report, and the specialist critique JSON objects that completed.

1. Identify where the specialists AGREE (same finding flagged by 2+ of them).
2. Identify where they DISAGREE, and resolve each disagreement with explicit reasoning. If it cannot be resolved, say so and state what would resolve it.
3. Weigh confidence: down-weight findings only one specialist raised; up-weight consensus findings.
4. Account for missing critiques: if fewer than three are present, lower overall confidence and note which perspective is absent.
5. Remember the analysis limitation: text-only agents did not view the image. Reflect this in the confidence assessment.
6. Produce a ranked differential and a single most-likely diagnosis (or "no acute abnormality" if supported).
7. Attach the mandatory disclaimer block VERBATIM (below) as the "disclaimer" field.

Do NOT introduce findings none of the inputs support. Output STRICT JSON matching the final schema. No markdown, no text outside the JSON.

The JSON object MUST have exactly these fields:
{
  "summary": string,
  "primary_findings": string[],
  "points_of_agreement": string[],
  "points_of_disagreement_and_resolution": [ { "point": string, "positions": string[], "resolution": string } ],
  "most_likely_diagnosis": string,
  "differential_diagnoses_ranked": [ { "diagnosis": string, "likelihood": "high"|"moderate"|"low", "supporting_rationale": string } ],
  "confidence_assessment": { "overall_confidence": "low"|"medium"|"high", "rationale": string, "analysis_limitations": string[] },
  "recommended_next_clinical_steps": string[],
  "contributing_specialties": string[],
  "missing_critiques": string[],
  "disclaimer": string
}

MANDATORY DISCLAIMER (copy verbatim into the "disclaimer" field):
${DISCLAIMER}`;
}

// ------------------------------------------------------------- backend calls ---
async function callTriage(t_text, patient_context, image) {
  const parts = [{ text: `${patient_context ? `PATIENT CONTEXT: ${patient_context}\n\n` : ''}REPORT TEXT:\n"""\n${t_text || '(none — see attached scan; transcribe it)'}\n"""` }];
  if (image) parts.push({ inlineData: { mimeType: image.mime, data: image.b64 } });
  const resp = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${cfg.GEMINI_TRIAGE_MODEL}:generateContent`,
    { 'x-goog-api-key': cfg.GEMINI_API_KEY },
    { systemInstruction: { parts: [{ text: TRIAGE_PROMPT }] }, contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } },
    30000);
  return extractJson(resp?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') ?? '');
}

const geminiSchema = {
  type: 'object',
  properties: {
    specialty_role: { type: 'string' },
    key_observations: { type: 'array', items: { type: 'string' } },
    areas_of_concern: { type: 'array', items: { type: 'string' } },
    differential_considerations: { type: 'array', items: { type: 'string' } },
    confidence_level: { type: 'object', properties: { level: { type: 'string', enum: ['low', 'medium', 'high'] }, rationale: { type: 'string' } }, required: ['level', 'rationale'] },
    disagreements_with_original_report: { type: 'array', items: { type: 'string' } },
    recommended_next_steps: { type: 'array', items: { type: 'string' } },
  },
  required: ['specialty_role', 'key_observations', 'areas_of_concern', 'differential_considerations', 'confidence_level', 'disagreements_with_original_report', 'recommended_next_steps'],
};

function userPayload(specialty, t, withImage) {
  return JSON.stringify({ specialty_role: specialty, report_type: t.report_type, patient_context: t.patient_context || '', report_text: t.report_text, image_provided: !!withImage });
}

async function callSpecialist(backend, specialty, t, image) {
  const sys = specialistPrompt(specialty, t, backend === 'gemini' && !!image);
  const extract = (raw) => backend === 'gemini' ? (raw?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') ?? '')
    : backend === 'ollama' ? (raw?.message?.content ?? '')
    : (raw?.choices?.[0]?.message?.content ?? '');
  const doCall = async (strict) => {
    const system = sys + (strict ? '\n\nREMINDER: Return ONLY one valid JSON object matching the schema — no markdown, no prose.' : '');
    if (backend === 'gemini') {
      const parts = [{ text: userPayload(specialty, t, !!image) }];
      if (image) parts.push({ inlineData: { mimeType: image.mime, data: image.b64 } });
      return postJson(`https://generativelanguage.googleapis.com/v1beta/models/${cfg.GEMINI_SPECIALIST_MODEL}:generateContent`,
        { 'x-goog-api-key': cfg.GEMINI_API_KEY },
        { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts }],
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: geminiSchema } }, 90000);
    }
    if (backend === 'ollama') {
      return postJson(`${cfg.OLLAMA_BASE}/api/chat`, {},
        { model: cfg.OLLAMA_MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: userPayload(specialty, t, false) }],
          format: 'json', stream: false, options: { temperature: 0.2 } }, 120000);
    }
    return postJson('https://api.deepseek.com/chat/completions', { Authorization: `Bearer ${cfg.DEEPSEEK_API_KEY}` },
      { model: cfg.DEEPSEEK_SPECIALIST_MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: userPayload(specialty, t, false) }],
        response_format: { type: 'json_object' }, temperature: 0.2, thinking: { type: 'disabled' } }, 60000);
  };

  const started = Date.now();
  try {
    let raw = await doCall(false);
    let crit = extractJson(extract(raw));
    if (!validateCritique(crit)) { raw = await doCall(true); crit = extractJson(extract(raw)); }
    if (!validateCritique(crit)) return { backend, specialty, parse_failed: true, ms: Date.now() - started };
    crit.__backend = backend; crit.__image = backend === 'gemini' && !!image; crit.__ms = Date.now() - started;
    crit.specialty_role = crit.specialty_role || specialty;
    return crit;
  } catch (e) {
    return { backend, specialty, failed: true, error: String(e.message || e).slice(0, 300), ms: Date.now() - started };
  }
}

async function callSynthesis(merged, backend) {
  if (backend === 'gemini') {
    // Fallback synthesis on Gemini (for when DeepSeek balance is unavailable).
    // Uses the faster triage-tier model (2.5-flash) — the specialist tier can be slow.
    const resp = await postJson(`https://generativelanguage.googleapis.com/v1beta/models/${cfg.GEMINI_TRIAGE_MODEL}:generateContent`,
      { 'x-goog-api-key': cfg.GEMINI_API_KEY },
      { systemInstruction: { parts: [{ text: synthesisPrompt() }] }, contents: [{ role: 'user', parts: [{ text: JSON.stringify(merged) }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } }, 120000);
    return { report: extractJson(resp?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') ?? ''), usage: resp?.usageMetadata || null };
  }
  const resp = await postJson('https://api.deepseek.com/chat/completions', { Authorization: `Bearer ${cfg.DEEPSEEK_API_KEY}` },
    { model: cfg.DEEPSEEK_SYNTHESIS_MODEL, messages: [{ role: 'system', content: synthesisPrompt() }, { role: 'user', content: JSON.stringify(merged) }],
      response_format: { type: 'json_object' }, reasoning_effort: 'high', thinking: { type: 'enabled' } }, 120000);
  return { report: extractJson(resp?.choices?.[0]?.message?.content ?? ''), usage: resp?.usage || null };
}

// ------------------------------------------------------------------- render ---
function renderMarkdown(r, synthUnavailable) {
  const L = []; const sec = t => { L.push('', `## ${t}`, ''); };
  const bl = (a, e) => { if (!a || !a.length) { L.push(`_${e}_`); return; } for (const x of a) L.push(`- ${x}`); };
  const disc = () => { L.push('```text', r.disclaimer, '```'); };
  L.push('# AI-Assisted X-Ray Report Analysis (Research Prototype)', ''); disc();
  sec('Summary'); L.push(r.summary || '_No summary._');
  sec('Primary Findings'); bl(r.primary_findings, 'None reported.');
  sec('Points of Agreement'); bl(r.points_of_agreement, 'None identified.');
  sec('Points of Disagreement & Resolution');
  if (!r.points_of_disagreement_and_resolution?.length) L.push('_No disagreements._');
  else for (const d of r.points_of_disagreement_and_resolution) { L.push(`- **Point:** ${d.point}`); for (const p of d.positions || []) L.push(`  - Position: ${p}`); L.push(`  - **Resolution:** ${d.resolution}`); }
  sec('Most Likely Diagnosis'); L.push(`**${r.most_likely_diagnosis}**`);
  sec('Differential Diagnoses (Ranked)');
  if (!r.differential_diagnoses_ranked?.length) L.push('_None offered._');
  else { L.push('| # | Diagnosis | Likelihood | Supporting rationale |', '|---|---|---|---|'); r.differential_diagnoses_ranked.forEach((d, i) => L.push(`| ${i + 1} | ${d.diagnosis} | ${d.likelihood} | ${String(d.supporting_rationale).replace(/\|/g, '\\|')} |`)); }
  sec('Confidence Assessment'); L.push(`**Overall confidence:** ${r.confidence_assessment.overall_confidence}`, '', r.confidence_assessment.rationale || '', '', '**Analysis limitations:**'); bl(r.confidence_assessment.analysis_limitations, 'None stated.');
  sec('Recommended Next Clinical Steps'); bl(r.recommended_next_clinical_steps, 'None offered.');
  sec('Contributing Specialties'); bl(r.contributing_specialties, 'None.');
  if (r.missing_critiques?.length) { L.push('', '**Missing critiques:**'); bl(r.missing_critiques, ''); }
  L.push('', '---', ''); disc();
  return L.join('\n');
}

function renderHtml(r) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const H = [];
  const ul = (a, e) => H.push(a && a.length ? '<ul>' + a.map(x => `<li>${esc(x)}</li>`).join('') + '</ul>' : `<p class="muted">${e}</p>`);
  const disc = () => H.push(`<pre class="disclaimer">${esc(r.disclaimer)}</pre>`);
  H.push(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>X-Ray Report Analysis</title><style>
    body{max-width:820px;margin:0 auto;padding:24px;font-family:-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5;color:#1a1a1a}
    h1{font-size:1.5rem} h2{font-size:1.1rem;margin-top:1.6rem;border-bottom:1px solid #e5e5e5;padding-bottom:4px}
    pre.disclaimer{background:#fff7d6;border:2px solid #e0b500;border-radius:8px;padding:14px;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:.82rem}
    table{border-collapse:collapse;width:100%;font-size:.9rem} th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}
    .muted{color:#888;font-style:italic} .diag{font-size:1.15rem;font-weight:600;color:#0b5} .conf{display:inline-block;padding:2px 10px;border-radius:12px;background:#eef;font-weight:600}
  </style></head><body>`);
  H.push('<h1>AI-Assisted X-Ray Report Analysis <span class="muted">(Research Prototype)</span></h1>'); disc();
  H.push('<h2>Summary</h2>'); H.push(`<p>${esc(r.summary)}</p>`);
  H.push('<h2>Primary Findings</h2>'); ul(r.primary_findings, 'None reported.');
  H.push('<h2>Points of Agreement</h2>'); ul(r.points_of_agreement, 'None identified.');
  H.push('<h2>Points of Disagreement &amp; Resolution</h2>');
  if (!r.points_of_disagreement_and_resolution?.length) H.push('<p class="muted">No disagreements.</p>');
  else for (const d of r.points_of_disagreement_and_resolution) H.push(`<p><strong>${esc(d.point)}</strong></p><ul>${(d.positions || []).map(p => `<li>${esc(p)}</li>`).join('')}</ul><p><em>Resolution:</em> ${esc(d.resolution)}</p>`);
  H.push('<h2>Most Likely Diagnosis</h2>'); H.push(`<p class="diag">${esc(r.most_likely_diagnosis)}</p>`);
  H.push('<h2>Differential Diagnoses (Ranked)</h2>');
  if (!r.differential_diagnoses_ranked?.length) H.push('<p class="muted">None offered.</p>');
  else H.push('<table><tr><th>#</th><th>Diagnosis</th><th>Likelihood</th><th>Rationale</th></tr>' + r.differential_diagnoses_ranked.map((d, i) => `<tr><td>${i + 1}</td><td>${esc(d.diagnosis)}</td><td>${esc(d.likelihood)}</td><td>${esc(d.supporting_rationale)}</td></tr>`).join('') + '</table>');
  H.push('<h2>Confidence Assessment</h2>'); H.push(`<p><span class="conf">${esc(r.confidence_assessment.overall_confidence)}</span></p><p>${esc(r.confidence_assessment.rationale)}</p><p><strong>Analysis limitations:</strong></p>`); ul(r.confidence_assessment.analysis_limitations, 'None.');
  H.push('<h2>Recommended Next Clinical Steps</h2>'); ul(r.recommended_next_clinical_steps, 'None offered.');
  H.push('<h2>Contributing Specialties</h2>'); ul(r.contributing_specialties, 'None.');
  if (r.missing_critiques?.length) { H.push('<p><strong>Missing critiques:</strong></p>'); ul(r.missing_critiques, ''); }
  H.push('<hr>'); disc(); H.push('</body></html>');
  return H.join('\n');
}

// --------------------------------------------------------------------- main ---
function parseArgs(argv) {
  const a = { file: null, age: '', sex: '', history: '', noDeepseek: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--age') a.age = argv[++i];
    else if (argv[i] === '--sex') a.sex = argv[++i];
    else if (argv[i] === '--history') a.history = argv[++i];
    else if (argv[i] === '--no-deepseek') a.noDeepseek = true;
    else if (!a.file) a.file = argv[i];
  }
  if (ENV.XRAY_NO_DEEPSEEK === '1') a.noDeepseek = true;
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) { console.error('Usage: node scripts/run-local.mjs <report.txt|.png|.jpg> [--age N --sex X --history "..."]'); process.exit(1); }
  for (const k of ['GEMINI_API_KEY', 'DEEPSEEK_API_KEY']) if (!cfg[k]) { console.error(`Missing ${k} (set it in ${SECRETS})`); process.exit(1); }

  const filePath = join(root, args.file);
  const t0 = Date.now();
  const isImage = /\.(png|jpe?g)$/i.test(args.file);
  const isPdf = /\.pdf$/i.test(args.file);

  let report_text = '', image = null;
  if (isImage || isPdf) {
    image = { b64: readFileSync(filePath).toString('base64'), mime: isPdf ? 'application/pdf' : (/\.png$/i.test(args.file) ? 'image/png' : 'image/jpeg') };
  } else {
    report_text = redactPHI(readFileSync(filePath, 'utf8'));
  }
  const patient_context = [args.age && `age: ${args.age}`, args.sex && `sex: ${args.sex}`, args.history && `history: ${redactPHI(args.history)}`].filter(Boolean).join('; ');

  process.stdout.write('1/4 Triage (Gemini)...            ');
  const triageStart = Date.now();
  let tri = await callTriage(report_text, patient_context, image);
  const DEFAULT = { 'chest x-ray': ['pulmonologist', 'thoracic radiologist', 'cardiothoracic surgeon'] };
  if (!tri || !tri.specialty_1) tri = { report_type: 'chest x-ray', specialty_1: 'pulmonologist', specialty_2: 'thoracic radiologist', specialty_3: 'cardiothoracic surgeon', report_text_normalized: report_text };
  const t = {
    report_type: tri.report_type || 'other',
    patient_context: tri.patient_context || patient_context,
    report_text: (tri.report_text_normalized && tri.report_text_normalized.trim()) || report_text,
    specialties: [tri.specialty_1, tri.specialty_2, tri.specialty_3],
  };
  console.log(`done (${Date.now() - triageStart}ms) -> ${t.report_type}: ${t.specialties.join(', ')}`);

  const specialist3Backend = args.noDeepseek ? 'gemini' : 'deepseek';
  const synthBackend = args.noDeepseek ? 'gemini' : 'deepseek';
  if (args.noDeepseek) console.log('    (--no-deepseek: specialist #3 and synthesis routed to Gemini)');

  process.stdout.write('2/4 Specialist critiques (x3, concurrent)... ');
  const fanStart = Date.now();
  const results = await Promise.all([
    callSpecialist('gemini', t.specialties[0], t, image),
    callSpecialist('ollama', t.specialties[1], t, null),
    callSpecialist(specialist3Backend, t.specialties[2], t, null),
  ]);
  const critiques = results.filter(r => !r.failed && !r.parse_failed);
  const failures = results.filter(r => r.failed || r.parse_failed);
  console.log(`done (${Date.now() - fanStart}ms) -> ${critiques.length}/3 ok` + (failures.length ? `, failed: ${failures.map(f => f.backend).join(',')}` : ''));
  for (const f of failures) console.log(`      ! ${f.backend} (${f.specialty}): ${f.error || 'malformed output'}`);

  let final, synthUnavailable = false, usage = null;
  const contributing = critiques.map(c => `${c.specialty_role} (${c.__backend})`);
  const missing = failures.map(f => `${f.backend} (${f.specialty})${f.parse_failed ? ' — malformed output' : ''}${f.error ? ` — ${f.error}` : ''}`);

  if (critiques.length === 0) {
    console.log('3/4 Synthesis... SKIPPED (zero critiques)');
    final = { summary: 'Analysis could not be completed — no specialist critiques were produced.', primary_findings: [], points_of_agreement: [], points_of_disagreement_and_resolution: [], most_likely_diagnosis: 'Not determined — analysis could not be completed.', differential_diagnoses_ranked: [], confidence_assessment: { overall_confidence: 'low', rationale: 'No specialist critique completed.', analysis_limitations: [] }, recommended_next_clinical_steps: ['Have the report reviewed directly by a licensed radiologist or physician.'], contributing_specialties: [], missing_critiques: missing, disclaimer: DISCLAIMER };
  } else {
    process.stdout.write('3/4 Synthesis (DeepSeek pro, reasoning)... ');
    const sStart = Date.now();
    const merged = { original_report: t.report_text, report_type: t.report_type, patient_context: t.patient_context,
      critiques: critiques.map(({ __backend, __ms, __image, ...c }) => ({ ...c, backend: __backend, analyzed_image: !!__image })), missing_critiques: missing };
    try {
      const s = await callSynthesis(merged, synthBackend); usage = s.usage;
      if (!s.report) throw new Error('synthesis returned malformed JSON');
      final = s.report;
      console.log(`done (${Date.now() - sStart}ms)`);
    } catch (e) {
      synthUnavailable = true;
      console.log(`FAILED (${e.message})`);
      final = { summary: 'SYNTHESIS UNAVAILABLE — reconciliation failed. Raw specialist critiques are the basis below.', primary_findings: critiques.flatMap(c => (c.key_observations || []).map(o => `[${c.specialty_role}] ${o}`)), points_of_agreement: [], points_of_disagreement_and_resolution: [], most_likely_diagnosis: 'Not determined — synthesis unavailable.', differential_diagnoses_ranked: [], confidence_assessment: { overall_confidence: 'low', rationale: `Synthesis backend failed (${e.message}).`, analysis_limitations: [] }, recommended_next_clinical_steps: ['Have a licensed radiologist or physician review the original report and raw critiques.'], contributing_specialties: contributing, missing_critiques: missing, disclaimer: DISCLAIMER };
    }
  }

  // ---- Enforce shape + guarantees (mirrors parse-validate-final.js) ----
  const strArr = v => Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
  final.confidence_assessment = final.confidence_assessment && typeof final.confidence_assessment === 'object' ? final.confidence_assessment : {};
  const ca = final.confidence_assessment;
  ca.overall_confidence = ['low', 'medium', 'high'].includes(ca.overall_confidence) ? ca.overall_confidence : 'low';
  ca.rationale = String(ca.rationale || '');
  ca.analysis_limitations = strArr(ca.analysis_limitations);
  const textOnly = critiques.filter(c => !c.__image).length;
  if (!ca.analysis_limitations.some(l => /text[- ]only|not the image|no image/i.test(l)))
    ca.analysis_limitations.push(image ? `${textOnly} of ${critiques.length} completed agents analyzed the report text only, not the image.` : 'No image was provided; all agents analyzed the report text only.');
  if (!ca.analysis_limitations.some(l => /FDA|CE[- ]cleared/i.test(l)))
    ca.analysis_limitations.push('This tool is a research/educational prototype and is not FDA/CE-cleared.');
  if (!strArr(final.contributing_specialties).length) final.contributing_specialties = contributing;
  final.missing_critiques = [...new Set([...strArr(final.missing_critiques), ...missing])];
  final.disclaimer = DISCLAIMER; // verbatim, always
  delete final.reasoning_content;

  // ---- Render + persist ----
  const markdown = renderMarkdown(final, synthUnavailable);
  mkdirSync(cfg.OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const mdPath = join(cfg.OUT_DIR, `report-${stamp}.md`);
  writeFileSync(mdPath, redactPHI(markdown), 'utf8');
  const htmlPath = join(cfg.OUT_DIR, `report-${stamp}.html`);
  writeFileSync(htmlPath, redactPHI(renderHtml(final)), 'utf8');
  const audit = { timestamp: new Date().toISOString(), source: basename(args.file), report_type: t.report_type,
    total_ms: Date.now() - t0, agents: results.map(r => ({ backend: r.__backend || r.backend, ms: r.__ms || r.ms, ok: !r.failed && !r.parse_failed })),
    synthesis_usage: usage ? { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens } : null,
    synthesis_unavailable: synthUnavailable, missing_critiques: final.missing_critiques,
    overall_confidence: ca.overall_confidence, most_likely_diagnosis: redactPHI(final.most_likely_diagnosis) };
  appendFileSync(join(cfg.OUT_DIR, 'audit.jsonl'), JSON.stringify(audit) + '\n', 'utf8');

  console.log(`4/4 Rendered. Total ${Date.now() - t0}ms\n`);
  console.log('='.repeat(70));
  console.log(markdown);
  console.log('='.repeat(70));
  console.log(`\nSaved (markdown): ${mdPath}`);
  console.log(`Saved (html):     ${htmlPath}`);
  console.log(`Audit:            ${join(cfg.OUT_DIR, 'audit.jsonl')}`);
}

main().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
