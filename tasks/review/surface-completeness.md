---
schemaVersion: 1
id: review/surface-completeness
title: Surface completeness
---
Walk every user-facing surface element introduced,
modified, or removed by the diff, and verify each one is
wired all the way through.

A "surface element" is any named entity a user types,
clicks, or configures:
  - CLI flag, positional, or subcommand
  - HTTP route or query/body parameter
  - RPC method or RPC parameter key
  - Environment variable
  - Config-file key
  - UI form field, button label, or preference key
  - Public function or exported symbol whose name appears
    in user-facing docs
  - Persisted-data field that appears in user-facing
    output

Surface elements are *names* the user encounters, not
internal implementation details.

## Where the inventory comes from

  - If the review has access to a planning artifact
    (e.g. via `implementation_run_id` or an attached
    Surface Inventory), use that inventory as ground
    truth. The implementation run should expose it in
    the orient task or a dedicated inventory task such
    as `feature-plan/surface-inventory`.
  - If no planning artifact exists (direct/ad-hoc review),
    derive the inventory yourself from the diff. Look for
    every newly-added or modified named entity in:
      - the CLI argument parser / command dispatcher
      - HTTP route tables and request-parsing modules
      - RPC dispatcher tables
      - environment-variable declarations and reads
      - config-schema definitions
      - UI form components, preference keys, and
        user-facing labels
      - public exports from the project's library entry
        points

## What to trace for each entry

For each surface element, locate three things and record
`file:line` for each:

  1. **Declaration / parser** — where the value enters
     from the user (the parser, route registration, env
     read, config load, UI input binding).
  2. **Consumer** — where the parsed value is *read* by
     business logic, not just stored on a parsed-args
     object or unused parameter. A parsed value with no
     reader is the canonical "advertised but unwired"
     bug.
  3. **Integration test** — a test that exercises the
     surface from its outermost entry point (CLI
     shell-out, HTTP request, RPC call, UI interaction).

For each removed surface element, also grep the codebase
for the old name. Hits outside CHANGELOG history,
migration scripts, and pre-existing legacy-version test
fixtures are leftover wiring that should have been
deleted in lockstep.

For each entry with **symmetric peers** (CLI ↔ HTTP ↔
RPC ↔ UI), repeat the trace for each peer. Asymmetric
peers (one transport accepts the surface, another rejects
or ignores it) are almost always bugs.

## Findings

  - [HIGH] Surface element declared/parsed but no
    consumer reads the value. The "advertised but
    unwired" bug — docs claim it works, the parser
    accepts it, but the value is silently dropped.
  - [HIGH] Surface element documented in user-facing
    docs (README, `--help` text, HTTP API reference,
    UI label) but with no declaration/parser in code.
  - [HIGH] Surface element marked `removed` in the
    inventory but still referenced at the layer that
    ought to have been removed in lockstep (live
    parser path, live route table, live UI control).
    Do not flag CHANGELOG entries, migration scripts,
    or older-version test fixtures.
  - [HIGH] Surface element accepted by one transport
    but rejected or missing on a symmetric peer that
    should be aligned (CLI accepts, HTTP doesn't, or
    vice versa) without a contract note explaining
    the asymmetry.
  - [MEDIUM] Surface element wired end-to-end but no
    integration test exercises the outermost entry
    point. (For features that intentionally ship
    without integration tests, flag at LOW instead and
    cite the contract note that explains why.)

The anti-pattern this dimension catches is structural:
the surface inventory and the data flow have diverged.
A feature that's "implemented" at the parsing layer but
not at the consumption layer (or vice versa) will pass
unit tests, lint, and docs checks but will silently fail
for the user. This dimension is the dedicated trace pass
that catches it.

If the diff introduces no user-visible surfaces (a pure
refactor, a build-tooling change, an internal-only
performance tweak), say "No issues found in this
dimension" and move on.
