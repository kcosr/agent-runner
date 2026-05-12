---
schemaVersion: 1
id: feature-implement/fresh-eyes
title: Fresh-eyes simplification pass
---
**Category**: hybrid

Before kicking off the internal code review, re-read
your own diff with fresh eyes. Look for:
  - Duplication with existing helpers (cross-reference
    the planning run's duplication-check task notes).
  - Dead code, unused imports, or accidentally-
    introduced abstractions that do not pay for
    themselves.
  - Error handling you wrote defensively but do not
    actually need at an internal boundary.
  - Comments that explain WHAT instead of WHY —
    delete them; the code says WHAT.
  - Five-plus similar lines that could collapse into
    a table or a loop.
  - Over-engineered configuration for cases that do
    not exist yet.
  - Fallback logic, compatibility shims, heuristics,
    alias fields, or dual-shape readers that the plan
    did not explicitly require.

Apply any simplifications you find before moving on.
The goal is to shorten the diff the reviewer has to
read; shorter diffs produce sharper reviews. Paste a
one-line summary of what you simplified into Notes.
