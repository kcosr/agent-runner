---
schemaVersion: 1
id: review/security
title: Security & untrusted-input handling
---
Identify the trust boundaries — where untrusted input
crosses into the code. Typical sources: CLI args, env
variables, files written by another process or an AI
agent, HTTP/RPC request bodies, user-supplied regex or
queries, config files from a shared directory.

For each input, trace where it lands:
  - Does it become part of a shell command? (command
    injection — `exec` vs `spawn(args-array)`)
  - Does it become a file path? (path traversal, `..`
    segments, symlink following)
  - Does it become part of a prompt sent to an AI? (prompt
    injection — limit by design, not promise)
  - Are secrets (API keys, env vars marked sensitive) ever
    logged, persisted to disk, or included in error
    messages?
  - Is there any `eval`, `Function`, dynamic `require`,
    or user-supplied regex with potential ReDoS?
