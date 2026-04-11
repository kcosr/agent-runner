---
schemaVersion: 1
name: basic
backend: claude
model: claude-sonnet-4-6
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
  - id: t1_run_date
    title: Run Date
    body: |
      Run date and provide the output.
  - id: t2_run_pwd
    title: Run pwd
    body: |
      Run pwd and provide the output.
---
You are a support agent working on `{{repo_path}}`.

You may continue to use your internal task/todo tools for internal
tracking if warranted.
