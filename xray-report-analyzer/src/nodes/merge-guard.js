// Node 6 — Merge Guard
// Assembles the available critiques, computes missing_critiques, and builds the
// complete DeepSeek synthesis request body. If zero critiques survived, sets
// has_critiques=false so the IF node short-circuits to the error report —
// never a fabricated diagnosis (Section 2.6).

const DISCLAIMER = __DISCLAIMER__;

// When DeepSeek is unavailable (no balance -> HTTP 402), run synthesis on Gemini
// instead (the faster triage-tier model). Matches the local runner --no-deepseek.
const NO_DEEPSEEK = ['1', 'true', 'yes'].includes(String($env.XRAY_NO_DEEPSEEK || '').toLowerCase());

const SYNTH_MODEL = $env.DEEPSEEK_SYNTHESIS_MODEL || 'deepseek-v4-pro';
const GEMINI_SYNTH_MODEL = $env.GEMINI_SYNTHESIS_MODEL || $env.GEMINI_TRIAGE_MODEL || 'gemini-2.5-flash';

const SYNTH_PROMPT = `You are the Chief Diagnostician. Three independent specialists have each critiqued the same
radiology report. Your job is NOT to concatenate their opinions — it is to RECONCILE them.

You are given: the original report, and the specialist critique JSON objects that completed.

Do the following:
1. Identify where the specialists AGREE (same finding flagged by 2+ of them).
2. Identify where they DISAGREE, and resolve each disagreement with explicit reasoning
   (whose view is better supported by the report, and why). If it cannot be resolved from the
   available evidence, say so and state what would resolve it.
3. Weigh confidence: down-weight findings only one specialist raised; up-weight consensus findings.
4. Account for missing critiques: if fewer than three critiques are present, lower overall
   confidence and note which perspective is absent.
5. Remember the analysis limitation: text-only agents did not view the image. Reflect this in
   the confidence assessment.
6. Produce a ranked differential and a single most-likely diagnosis (or "no acute abnormality"
   if that is the supported conclusion).
7. Attach the mandatory disclaimer block VERBATIM (provided below) as the "disclaimer" field.

Base everything on the report and the critiques. Do NOT introduce findings none of the inputs
support. Output STRICT JSON matching the final schema. No markdown, no text outside the JSON.

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
  "disclaimer": string   // the mandatory disclaimer, copied VERBATIM
}

MANDATORY DISCLAIMER (copy verbatim into the "disclaimer" field):
${DISCLAIMER}`;

const critiques = ($json.critiques || []).map(c => {
  // Strip internal bookkeeping before showing critiques to the synthesis model.
  const { __backend, __model, __ms, __image_provided, ...clean } = c;
  return { ...clean, backend: __backend, analyzed_image: !!__image_provided };
});

const missing_critiques = ($json.failures || []).map(f =>
  `${f.backend} (${f.specialty || 'specialist'})${f.parse_failed ? ' — returned malformed output' : ''}${f.error ? ` — ${f.error}` : ''}`
);

const merged = {
  original_report: $json.original.report_text,
  report_type: $json.original.report_type,
  patient_context: $json.original.patient_context,
  critiques,
  missing_critiques,
};

// Build the request for whichever synthesis backend is active. The Synthesis
// HTTP node reads synthesis_url / synthesis_auth_name / synthesis_auth_value /
// synthesis_request_body from here, so switching backends needs no node edits.
let synthesis_request_body, synthesis_url, synthesis_auth_name, synthesis_auth_value, synthesis_backend;

if (NO_DEEPSEEK) {
  synthesis_backend = 'gemini';
  synthesis_url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_SYNTH_MODEL}:generateContent`;
  synthesis_auth_name = 'x-goog-api-key';
  synthesis_auth_value = $env.GEMINI_API_KEY || '';
  synthesis_request_body = {
    systemInstruction: { parts: [{ text: SYNTH_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify(merged) }] }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
  };
} else {
  synthesis_backend = 'deepseek';
  synthesis_url = 'https://api.deepseek.com/chat/completions';
  synthesis_auth_name = 'Authorization';
  synthesis_auth_value = `Bearer ${$env.DEEPSEEK_API_KEY || ''}`;
  synthesis_request_body = {
    model: SYNTH_MODEL,
    messages: [
      { role: 'system', content: SYNTH_PROMPT },
      { role: 'user', content: JSON.stringify(merged) },
    ],
    response_format: { type: 'json_object' },
    reasoning_effort: 'high',
    thinking: { type: 'enabled' },
  };
}

return [{
  json: {
    has_critiques: critiques.length > 0,
    synthesis_request_body,
    synthesis_url,
    synthesis_auth_name,
    synthesis_auth_value,
    synthesis_backend,
    merged,
    original: $json.original,
    failures: $json.failures || [],
    __t_start: $json.__t_start,
    __t_triage_ms: $json.__t_triage_ms,
    __t_fanout_ms: $json.__t_fanout_ms,
    __agent_timings: $json.__agent_timings,
  },
}];
