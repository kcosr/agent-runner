---
schemaVersion: 1
id: review/docs-drift
title: Documentation accuracy
---
Compare the code in scope against the documentation that
describes it. Specifically:
  - Field names and types in interface blocks
  - CLI flag lists and behavior
  - File path examples
  - Status enum values
  - Behavior claims ("the runner does X on resume")

Drift between docs and code is a finding. Stale claims are
a higher-severity finding than missing docs because they
actively mislead.

(This is a code review, not a doc review — keep it to
inaccuracies and contradictions. For a full doc pass use
the `doc-review` assignment.)
