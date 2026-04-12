---
schemaVersion: 1
name: repo-orientation
vars:
  repo_path:
    type: string
    required: true
    source: cli
    description: Absolute path to the repository to inspect.
tasks:
  - id: read_conventions
    title: Check repo conventions
    body: |
      Read AGENTS.md and CLAUDE.md (if present) at the repo root. Capture
      the coding style, test requirements, and PR conventions in the Notes
      field of this task.
  - id: inventory_packages
    title: Inventory top-level packages
    body: |
      List the top-level packages or modules in the repo. For each, write a
      one-line description in the Notes field of this task.
  - id: summary
    title: Summary
    body: |
      Write a short summary of what this repo does and how it is organized,
      in the Notes field of this task.
---
You are working on the repository at `{{repo_path}}`.
