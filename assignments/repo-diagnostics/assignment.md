---
schemaVersion: 1
name: repo-diagnostics
vars:
  repo_path:
    type: string
    required: true
    source: cli
    description: Absolute path to the repository to inspect.
tasks:
  - id: run_date
    title: Run Date
    body: |
      Run `date` and record the output in the Notes field of this task.
  - id: run_pwd
    title: Run pwd
    body: |
      Run `pwd` and record the output in the Notes field of this task.
---
You are collecting diagnostics from the repository at `{{repo_path}}`.
