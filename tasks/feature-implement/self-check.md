---
schemaVersion: 1
id: feature-implement/self-check
title: Final self-check and synthesis
---
**Category**: process

Re-run the same full check pipeline recorded in
`feature-implement/check-gate` Notes after review fixes and docs updates.
If review fixes require a broader gate than the original check pass, use
the broader command set and explain why in Notes.

Paste exit codes into Notes.

Then write a short synthesis in Notes:
  - what shipped
  - files touched, grouped by subsystem
  - test results
  - review run id from `feature-implement/internal-code-review`
  - deferred work or open questions, if any
  - caller notes for first manual verification

Confirm every prior task is `completed`, not `blocked`. If anything is blocked, this task is blocked too.
