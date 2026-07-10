# Testing & Evaluation Plan

Two layers of testing:

1. **Offline logic simulation** (no network, no keys) — already automated.
2. **Live evaluation** against real backends with the Section 5 test cases.

---

## 1. Offline simulation (automated)

```bash
npm test        # runs scripts/simulate-pipeline.mjs
```

Runs the real Code-node sources with mocked LLM backends through the full
failure-handling matrix (spec §2.6):

| Scenario | Verifies |
|---|---|
| Happy path | markdown render, disclaimer verbatim top+bottom, PHI redaction, `reasoning_content` never leaks, honest-limitation disclosures |
| Ollama unreachable | pipeline completes 2/3, `missing_critiques` populated |
| Malformed specialist JSON | one retry with stricter reminder recovers |
| Zero critiques | explicit "analysis could not be completed", **no fabricated diagnosis**, disclaimer intact |
| Synthesis HTTP failure | raw critiques + "synthesis unavailable" notice, disclaimer intact |
| Synthesis malformed JSON | same fallback path |
| Malformed triage | default specialty triad fallback from `report_type_hint` |

Run this after any change to `src/nodes/` and before re-importing the workflow.

---

## 2. Live test cases (spec §5.2)

> **Test-data source:** the "OpenMed" source referenced in the original request is
> an **unconfirmed placeholder** (spec A8). Until it is confirmed, use the synthetic
> de-identified reports in [`test-data/`](../test-data/) — they were authored to hit
> each required scenario. Candidate open alternatives if real reports are wanted:
> Open-i/Indiana University chest X-ray collection (open, de-identified),
> PadChest (check terms), MIMIC-CXR (requires PhysioNet credentialing — not drop-in).
> **Hard rule: only de-identified data. No real PHI in any test run.**

| # | Case | File | Expected outcome |
|---|---|---|---|
| 1 | Clear-cut normal | `test-data/case-1-normal.txt` | All agents agree "no acute abnormality"; high confidence; minimal differentials |
| 2 | Ambiguous/borderline | `test-data/case-2-ambiguous.txt` | Medium confidence; agents split on infiltrate-vs-artifact; synthesis resolves or flags as unresolved with what would resolve it |
| 3 | Likely disagreement | `test-data/case-3-disagreement.txt` | Populated `points_of_disagreement_and_resolution`; ranked differential; honest confidence |
| 4 | Degraded backend | any case + forced failure | Completes on 2/3; `missing_critiques` populated; confidence lowered |

**Forcing the degraded-backend case (test 4):** stop the Ollama service
(`ollama stop` / stop the container), or point `OLLAMA_BASE_URL` at an unused
port (e.g. `http://127.0.0.1:1`), then submit any test case. The report must
still be produced, must list the Ollama specialist under *Missing critiques*,
and must not claim three perspectives.

**How to run:** open the workflow's Form Trigger URL (n8n shows it on the
node), upload the `.txt` file, optionally fill age/sex/history, submit. The
rendered markdown report is returned in the browser and a redacted copy is
written to `XRAY_OUT_DIR`.

---

## 3. Metrics per run (spec §5.3)

Recorded automatically in `<XRAY_OUT_DIR>/audit.jsonl` (per-agent latency,
models, failures, confidence). Fill the `eval` block per run manually:

- **Inter-agent agreement rate** — % overlap of flagged findings across
  specialists after normalizing to comparable concepts (e.g. "RLL opacity" ==
  "right lower lobe infiltrate").
- **Hallucination check** — any finding not present in / reasonably inferable
  from the source? Count. **Target: zero.** Any hallucination is a release blocker.
- **Latency** — per-agent (`agents[].ms`) and total (`total_ms`), logged automatically.
- **Confidence calibration** — high stated confidence + low measured agreement
  is a calibration problem; investigate before trusting confidence output.

## 4. Scoring rubric (1–5, applied to the final synthesized report, spec §5.4)

| Dimension | 1 | 3 | 5 |
|---|---|---|---|
| Clinical plausibility | implausible / unsafe | mostly reasonable, minor gaps | clinically sound throughout |
| Internal consistency | contradicts itself / the inputs | minor inconsistencies | fully consistent with inputs |
| Clarity | confusing, unusable | understandable | clear, well-structured, actionable |

Record the three rubric scores in the `eval.rubric` block of the run's
`audit.jsonl` record for regression tracking.

## 5. Release checklist (safety review, spec §6)

- [ ] Disclaimer appears verbatim at top and bottom of every rendered report (all 7 simulation scenarios pass).
- [ ] `audit.jsonl` and saved reports contain no names/DOB/MRN/phone/email tokens (spot-check with real-looking synthetic PHI).
- [ ] No raw uploaded files, image bytes, or `reasoning_content` anywhere in the output dir or n8n execution data (workflow saves no execution data by default).
- [ ] Zero-critique run returns the explicit error report, never a diagnosis.
- [ ] `analysis_limitations` always discloses text-only agents and non-FDA/CE status.
