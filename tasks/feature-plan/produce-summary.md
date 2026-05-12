---
schemaVersion: 1
id: feature-plan/produce-summary
title: Produce human-facing summary artifact
---
**Category**: process

Render the planning Notes from this run into a human-facing markdown summary at a temporary path such as:

    /tmp/task-runner-plan-{{run_id}}/assignment-summary.md

Use the existing summary template unchanged. It lives in one of:
  - `{{cwd}}/assignments/plan-feature/summary-template.md`
  - `{{config_dir}}/assignments/plan-feature/summary-template.md`
  - under the task-runner install root

Fill each `<<PLACEHOLDER_*>>` marker from existing Notes only:
  - `<<PLACEHOLDER_FEATURE_SHORT_TITLE>>` — a short title, five words or fewer.
  - `<<PLACEHOLDER_OVERVIEW>>` — source: `feature-plan/capture-feature`.
  - `<<PLACEHOLDER_MOTIVATION>>` — source: `feature-plan/capture-feature`.
  - `<<PLACEHOLDER_IN_SCOPE>>` — source: `feature-plan/capture-feature`.
  - `<<PLACEHOLDER_OUT_OF_SCOPE>>` — source: `feature-plan/capture-feature`.
  - `<<PLACEHOLDER_CONTRACT>>` — paste `feature-plan/contract` Notes verbatim.
  - `<<PLACEHOLDER_SURFACE_INVENTORY>>` — paste `feature-plan/surface-inventory` Notes verbatim.
  - `<<PLACEHOLDER_SCHEMA>>` — schema diff for schema features, otherwise `_No schema changes._`.
  - `<<PLACEHOLDER_IMPACT_TABLE>>` — markdown table from `feature-plan/survey-impact`.
  - `<<PLACEHOLDER_HIGHER_LEVEL_STEPS>>` — 5 to 10 implementation bullets synthesized from the plan Notes.
  - `<<PLACEHOLDER_DIAGRAMS>>` — Mermaid diagrams only where useful, otherwise `_No diagrams applicable._`.
  - `<<PLACEHOLDER_RISKS>>` — source: `feature-plan/risks-and-tests`.
  - `<<PLACEHOLDER_TEST_STRATEGY>>` — source: `feature-plan/risks-and-tests`.
  - `<<PLACEHOLDER_ASSUMPTIONS>>` — non-contract assumptions from `feature-plan/capture-feature`.

Do not generate `assignment-seed.md`. Do not run `plan-review`. Do not initialize a separate implementer run. The canonical execution contract for this single-run flow is this run's task state plus the completed planning Notes.

Do not leave any `<<PLACEHOLDER_*>>` markers in the final file.

Report the final summary path in Notes, plus a one-line confirmation that Contract, Surface Inventory, and Assumptions came directly from the upstream planning Notes.
