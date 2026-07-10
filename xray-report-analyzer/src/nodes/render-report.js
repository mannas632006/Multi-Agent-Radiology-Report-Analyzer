// Node 9 — Render Report
// Renders the FinalDiagnosticReport JSON to markdown in the Section 7 layout
// order, with the disclaimer as a visually distinct block at BOTH top and
// bottom. HTML/PDF renderers can be added behind config flags (see README).

const r = $json.final_report;

const lines = [];
const section = (title) => { lines.push(''); lines.push(`## ${title}`); lines.push(''); };
const bullets = (arr, empty) => {
  if (!arr || arr.length === 0) { lines.push(`_${empty}_`); return; }
  for (const x of arr) lines.push(`- ${x}`);
};
const disclaimerBlock = () => {
  lines.push('```text');
  lines.push(r.disclaimer);
  lines.push('```');
};

lines.push('# AI-Assisted X-Ray Report Analysis (Research Prototype)');
lines.push('');
disclaimerBlock();

section('Summary');
lines.push(r.summary || '_No summary produced._');

section('Primary Findings');
bullets(r.primary_findings, 'None reported.');

section('Points of Agreement');
bullets(r.points_of_agreement, 'None identified.');

section('Points of Disagreement & Resolution');
if (!r.points_of_disagreement_and_resolution || r.points_of_disagreement_and_resolution.length === 0) {
  lines.push('_No disagreements between specialists._');
} else {
  for (const d of r.points_of_disagreement_and_resolution) {
    lines.push(`- **Point:** ${d.point}`);
    for (const p of (d.positions || [])) lines.push(`  - Position: ${p}`);
    lines.push(`  - **Resolution:** ${d.resolution}`);
  }
}

section('Most Likely Diagnosis');
lines.push(`**${r.most_likely_diagnosis}**`);

section('Differential Diagnoses (Ranked)');
if (!r.differential_diagnoses_ranked || r.differential_diagnoses_ranked.length === 0) {
  lines.push('_None offered._');
} else {
  lines.push('| # | Diagnosis | Likelihood | Supporting rationale |');
  lines.push('|---|-----------|------------|----------------------|');
  r.differential_diagnoses_ranked.forEach((d, i) => {
    const esc = s => String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(`| ${i + 1} | ${esc(d.diagnosis)} | ${d.likelihood} | ${esc(d.supporting_rationale)} |`);
  });
}

section('Confidence Assessment');
lines.push(`**Overall confidence:** ${r.confidence_assessment.overall_confidence}`);
lines.push('');
lines.push(r.confidence_assessment.rationale || '');
lines.push('');
lines.push('**Analysis limitations:**');
bullets(r.confidence_assessment.analysis_limitations, 'None stated.');

section('Recommended Next Clinical Steps');
bullets(r.recommended_next_clinical_steps, 'None offered.');

section('Contributing Specialties');
bullets(r.contributing_specialties, 'None — no critiques completed.');
if (r.missing_critiques && r.missing_critiques.length > 0) {
  lines.push('');
  lines.push('**Missing critiques (failed or timed out):**');
  bullets(r.missing_critiques, '');
}

if ($json.synthesis_unavailable && r.raw_critiques) {
  section('Raw Specialist Critiques (synthesis unavailable)');
  lines.push('```json');
  lines.push(JSON.stringify(r.raw_critiques, null, 2));
  lines.push('```');
}

lines.push('');
lines.push('---');
lines.push('');
disclaimerBlock();

// ---- HTML rendering (for the Form completion page, respondWith=showText) ----
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const h = [];
const ul = (arr, empty) => {
  if (!arr || arr.length === 0) { h.push(`<p class="muted">${empty}</p>`); return; }
  h.push('<ul>' + arr.map(x => `<li>${esc(x)}</li>`).join('') + '</ul>');
};
const disclaimerHtml = () =>
  `<pre class="disclaimer">${esc(r.disclaimer)}</pre>`;

h.push(`<style>
  .xray{max-width:820px;margin:0 auto;padding:24px;font-family:-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5;color:#1a1a1a}
  .xray h1{font-size:1.5rem} .xray h2{font-size:1.1rem;margin-top:1.6rem;border-bottom:1px solid #e5e5e5;padding-bottom:4px}
  .xray pre.disclaimer{background:#fff7d6;border:2px solid #e0b500;border-radius:8px;padding:14px;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:.82rem}
  .xray table{border-collapse:collapse;width:100%;font-size:.9rem} .xray th,.xray td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}
  .xray .muted{color:#888;font-style:italic} .xray .diag{font-size:1.15rem;font-weight:600;color:#0b5}
  .xray .conf{display:inline-block;padding:2px 10px;border-radius:12px;background:#eef;font-weight:600}
</style>`);
h.push('<div class="xray">');
h.push('<h1>AI-Assisted X-Ray Report Analysis <span class="muted">(Research Prototype)</span></h1>');
h.push(disclaimerHtml());
h.push('<h2>Summary</h2>'); h.push(`<p>${esc(r.summary) || '<span class="muted">No summary produced.</span>'}</p>`);
h.push('<h2>Primary Findings</h2>'); ul(r.primary_findings, 'None reported.');
h.push('<h2>Points of Agreement</h2>'); ul(r.points_of_agreement, 'None identified.');
h.push('<h2>Points of Disagreement &amp; Resolution</h2>');
if (!r.points_of_disagreement_and_resolution || r.points_of_disagreement_and_resolution.length === 0) {
  h.push('<p class="muted">No disagreements between specialists.</p>');
} else {
  for (const d of r.points_of_disagreement_and_resolution) {
    h.push(`<p><strong>${esc(d.point)}</strong></p><ul>` +
      (d.positions || []).map(p => `<li>${esc(p)}</li>`).join('') +
      `</ul><p><em>Resolution:</em> ${esc(d.resolution)}</p>`);
  }
}
h.push('<h2>Most Likely Diagnosis</h2>'); h.push(`<p class="diag">${esc(r.most_likely_diagnosis)}</p>`);
h.push('<h2>Differential Diagnoses (Ranked)</h2>');
if (!r.differential_diagnoses_ranked || r.differential_diagnoses_ranked.length === 0) {
  h.push('<p class="muted">None offered.</p>');
} else {
  h.push('<table><tr><th>#</th><th>Diagnosis</th><th>Likelihood</th><th>Rationale</th></tr>' +
    r.differential_diagnoses_ranked.map((d, i) =>
      `<tr><td>${i + 1}</td><td>${esc(d.diagnosis)}</td><td>${esc(d.likelihood)}</td><td>${esc(d.supporting_rationale)}</td></tr>`).join('') +
    '</table>');
}
h.push('<h2>Confidence Assessment</h2>');
h.push(`<p><span class="conf">${esc(r.confidence_assessment.overall_confidence)}</span></p>`);
h.push(`<p>${esc(r.confidence_assessment.rationale)}</p>`);
h.push('<p><strong>Analysis limitations:</strong></p>'); ul(r.confidence_assessment.analysis_limitations, 'None stated.');
h.push('<h2>Recommended Next Clinical Steps</h2>'); ul(r.recommended_next_clinical_steps, 'None offered.');
h.push('<h2>Contributing Specialties</h2>'); ul(r.contributing_specialties, 'None — no critiques completed.');
if (r.missing_critiques && r.missing_critiques.length > 0) {
  h.push('<p><strong>Missing critiques (failed or timed out):</strong></p>'); ul(r.missing_critiques, '');
}
h.push('<hr>'); h.push(disclaimerHtml());
h.push('</div>');
const html = h.join('\n');

return [{
  json: {
    markdown: lines.join('\n'),
    html,
    final_report: r,
    error_report: $json.error_report,
    synthesis_unavailable: $json.synthesis_unavailable,
    synthesis_error: $json.synthesis_error || '',
    original: $json.original,
    __t_start: $json.__t_start,
    __t_triage_ms: $json.__t_triage_ms,
    __t_fanout_ms: $json.__t_fanout_ms,
    __t_synthesis_ms: $json.__t_synthesis_ms,
    __agent_timings: $json.__agent_timings,
    __synthesis_usage: $json.__synthesis_usage || null,
  },
}];
