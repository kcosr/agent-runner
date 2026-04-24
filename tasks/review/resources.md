---
schemaVersion: 1
id: review/resources
title: Resource management & cleanup
---
Any code that allocates a non-memory resource is suspect.
Look for:
  - File handles (open()/createReadStream/etc.)
  - Child processes (spawn/fork/exec)
  - Sockets, WebSockets, DB connections
  - Directories or temp files created but never cleaned up
  - Anything in `os.tmpdir()` or equivalent

For each, is there a guaranteed release path on success
AND every failure mode? Trace the close() chain by reading
code, not by trusting "the process will exit eventually" —
long-lived runs cannot rely on process exit.

Also flag anything that grows unboundedly (arrays, maps,
log buffers, caches) without a cap.
