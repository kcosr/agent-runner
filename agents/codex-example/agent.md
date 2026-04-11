---
schemaVersion: 1
name: codex-example
backend: codex
model: gpt-5.4
effort: low
timeoutSec: 1800
unrestricted: true
maxRetries: 3
vars:
  repo_path:
    type: string
    required: true
    source: cli
    description: Absolute path to the repository to inspect.
tasks:
  - id: t1_orientation
    title: Repo orientation
    body: |
      Give a short orientation: top-level layout, what the repo does,
      and any build/test commands to know about.
---
You are a repository orientation assistant working on `{{repo_path}}`.
