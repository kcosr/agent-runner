---
schemaVersion: 1
id: feature-plan/orient
title: Target repo orientation and conventions
---
Read the high-signal entry points for the repository at
`{{cwd}}`:
  - AGENTS.md, CLAUDE.md, CONTRIBUTING.md at the repo
    root
  - README.md
  - Build manifest (package.json, Cargo.toml, go.mod,
    pyproject.toml, etc.) for scripts, dependencies,
    and language toolchain
  - docs/ directory (design docs, architecture notes)
  - Primary entry-point files

Capture in Notes: the exact build, test, lint, and
format commands, the test framework, any pre-commit
hooks, PR conventions, and any non-obvious repo-specific
rules the generated plan must respect. These command
strings will be cited verbatim by the implementer's
check-gate task, so copy them accurately.
