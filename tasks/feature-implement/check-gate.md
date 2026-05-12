---
schemaVersion: 1
id: feature-implement/check-gate
title: Run the lint / build / test gate
---
**Category**: process

Run the project's full check pipeline exactly as captured in
`feature-plan/orient` and `feature-plan/risks-and-tests` Notes. Every
command must pass before moving to `feature-implement/commit`.

If those planning Notes did not record check commands, block this task
with the missing evidence instead of guessing a toolchain-specific
default.

Paste each command, exit code, and relevant failure/fix evidence into Notes. If a command fails, fix the underlying issue in this task before continuing.
