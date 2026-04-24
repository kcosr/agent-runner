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
