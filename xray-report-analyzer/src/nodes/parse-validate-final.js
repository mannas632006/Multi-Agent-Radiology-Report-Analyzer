// Node 8 — Parse & Validate Final
// Extracts choices[0].message.content, validates against FinalDiagnosticReport,
// re-inserts the Section 6 disclaimer VERBATIM (hard requirement), strips any
// reasoning_content, and — per Section 2.6 — if synthesis failed after its
// retry, returns the raw critiques plus an explicit "synthesis unavailable"
// notice. The disclaimer is never dropped.

const DISCLAIMER = __DISCLAIMER__;

const mg = $('Merge Guard').first().json;
const resp = $json;

function extractJson(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
}

const strArr = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);

let final = null;
let synthesis_unavailable = false;
let synthesis_error = '';

if (resp.error) {
  // HTTP node was set to continue-on-fail; the error object lands here after
  // its built-in retry was exhausted.
  synthesis_unavailable = true;
  synthesis_error = String(resp.error.message || resp.error).slice(0, 500);
} else {
  // Accept both response shapes: DeepSeek/OpenAI (choices[].message.content) and
  // Gemini (candidates[].content.parts[].text), so either synthesis backend works.
  const content = resp.choices?.[0]?.message?.content
    ?? resp.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('')
    ?? '';
  final = extractJson(content);
  if (!final) {
    synthesis_unavailable = true;
    synthesis_error = 'synthesis model returned malformed JSON';
  }
}

const contributing = (mg.merged.critiques || []).map(c => `${c.specialty_role} (${c.backend})`);

if (synthesis_unavailable) {
  // Fallback report: raw critiques + explicit notice, disclaimer attached.
  final = {
    summary: 'SYNTHESIS UNAVAILABLE — the reconciliation step failed after retry. The raw, ' +
      'unreconciled specialist critiques are attached below. No synthesized conclusion is offered.',
    primary_findings: (mg.merged.critiques || []).flatMap(c =>
      strArr(c.key_observations).map(o => `[${c.specialty_role}] ${o}`)),
    points_of_agreement: [],
    points_of_disagreement_and_resolution: [],
    most_likely_diagnosis: 'Not determined — synthesis unavailable.',
    differential_diagnoses_ranked: [],
    confidence_assessment: {
      overall_confidence: 'low',
      rationale: `The synthesis backend failed (${synthesis_error}); individual critiques were not reconciled.`,
      analysis_limitations: [],
    },
    recommended_next_clinical_steps: [
      'Have a licensed radiologist or physician review the original report and the raw critiques directly.',
    ],
    contributing_specialties: contributing,
    missing_critiques: mg.merged.missing_critiques || [],
    disclaimer: DISCLAIMER,
    raw_critiques: mg.merged.critiques,
  };
}

// ---- Shape enforcement (FinalDiagnosticReport schema) -----------------------
final.summary = typeof final.summary === 'string' ? final.summary : '';
final.primary_findings = strArr(final.primary_findings);
final.points_of_agreement = strArr(final.points_of_agreement);
final.points_of_disagreement_and_resolution =
  (Array.isArray(final.points_of_disagreement_and_resolution) ? final.points_of_disagreement_and_resolution : [])
    .filter(d => d && typeof d === 'object')
    .map(d => ({
      point: String(d.point || ''),
      positions: strArr(d.positions),
      resolution: String(d.resolution || ''),
    }));
final.most_likely_diagnosis = typeof final.most_likely_diagnosis === 'string'
  ? final.most_likely_diagnosis : 'Not determined.';
final.differential_diagnoses_ranked =
  (Array.isArray(final.differential_diagnoses_ranked) ? final.differential_diagnoses_ranked : [])
    .filter(d => d && typeof d === 'object')
    .map(d => ({
      diagnosis: String(d.diagnosis || ''),
      likelihood: ['high', 'moderate', 'low'].includes(d.likelihood) ? d.likelihood : 'low',
      supporting_rationale: String(d.supporting_rationale || ''),
    }));

const ca = (final.confidence_assessment && typeof final.confidence_assessment === 'object')
  ? final.confidence_assessment : {};
final.confidence_assessment = {
  overall_confidence: ['low', 'medium', 'high'].includes(ca.overall_confidence) ? ca.overall_confidence : 'low',
  rationale: String(ca.rationale || ''),
  analysis_limitations: strArr(ca.analysis_limitations),
};

// Honest-limitations guarantee (Section 6): these two disclosures must always
// be present, whether or not the model included them.
const lims = final.confidence_assessment.analysis_limitations;
const textOnlyCount = (mg.merged.critiques || []).filter(c => !c.analyzed_image).length;
const imgNote = mg.original.image_provided
  ? `${textOnlyCount} of ${(mg.merged.critiques || []).length} completed specialist agents analyzed the report text only, not the image.`
  : 'No image was provided; all agents analyzed the report text only.';
if (!lims.some(l => /text[- ]only|report text only|not the image|no image/i.test(l))) lims.push(imgNote);
if (!lims.some(l => /FDA|CE[- ]cleared|not.*(certified|cleared)/i.test(l))) {
  lims.push('This tool is a research/educational prototype and is not FDA/CE-cleared.');
}

final.recommended_next_clinical_steps = strArr(final.recommended_next_clinical_steps);
final.contributing_specialties = strArr(final.contributing_specialties);
if (final.contributing_specialties.length === 0) final.contributing_specialties = contributing;
final.missing_critiques = strArr(final.missing_critiques);
for (const m of (mg.merged.missing_critiques || [])) {
  if (!final.missing_critiques.includes(m)) final.missing_critiques.push(m);
}

// Hard requirement: disclaimer present and VERBATIM — overwrite unconditionally.
final.disclaimer = DISCLAIMER;

// Never persist or echo the model's thinking trace.
delete final.reasoning_content;

return [{
  json: {
    final_report: final,
    error_report: false,
    synthesis_unavailable,
    synthesis_error,
    original: mg.original,
    __t_start: mg.__t_start,
    __t_triage_ms: mg.__t_triage_ms,
    __t_fanout_ms: mg.__t_fanout_ms,
    __t_synthesis_ms: Date.now() - (mg.__t_start + (mg.__t_triage_ms || 0) + (mg.__t_fanout_ms || 0)),
    __agent_timings: mg.__agent_timings,
    __synthesis_usage: resp.usage || resp.usageMetadata || null,
  },
}];
