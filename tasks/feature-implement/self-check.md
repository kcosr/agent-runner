---
schemaVersion: 1
id: feature-implement/self-check
title: Final self-check and synthesis
---
**Category**: process

Re-run the full check gate after review fixes and docs updates:

    npm run check

Paste exit codes into Notes.

Then write a short synthesis in Notes:
  - what shipped
  - files touched, grouped by subsystem
  - test results
  - review run id from `feature-implement/internal-code-review`
  - deferred work or open questions, if any
  - caller notes for first manual verification

Confirm every prior task is `completed`, not `blocked`. If anything is blocked, this task is blocked too.
