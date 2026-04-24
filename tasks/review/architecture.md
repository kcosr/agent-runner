---
schemaVersion: 1
id: review/architecture
title: Architecture & module boundaries
---
Review the module layout and component boundaries for
design smells. If the scope is ranged, focus on whether the
change introduces or worsens any of these, not on
pre-existing architecture you can't affect.

Look for:
  - Modules doing more than one thing
  - Coupling that should be inverted (low-level depending
    on high-level)
  - Abstractions that exist but aren't pulling weight
  - Abstractions that should exist but don't (duplicated
    logic across sibling modules — also see
    `review/simplification-and-duplication`)
  - Layer violations (e.g. a backend module reaching into
    runner state, a UI module calling a DB layer directly)
  - Asymmetries between sibling modules that suggest one is
    wrong
  - Circular dependencies

If the scope is too small for this dimension to produce
real findings, say so and move on. Format per role
instructions.
