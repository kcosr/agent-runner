---
schemaVersion: 1
id: feature-plan/survey-impact
title: Survey the impact surface
---
Find every part of the repository the feature will
touch. For each area, list in Notes:
  - File paths (repo-relative)
  - The function / class / module responsible
  - Existing behavior the feature must preserve
  - Existing tests covering the area (if any)
  - Shared paths the change would touch: parsers,
    dispatchers, request/response builders, state reducers,
    serializers, config loaders, lifecycle/workflow handlers,
    database access layers, UI state transitions, or other
    reused infrastructure, plus representative existing sibling
    behaviors that also flow through that path

Read the identified files in full, not just skim. This
is the context the generated plan's implementation
tasks will cite. Vague impact surveys produce vague
plans, which produce sloppy implementations.

You may delegate impact-surface exploration to native
subagents (Claude's Agent tool, Codex subagents,
whatever your backend supports) if that would
parallelize the survey. Native subagents do not count
against task-runner's recursion depth.
