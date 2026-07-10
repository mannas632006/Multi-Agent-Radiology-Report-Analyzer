// Node — Error Report (zero valid critiques)
// Mandated by Section 2.6: never fabricate a diagnosis. Returns an explicit
// "analysis could not be completed" report with the disclaimer still attached.

const DISCLAIMER = __DISCLAIMER__;

const failures = $json.failures || [];

const final_report = {
  summary: 'Analysis could not be completed — no specialist critiques were produced. ' +
    'All three specialist backends failed or returned unusable output. No diagnostic ' +
    'conclusion is offered.',
  primary_findings: [],
  points_of_agreement: [],
  points_of_disagreement_and_resolution: [],
  most_likely_diagnosis: 'Not determined — analysis could not be completed.',
  differential_diagnoses_ranked: [],
  confidence_assessment: {
    overall_confidence: 'low',
    rationale: 'No specialist critique completed; there is no basis for any conclusion.',
    analysis_limitations: [
      'Zero of three specialist agents produced a valid critique.',
      'This tool is a research/educational prototype and is not FDA/CE-cleared.',
    ],
  },
  recommended_next_clinical_steps: [
    'Have the original report reviewed directly by a licensed radiologist or physician.',
    'Retry the analysis once backend availability is restored.',
  ],
  contributing_specialties: [],
  missing_critiques: failures.map(f =>
    `${f.backend} (${f.specialty || 'specialist'})${f.parse_failed ? ' — returned malformed output' : ''}${f.error ? ` — ${f.error}` : ''}`
  ),
  disclaimer: DISCLAIMER,
};

return [{
  json: {
    final_report,
    error_report: true,
    synthesis_unavailable: false,
    original: $json.original,
    __t_start: $json.__t_start,
    __t_triage_ms: $json.__t_triage_ms,
    __t_fanout_ms: $json.__t_fanout_ms,
    __t_synthesis_ms: 0,
    __agent_timings: $json.__agent_timings,
  },
}];
