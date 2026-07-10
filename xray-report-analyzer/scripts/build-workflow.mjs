// Assembles n8n/xray-report-analyzer.workflow.json from the Code-node sources
// in src/nodes/. Run:  node scripts/build-workflow.mjs
//
// The __DISCLAIMER__ token in node sources is replaced with a JS string literal
// of the mandatory Section 6 disclaimer so it exists in exactly one place.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const DISCLAIMER = [
  '──────────────────────────────────────────────────────────────────────────',
  '⚠  IMPORTANT — READ BEFORE USE',
  'This report was produced by an AI-assisted research/educational tool. It is',
  'NOT a certified diagnostic device and must not be treated as one.',
  '',
  '• All output must be reviewed and confirmed by a licensed radiologist or',
  '  physician before ANY clinical decision is made.',
  '• This system must never be deployed to make diagnostic or treatment',
  '  decisions autonomously. A qualified human must remain in the loop at all',
  '  times.',
  '• No real patient-identifying information should be entered, stored, or',
  '  logged. All test and demonstration data must be de-identified.',
  '──────────────────────────────────────────────────────────────────────────',
].join('\n');

function nodeCode(file) {
  const src = readFileSync(join(root, 'src', 'nodes', file), 'utf8');
  return src.replace(/__DISCLAIMER__/g, JSON.stringify(DISCLAIMER));
}

const codeNode = (name, file, position, extra = {}) => ({
  name,
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position,
  parameters: { mode: 'runOnceForAllItems', jsCode: nodeCode(file) },
  ...extra,
});

const nodes = [
  {
    name: 'Intake Trigger',
    type: 'n8n-nodes-base.formTrigger',
    typeVersion: 2.2,
    position: [-1180, 0],
    webhookId: 'xray-report-intake',
    parameters: {
      formTitle: 'X-Ray Report Analyzer (Research Prototype)',
      formDescription:
        'Upload a DE-IDENTIFIED radiology report (.txt, .png, .jpg, .pdf). ' +
        'This is a research/educational tool — NOT a diagnostic device. ' +
        'Do not enter real patient-identifying information.',
      formFields: {
        values: [
          {
            fieldLabel: 'report',
            fieldType: 'file',
            multipleFiles: false,
            acceptFileTypes: '.txt,.png,.jpg,.jpeg,.pdf',
            requiredField: true,
          },
          { fieldLabel: 'age', placeholder: 'optional' },
          { fieldLabel: 'sex', placeholder: 'optional' },
          { fieldLabel: 'history', fieldType: 'textarea', placeholder: 'optional relevant history (no identifiers)' },
        ],
      },
      // 'lastNode' = wait for the whole pipeline to finish, then let the final
      // Form "completion" node render the report. ('responseNode' would demand a
      // Respond-to-Webhook node, which the Form Trigger does not support.)
      responseMode: 'lastNode',
      options: {},
    },
  },

  codeNode('Preprocess', 'preprocess.js', [-960, 0]),

  {
    name: 'Triage (Gemini)',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [-740, 0],
    parameters: {
      method: 'POST',
      url: "=https://generativelanguage.googleapis.com/v1beta/models/{{ $env.GEMINI_TRIAGE_MODEL || 'gemini-2.5-flash' }}:generateContent",
      sendHeaders: true,
      headerParameters: {
        parameters: [{ name: 'x-goog-api-key', value: '={{ $env.GEMINI_API_KEY }}' }],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.triage_request_body) }}',
      options: { timeout: 30000 },
    },
    retryOnFail: true,
    maxTries: 2,
    waitBetweenTries: 2000,
  },

  codeNode('Parse Triage', 'parse-triage.js', [-520, 0]),
  codeNode('Fan-out Critiques', 'fanout-critiques.js', [-300, 0]),
  codeNode('Merge Guard', 'merge-guard.js', [-80, 0]),

  {
    name: 'Any Critiques?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: [140, 0],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        combinator: 'and',
        conditions: [
          {
            leftValue: '={{ $json.has_critiques }}',
            rightValue: '',
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
      },
      options: {},
    },
  },

  {
    name: 'Synthesis (DeepSeek)',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [360, -100],
    parameters: {
      method: 'POST',
      // URL + auth are chosen by Merge Guard (DeepSeek, or Gemini when
      // XRAY_NO_DEEPSEEK is set), so the backend can switch with no node edits.
      url: '={{ $json.synthesis_url }}',
      sendHeaders: true,
      headerParameters: {
        parameters: [{ name: '={{ $json.synthesis_auth_name }}', value: '={{ $json.synthesis_auth_value }}' }],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.synthesis_request_body) }}',
      options: { timeout: 120000 },
    },
    retryOnFail: true,
    maxTries: 2,
    waitBetweenTries: 3000,
    onError: 'continueRegularOutput',
    alwaysOutputData: true,
  },

  codeNode('Parse & Validate Final', 'parse-validate-final.js', [580, -100]),
  codeNode('Error Report', 'error-report.js', [360, 140]),
  codeNode('Render Report', 'render-report.js', [800, 0]),
  codeNode('Audit Log', 'audit-log.js', [1020, 0]),

  {
    // A Form Trigger workflow must end in a Form "completion" node (Respond to
    // Webhook is not supported with the Form Trigger). respondWith=showText
    // renders our HTML report directly as the completion page.
    name: 'Respond',
    type: 'n8n-nodes-base.form',
    typeVersion: 1,
    position: [1240, 0],
    parameters: {
      operation: 'completion',
      respondWith: 'showText',
      responseText: '={{ $json.html }}',
      options: {},
    },
  },
];

const chain = (from, to, outputIndex = 0) => [from, to, outputIndex];
const links = [
  chain('Intake Trigger', 'Preprocess'),
  chain('Preprocess', 'Triage (Gemini)'),
  chain('Triage (Gemini)', 'Parse Triage'),
  chain('Parse Triage', 'Fan-out Critiques'),
  chain('Fan-out Critiques', 'Merge Guard'),
  chain('Merge Guard', 'Any Critiques?'),
  chain('Any Critiques?', 'Synthesis (DeepSeek)', 0),   // true branch
  chain('Any Critiques?', 'Error Report', 1),           // false branch — zero critiques
  chain('Synthesis (DeepSeek)', 'Parse & Validate Final'),
  chain('Parse & Validate Final', 'Render Report'),
  chain('Error Report', 'Render Report'),
  chain('Render Report', 'Audit Log'),
  chain('Audit Log', 'Respond'),
];

const connections = {};
for (const [from, to, outIdx] of links) {
  connections[from] ??= { main: [] };
  while (connections[from].main.length <= outIdx) connections[from].main.push([]);
  connections[from].main[outIdx].push({ node: to, type: 'main', index: 0 });
}

const workflow = {
  // Fixed id so `n8n import:workflow` updates in place instead of duplicating.
  id: 'XrayReportAnal01',
  name: 'X-Ray Report Analyzer — Multi-LLM Second Opinion (Research Prototype)',
  nodes,
  connections,
  settings: {
    executionOrder: 'v1',
    // The Form Trigger completion page is async (this pipeline runs ~2 min), so
    // n8n shows a waiting page that POLLS execution status to render the result.
    // That poll requires the execution to be saved -- with saving off the form
    // shows "Could not get execution status". So we must retain executions.
    //
    // No-PHI-persistence (Section 4/6) is instead enforced by a compensating
    // control: aggressive auto-pruning via the n8n process env vars
    //   EXECUTIONS_DATA_PRUNE=true, EXECUTIONS_DATA_MAX_AGE=1 (hour),
    //   EXECUTIONS_DATA_PRUNE_MAX_COUNT=50
    // set by scripts/start-n8n.ps1, plus the mandatory "de-identified data only"
    // rule. Report text is de-identified upstream (Preprocess redaction) before
    // it ever reaches an execution record.
    saveDataSuccessExecution: 'all',
    saveDataErrorExecution: 'all',
    saveManualExecutions: true,
    saveExecutionProgress: true,
  },
  meta: { templateCredsSetupCompleted: false },
  pinData: {},
};

const outPath = join(root, 'n8n', 'xray-report-analyzer.workflow.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(workflow, null, 2) + '\n', 'utf8');

// Sanity checks: valid JSON, every connection endpoint exists, every Code node parses.
const parsed = JSON.parse(readFileSync(outPath, 'utf8'));
const names = new Set(parsed.nodes.map(n => n.name));
for (const [from, to] of links) {
  if (!names.has(from) || !names.has(to)) throw new Error(`Dangling connection ${from} -> ${to}`);
}
for (const n of parsed.nodes) {
  if (n.type === 'n8n-nodes-base.code') {
    // Code nodes run inside an async n8n wrapper where `items`, `$json`, `$env`,
    // `$execution`, `$('Node')` and `this.helpers` exist; stub them for a syntax check.
    new Function('items', '$json', '$env', '$execution', '$', 'require',
      `return (async function(){ ${n.parameters.jsCode} }).call({helpers:{}});`);
  }
}
console.log(`OK: wrote ${outPath} (${parsed.nodes.length} nodes)`);
