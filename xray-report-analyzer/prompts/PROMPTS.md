# Prompt Templates — Source of Truth

The prompts are **embedded in the Code-node sources** and compiled into the
workflow by `scripts/build-workflow.mjs`. Edit them there, then rebuild
(`npm run build`) and re-import the workflow. Do not edit prompts inside the
n8n editor — they will be overwritten on the next build.

| Prompt | Lives in | Injected variables |
|---|---|---|
| Triage router | [`src/nodes/preprocess.js`](../src/nodes/preprocess.js) (`TRIAGE_PROMPT`) | report text / inline image, patient context |
| Specialist critique (identical template, Agents 1–3) | [`src/nodes/fanout-critiques.js`](../src/nodes/fanout-critiques.js) (`specialistSystemPrompt`) | `specialty_role`, `report_type`, `patient_context`, `report_text`, `image_provided` |
| Chief Diagnostician synthesis | [`src/nodes/merge-guard.js`](../src/nodes/merge-guard.js) (`SYNTH_PROMPT`) | merged critiques payload + verbatim disclaimer |
| Mandatory disclaimer (single definition) | [`scripts/build-workflow.mjs`](../scripts/build-workflow.mjs) (`DISCLAIMER`) | replaces the `__DISCLAIMER__` token in every node that needs it |

Design notes:

- The specialist template is **persona-agnostic** — the specialty is injected at
  runtime from the triage output (spec §1.3). No agent hard-codes a specialty.
- Each specialist also receives a machine-readable **user JSON payload** with the
  same fields, so backends without a real system role still get everything (§2.2).
- All specialist prompts spell out the exact JSON schema in-line because Ollama's
  `format: "json"` guarantees valid JSON but not the right fields; Gemini
  additionally gets a server-enforced `responseSchema` (§2.4).
- The stricter retry reminder (`STRICT_REMINDER` in `fanout-critiques.js`) is
  appended to the system prompt on the one retry allowed after malformed output (§2.6).
