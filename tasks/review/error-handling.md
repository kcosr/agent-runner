---
schemaVersion: 1
id: review/error-handling
title: Error handling & edge cases
---
For each user-visible operation in scope, ask: what happens
when it fails? Specifically walk through:
  - Malformed config files (truncated, wrong type, extra
    fields, schema-version mismatch)
  - Missing files or directories
  - Permission errors on read or write
  - Network failures mid-request (for any network-touching
    code)
  - Subprocess crashes vs subprocess non-zero exit vs
    subprocess hang
  - Empty input where the code assumes non-empty
  - Concurrent processes writing to the same file
  - Disk full / EIO mid-write

Are errors actionable to a user (with file:line, suggested
fix)? Are partial states left on disk if a write fails
halfway? Look especially at any code that writes to disk
and any code that parses external input.

For changed shared paths, look for ordering and normalization bugs:
values captured before validation/defaulting, state built before
normalization, effects moved before guards, cached data computed
before all sources are loaded, or request/response projections built
before all fields are populated. This applies to parsers,
dispatchers, request/response builders, state reducers, serializers,
config loaders, lifecycle/workflow handlers, database access layers,
UI state transitions, and other reused infrastructure.
