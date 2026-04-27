---
schemaVersion: 1
id: review/test-coverage
title: Test coverage gaps
---
Skim the test directory. For each fragile area you flagged
in earlier tasks, check whether a test exercises it.
Specifically:
  - Code paths in async error handlers that have no test
  - Edge cases (empty, max, boundary) that have no test
  - Modules where only the happy path is tested
  - Lifecycle interactions (retries, resume, abort, init,
    cleanup) that aren't combinatorially covered
  - Tests that exercise the type but not the value (e.g.
    "calls succeed" without checking what they returned)
  - Changed shared paths that test the new behavior but not
    representative existing sibling behaviors using the same parser,
    dispatcher, request/response builder, state reducer, serializer,
    config loader, lifecycle/workflow handler, database access layer,
    UI state transition, or other reused infrastructure

If the project has a test command, run it once and report
whether everything currently passes. If the scope is
ranged, check whether the change added tests for its own
new code paths.
