// Node 10 — Audit Log
// Appends a redacted, PHI-free record per run to <XRAY_OUT_DIR>/audit.jsonl and
// saves the rendered (already de-identified) report next to it.
//
// Retained: timings, model IDs, token counts, error/parse flags, redacted output.
// NEVER retained: raw uploaded files, image bytes, reasoning_content, identifiers.
//
// Requires the n8n process env var: NODE_FUNCTION_ALLOW_BUILTIN=fs,path
// (see README). Logging must never break the pipeline: all failures here are
// swallowed after a console warning.

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

const j = $json;

const record = {
  timestamp: new Date().toISOString(),
  execution_id: $execution.id,
  report_type: j.original ? j.original.report_type : null,
  triage_ms: j.__t_triage_ms || null,
  fanout_ms: j.__t_fanout_ms || null,
  synthesis_ms: j.__t_synthesis_ms || null,
  total_ms: j.__t_start ? Date.now() - j.__t_start : null,
  agents: j.__agent_timings || [],
  synthesis_usage: j.__synthesis_usage
    ? { prompt_tokens: j.__synthesis_usage.prompt_tokens, completion_tokens: j.__synthesis_usage.completion_tokens }
    : null,
  error_report: !!j.error_report,
  synthesis_unavailable: !!j.synthesis_unavailable,
  synthesis_error: j.synthesis_error || null,
  missing_critiques: (j.final_report && j.final_report.missing_critiques) || [],
  overall_confidence: j.final_report ? j.final_report.confidence_assessment.overall_confidence : null,
  most_likely_diagnosis: j.final_report ? redactPHI(j.final_report.most_likely_diagnosis) : null,
  summary_redacted: j.final_report ? redactPHI(j.final_report.summary) : null,
  // Evaluation-plan fields (Section 5.3/5.4) — filled in manually per test run.
  eval: { agreement_rate: null, hallucinations: null, rubric: { plausibility: null, consistency: null, clarity: null } },
};

try {
  const fs = require('fs');
  const path = require('path');
  const outDir = $env.XRAY_OUT_DIR || '/data/xray-agent/out';
  fs.mkdirSync(outDir, { recursive: true });
  fs.appendFileSync(path.join(outDir, 'audit.jsonl'), JSON.stringify(record) + '\n', 'utf8');
  const stamp = record.timestamp.replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(outDir, `report-${stamp}-${$execution.id}.md`), redactPHI(j.markdown), 'utf8');
  if (j.html) fs.writeFileSync(path.join(outDir, `report-${stamp}-${$execution.id}.html`), redactPHI(j.html), 'utf8');
} catch (e) {
  // Never fail the pipeline because of logging. Most likely cause:
  // NODE_FUNCTION_ALLOW_BUILTIN=fs,path not set, or XRAY_OUT_DIR not writable.
  console.log('AUDIT LOG WRITE FAILED (pipeline continues): ' + String(e && e.message ? e.message : e));
}

// Forward the full item so the Form completion node still has `html` to render
// (dropping it here left the completion page blank).
return [{ json: { ...j } }];
