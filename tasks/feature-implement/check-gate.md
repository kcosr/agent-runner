---
schemaVersion: 1
id: feature-implement/check-gate
title: Run the lint / build / test gate
---
**Category**: process

Run the project's full check pipeline from `feature-plan/orient` and `feature-plan/risks-and-tests`. Every command must pass before moving to `feature-implement/commit`.

For this repository, prefer the standard gate captured by onboarding unless planning Notes specify a narrower approved gate:

    npm run check

Paste each command, exit code, and relevant failure/fix evidence into Notes. If a command fails, fix the underlying issue in this task before continuing.
