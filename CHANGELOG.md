# Changelog

## [Unreleased]

### Added

- Added `AGENT_RUNNER_WEB_BASE_PATH` so `agent-runner serve` can expose the
  bundled web dashboard from a reverse-proxy subpath such as `/agent-runner`,
  including prefixed daemon HTTP routes for pass-through proxies.
  ([#156](https://github.com/kcosr/agent-runner/pull/156))
- Added daemon workspace file APIs and a web dashboard Files surface for
  browsing and searching selected-run cwd files, previewing Markdown/source,
  navigating files in fullscreen, and creating tasks from selected text or
  source ranges.
  ([#157](https://github.com/kcosr/agent-runner/pull/157))
- Dashboard Files surface now exposes a Refresh workspace files button that
  re-fetches the current directory listing, active search, and selected file
  preview. ([#159](https://github.com/kcosr/agent-runner/pull/159))
- Added a dashboard Diffs surface for reviewing selected-run branch and
  working-tree diffs, including changed-file search and task creation from
  selected diff lines. ([#160](https://github.com/kcosr/agent-runner/pull/160))
- Added dashboard task management for manual task creation, pending task
  title/body edits, pending deletes, status changes, and notes replace/append
  actions. ([#157](https://github.com/kcosr/agent-runner/pull/157))

### Changed

- Dashboard keyboard shortcuts now use `F` for the selected run Files tab,
  press `F` again to focus file search, and `Shift+F` for fullscreen drawer
  toggle. ([#157](https://github.com/kcosr/agent-runner/pull/157))
- Task mutation capabilities now expose explicit pending-edit and
  pending-delete gates, and non-passive runs can add new pending tasks while
  running when the task list is otherwise unlocked.
  ([#157](https://github.com/kcosr/agent-runner/pull/157))
- File-selection task creation now supports title-only tasks, omits the
  generated instructions section when empty, and collapses the workspace
  browser on mobile after opening a file.
  ([#157](https://github.com/kcosr/agent-runner/pull/157))
- Resume prompts for stopped runs with unfinished tasks now include the
  concrete task list instead of a terse reminder plus a generic continue
  message. ([#157](https://github.com/kcosr/agent-runner/pull/157))
- Workspace file browsing includes hidden files and directories, while search
  skips dependency and VCS directories such as `node_modules` and `.git`.
  ([#157](https://github.com/kcosr/agent-runner/pull/157))
- Workspace file preview attempts now allow small regular files regardless of
  filename or extension, with binary, invalid UTF-8, and oversized files failing
  clearly when opened. Because preview attempts can include sensitive text files
  such as `.env`, expose the daemon only to trusted clients, bind it to
  `127.0.0.1`, or enable daemon auth before sharing dashboard access.
  ([#159](https://github.com/kcosr/agent-runner/pull/159))
- Generated `plan-feature` and `plan-implement-feature` assignments no longer
  lock the task list with `lockedFields: [tasks]`, so agent-runner workflows
  can add or remove follow-up tasks during implementation when appropriate.
  ([#157](https://github.com/kcosr/agent-runner/pull/157))
- Dashboard task rows now use per-task edit controls and ask for confirmation
  before deleting a pending task.
  ([#157](https://github.com/kcosr/agent-runner/pull/157))

### Fixed

- Fixed daemon workspace file APIs so selected-run file browsing works for
  runs stored in repo buckets outside the daemon's current repo.
  ([#158](https://github.com/kcosr/agent-runner/pull/158))
- Fixed the dashboard Files surface so creating a task from selected Markdown
  preview text opens the dialog reliably, dragged source text selections enable
  task creation, and directories render with a folder icon.
  ([#157](https://github.com/kcosr/agent-runner/pull/157))
- Fixed source selection task bodies so the selected source snippet does not
  include gutter line numbers.
  ([#157](https://github.com/kcosr/agent-runner/pull/157))
- Fixed fullscreen selected-run drawers so they clear the normal saved drawer
  width and fill the main content area beside the sidebar.
  ([#157](https://github.com/kcosr/agent-runner/pull/157))
