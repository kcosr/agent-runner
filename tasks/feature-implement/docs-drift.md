---
schemaVersion: 1
id: feature-implement/docs-drift
title: Documentation drift
---
**Category**: code-bearing

**Done when:** User-facing docs, examples, and `CHANGELOG.md` under `## [Unreleased]` reflect the shipped behavior, or Notes explicitly prove no documentation surface changed.

Update every documentation surface touched by this feature:
  - README sections that describe changed commands, concepts, or workflows
  - docs/ pages that describe assignments, tasks, attachments, or examples
  - CHANGELOG under the appropriate `## [Unreleased]` subsection
  - inline docs for public API changes

Record every docs/changelog file edited and any docs-focused check command with exit code.
