// Offline end-to-end simulation of the workflow's Code nodes with mocked LLM
// backends. Exercises the Section 2.6 failure-handling matrix without any
// network access or API keys. Run:  node scripts/simulate-pipeline.mjs
//
// This tests the pipeline LOGIC (parsing, validation, retry, degradation,
// disclaimer enforcement, rendering) — not model quality. Live tests are in
// docs/TESTING.md.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISCLAIMER } from './build-workflow.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);

function loadNode(file) {
  return readFileSync(join(root, 'src', 'nodes', file), 'utf8')
    .replace(/__DISCLAIMER__/g, JSON.stringify(DISCLAIMER));
}

const SOURCES = {
  Preprocess: loadNode('preprocess.js'),
  'Parse Triage': loadNode('parse-triage.js'),
  'Fan-out Critiques': loadNode('fanout-critiques.js'),
  'Merge Guard': loadNode('merge-guard.js'),
  'Error Report': loadNode('error-report.js'),
  'Parse & Validate Final': loadNode('parse-validate-final.js'),
  'Render Report': loadNode('render-report.js'),
  'Audit Log': loadNode('audit-log.js'),
};

const ENV = {
  GEMINI_API_KEY: 'test-key',
  DEEPSEEK_API_KEY: 'test-key',
  OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
  XRAY_OUT_DIR: join(root, '.sim-out'),
};

// ------------------------------------------------------------------- mocks ---
const critiqueFor = (role) => ({
  specialty_role: role,
  key_observations: ['Right lower lobe opacity described in the report.'],
  areas_of_concern: ['No lateral view mentioned.', 'No prior study for comparison.'],
  differential_considerations: ['Community-acquired pneumonia', 'Atelectasis'],
  confidence_level: { level: 'medium', rationale: 'Text-only review; findings are suggestive but unconfirmed.' },
  disagreements_with_original_report: [],
  recommended_next_steps: ['Obtain lateral view', 'Clinical correlation'],
});

function makeHttpMock(scenario) {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts.url);
    const url = opts.url;
    if (url.includes('generativelanguage')) {
      if (scenario.geminiMalformedFirst && calls.filter(u => u.includes('generativelanguage')).length === 1) {
        return { candidates: [{ content: { parts: [{ text: 'Sure! Here is my critique: not json' }] } }] };
      }
      if (scenario.geminiFails) throw new Error('ETIMEDOUT gemini');
      const role = JSON.parse(opts.body.contents[0].parts[0].text).specialty_role;
      return { candidates: [{ content: { parts: [{ text: JSON.stringify(critiqueFor(role)) }] } }] };
    }
    if (url.includes('11434')) {
      if (scenario.ollamaFails) throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
      const role = JSON.parse(opts.body.messages[1].content).specialty_role;
      return { message: { content: JSON.stringify(critiqueFor(role)) } };
    }
    if (url.includes('deepseek')) {
      if (scenario.deepseekFails) throw new Error('503 Service Unavailable');
      const role = JSON.parse(opts.body.messages[1].content).specialty_role;
      return { choices: [{ message: { content: JSON.stringify(critiqueFor(role)) } }] };
    }
    throw new Error('unexpected url ' + url);
  };
  fn.calls = calls;
  return fn;
}

const TRIAGE_RESPONSE = {
  candidates: [{ content: { parts: [{ text: JSON.stringify({
    report_type: 'chest x-ray',
    specialty_1: 'pulmonologist',
    specialty_2: 'thoracic radiologist',
    specialty_3: 'cardiothoracic surgeon',
    patient_context: 'age: 61; sex: M',
    report_text_normalized: 'PA chest radiograph. Patchy opacity in the right lower lobe. Heart size normal. No pleural effusion. IMPRESSION: Right lower lobe opacity, possibly early pneumonia.',
  }) }] } }],
};

const SYNTH_RESPONSE_GOOD = {
  usage: { prompt_tokens: 1500, completion_tokens: 600 },
  choices: [{ message: {
    reasoning_content: 'THINKING TRACE THAT MUST NOT LEAK',
    content: JSON.stringify({
      summary: 'All completed specialists agree on a right lower lobe opacity most consistent with early pneumonia.',
      primary_findings: ['Right lower lobe patchy opacity'],
      points_of_agreement: ['RLL opacity flagged by all specialists'],
      points_of_disagreement_and_resolution: [],
      most_likely_diagnosis: 'Early right lower lobe community-acquired pneumonia',
      differential_diagnoses_ranked: [
        { diagnosis: 'Community-acquired pneumonia', likelihood: 'high', supporting_rationale: 'Consensus finding.' },
        { diagnosis: 'Atelectasis', likelihood: 'moderate', supporting_rationale: 'Alternative for RLL opacity.' },
      ],
      confidence_assessment: { overall_confidence: 'medium', rationale: 'Consensus present but single view.', analysis_limitations: [] },
      recommended_next_clinical_steps: ['Lateral view', 'Clinical correlation'],
      contributing_specialties: [],
      missing_critiques: [],
      disclaimer: 'WRONG DISCLAIMER THAT MUST BE REPLACED',
    }),
  } }],
};

// ------------------------------------------------------------------ runner ---
async function runNode(name, { items, prior, httpRequest }) {
  const src = SOURCES[name];
  const $ = (n) => ({ first: () => ({ json: prior[n] }) });
  const $json = items[0].json;
  const fn = new Function('items', '$json', '$env', '$execution', '$', 'require', 'console',
    `return (async function(){ ${src} }).call(this);`);
  return fn.call({ helpers: { httpRequest } }, items, $json, ENV, { id: 'sim-1' }, $, require_, console);
}

async function runPipeline(scenario) {
  const httpRequest = makeHttpMock(scenario);
  const prior = {};
  const reportTxt = [
    'Patient Name: John Example', 'MRN: 12345678', 'DOB: 01/02/1965', '',
    'EXAM: PA chest radiograph.',
    'FINDINGS: Patchy opacity in the right lower lobe. Heart size normal. No pleural effusion.',
    'IMPRESSION: Right lower lobe opacity, possibly early pneumonia.',
  ].join('\n');

  let items = [{
    json: { age: '61', sex: 'M', history: 'cough and fever x3 days' },
    binary: { report: { data: Buffer.from(reportTxt).toString('base64'), mimeType: 'text/plain', fileName: 'case.txt' } },
  }];

  items = await runNode('Preprocess', { items, prior, httpRequest });
  prior['Preprocess'] = items[0].json;

  // Triage HTTP node (mocked here; HTTP Request node in n8n)
  const triageResp = scenario.triageMalformed
    ? { candidates: [{ content: { parts: [{ text: 'oops not json' }] } }] }
    : TRIAGE_RESPONSE;
  items = await runNode('Parse Triage', { items: [{ json: triageResp }], prior, httpRequest });
  prior['Parse Triage'] = items[0].json;

  items = await runNode('Fan-out Critiques', { items, prior, httpRequest });
  items = await runNode('Merge Guard', { items, prior, httpRequest });
  prior['Merge Guard'] = items[0].json;

  if (items[0].json.has_critiques) {
    // Synthesis HTTP node (mocked; continue-on-fail semantics)
    let synthResp;
    if (scenario.synthesisHttpFails) synthResp = { error: { message: '502 Bad Gateway after retry' } };
    else if (scenario.synthesisMalformed) synthResp = { choices: [{ message: { content: '{{{ nope' } }] };
    else synthResp = SYNTH_RESPONSE_GOOD;
    items = await runNode('Parse & Validate Final', { items: [{ json: synthResp }], prior, httpRequest });
  } else {
    items = await runNode('Error Report', { items, prior, httpRequest });
  }

  items = await runNode('Render Report', { items, prior, httpRequest });
  items = await runNode('Audit Log', { items, prior, httpRequest });
  return items[0].json;
}

// ------------------------------------------------------------------- tests ---
let failures = 0;
const check = (label, cond) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};

const disclaimerCount = (md) => md.split('⚠  IMPORTANT — READ BEFORE USE').length - 1;

console.log('\n[1] Happy path — 3 critiques, synthesis OK');
{
  const out = await runPipeline({});
  const md = out.markdown;
  check('markdown produced', typeof md === 'string' && md.length > 500);
  check('disclaimer appears at top AND bottom', disclaimerCount(md) === 2);
  check('disclaimer is VERBATIM (model tampering overwritten)', out.final_report.disclaimer === DISCLAIMER);
  check('reasoning_content never leaks', !md.includes('THINKING TRACE') && !JSON.stringify(out.final_report).includes('THINKING TRACE'));
  check('PHI redacted (name/MRN/DOB stripped)', !md.includes('John Example') && !md.includes('12345678'));
  check('3 contributing specialties', out.final_report.contributing_specialties.length === 3);
  check('no missing critiques', out.final_report.missing_critiques.length === 0);
  check('text-only limitation disclosed', out.final_report.confidence_assessment.analysis_limitations.some(l => /text only/i.test(l)));
  check('not-FDA-cleared limitation disclosed', out.final_report.confidence_assessment.analysis_limitations.some(l => /FDA/i.test(l)));
}

console.log('\n[2] Degraded backend — Ollama unreachable (2/3 critiques)');
{
  const out = await runPipeline({ ollamaFails: true });
  check('pipeline completed', typeof out.markdown === 'string');
  check('missing_critiques names ollama', out.final_report.missing_critiques.some(m => m.includes('ollama')));
  check('2 contributing specialties', out.final_report.contributing_specialties.length === 2);
}

console.log('\n[3] Malformed specialist JSON — retry-once repair (Gemini bad on 1st call)');
{
  const out = await runPipeline({ geminiMalformedFirst: true });
  check('gemini recovered on retry (3 specialties)', out.final_report.contributing_specialties.length === 3);
}

console.log('\n[4] Zero critiques — explicit error report, no fabricated diagnosis');
{
  const out = await runPipeline({ geminiFails: true, ollamaFails: true, deepseekFails: true });
  check('error report produced', /could not be completed/i.test(out.final_report.summary));
  check('no diagnosis fabricated', /not determined/i.test(out.final_report.most_likely_diagnosis));
  check('disclaimer still attached (top and bottom)', disclaimerCount(out.markdown) === 2);
  check('all 3 failures listed', out.final_report.missing_critiques.length === 3);
}

console.log('\n[5] Synthesis failure — raw critiques + "synthesis unavailable" notice');
{
  const out = await runPipeline({ synthesisHttpFails: true });
  check('synthesis unavailable notice', /SYNTHESIS UNAVAILABLE/.test(out.final_report.summary));
  check('raw critiques attached', out.markdown.includes('Raw Specialist Critiques'));
  check('disclaimer never dropped', disclaimerCount(out.markdown) === 2);
}

console.log('\n[6] Synthesis returns malformed JSON — same fallback path');
{
  const out = await runPipeline({ synthesisMalformed: true });
  check('fallback engaged', /SYNTHESIS UNAVAILABLE/.test(out.final_report.summary));
}

console.log('\n[7] Malformed triage — default specialty triad fallback');
{
  const out = await runPipeline({ triageMalformed: true });
  check('pipeline completed with fallback triad', out.final_report.contributing_specialties.length === 3);
  check('chest triad applied from hint', JSON.stringify(out.final_report.contributing_specialties).includes('pulmonologist'));
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
