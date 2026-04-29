# Changelog

## [Unreleased]

### Breaking Changes

- Manifest schema version is now `15`. Run manifests and reset seeds now
  require `runGroupId` plus typed `dependencies` refs (`run` or
  `group`); the former run-only dependency array is removed. Use
  `scripts/migrate-manifests-v15.mjs` before resuming schema v14 runs.
  ([#111](https://github.com/kcosr/task-runner/pull/111))
- Daemon, CLI, and web contracts now use run groups instead of
  lineage-root grouping. Consumers should use `runGroupId`, `run set-group`,
  `run clear-group`, `list runs --group-id`, and
  `attachment list --scope group`.
  ([#111](https://github.com/kcosr/task-runner/pull/111))
- Manifest schema version is now `14`. Run manifests, status DTOs, daemon
  responses, web fixtures, hook contexts, and runtime interpolation no
  longer expose assignment seed path fields, including the
  `{{assignment_path}}` template variable. Assignment-backed runs still
  write `assignment-seed.md` as an internal workspace audit snapshot; use
  `scripts/migrate-manifests-v14.mjs` before resuming schema v13 runs.
  ([#109](https://github.com/kcosr/task-runner/pull/109))
- Manifest schema version is now `13`. Runs now freeze selected
  per-backend argv extras in `manifest.resolvedBackendArgs` and
  `manifest.resetSeed.resolvedBackendArgs`; use
  `scripts/migrate-manifests-v13.mjs` before resuming schema v12 runs.
  Rollbacks after migration require restoring compatible code or
  recreating/downgrading those runs because older code rejects v13
  manifests. ([#107](https://github.com/kcosr/task-runner/pull/107))
- Manifest schema version is now `12`. Runs now require first-class
  `schedule` manifest data (`RunSchedule | null`), and summary/detail
  DTOs expose derived `scheduleState` instead of accepting compatibility
  scheduling shapes from older manifests.
  ([#96](https://github.com/kcosr/task-runner/pull/96))
- Manifest schema version is now `11`. Runs now store explicit
  run/session/attempt state with `totalAttemptCount`,
  `totalSessionCount`, `maxAttemptsPerSession`, and `sessions`; the old
  public `attempts`, `maxAttempts`, and `sessionCount` fields are
  removed. Use `scripts/migrate-manifests-v11.mjs` to promote schema v10
  manifests. ([#94](https://github.com/kcosr/task-runner/pull/94))
- Assignment task string refs now treat only absolute paths and strings
  beginning with `./` or `../` as file paths. Bare slashful strings such
  as `review/reuse` now resolve as named task ids under `tasks/`, and
  authored task ids may now include `/` for nested canonical ids.
  ([#91](https://github.com/kcosr/task-runner/pull/91))
- Hot-cut task-transition hook targeting: use task-local
  `tasks[].hooks[]` or native `hooks.taskTransition[].when.taskId|taskIds`
  to select guarded tasks, and stop authoring
  `require-children-success.with.taskIds`.
- `task-runner attachment list` now uses structured scope selection
  instead of `--cwd-scope`; current manifests use `--scope run|group`,
  and the default view is run-group attachment discovery rather than
  exact same-cwd grouping. ([#81](https://github.com/kcosr/task-runner/pull/81))
- Run lifecycle now includes an explicit `ready` state between
  `initialized` and `running`. Non-passive initialized runs are no longer
  directly executable: promote them with `task-runner run ready <run-id>`
  before the first `run --resume-run`.
  ([#71](https://github.com/kcosr/task-runner/pull/71))
- Manifest schema version is now `10`. Runs now freeze the resolved
  launcher on both `manifest.launcher` and `manifest.resetSeed.launcher`,
  and resume / reset reuse that frozen launcher instead of re-reading
  current launcher files or daemon/client overrides.
  ([#70](https://github.com/kcosr/task-runner/pull/70))
- Manifest schema version is now `9`. Runs now freeze resolved hook
  descriptors plus prepare-time hook outputs (`resolvedHooks`,
  `hookState`, `hookAudits`) into the manifest and reset seed, and older
  pre-hook runs must be recreated or upgraded out-of-band before resume.
  Schema v9 also freezes workspace assignment capture at
  `assignment-seed.md`.
  ([#66](https://github.com/kcosr/task-runner/pull/66),
  [#68](https://github.com/kcosr/task-runner/pull/68))
- Config-time `${...}` interpolation in prose-like definition fields now
  only applies when the whole field is a single `${...}` expression.
  Embedded `${...}` text inside larger prose strings remains literal.
  ([#67](https://github.com/kcosr/task-runner/pull/67))
- Hot-cut the run-targeted read surfaces under `task-runner run`: use `task-runner run status <run-id>` and `task-runner run brief <run-id>`, while top-level `task-runner status` now reports system/environment status instead of run state. ([#52](https://github.com/kcosr/task-runner/pull/52))
- `task-runner list runs` now defaults to the caller's cwd instead of listing every repo. Use `--cwd <path>` to target a different exact cwd, `--repo <name>` to target one repo bucket, or `--global` to restore the previous global listing behavior. ([#44](https://github.com/kcosr/task-runner/pull/44))
- Manifest schema version is now `8`. Authored `cwd` moved from agent definitions to assignment definitions, run manifests now persist first-class `repo` alongside frozen `cwd`, and older `schemaVersion: 7` runs must be upgraded explicitly with `scripts/migrate-manifests-v8.mjs` or recreated. Built-in assignments/docs now use `{{cwd}}` instead of redundant canonical `repo_path` vars. ([#43](https://github.com/kcosr/task-runner/pull/43))
- Replaced the daemon/browser live-event contract hot-cut: `AppRuntimeConfig.runEventsPath` and the mixed `/api/events/runs` / `run.event` surfaces are removed in favor of `runSummaryEventsPath`, summary-only global streams, per-run detail streams, and per-run timeline streams. `RunSummary` and `RunDetail` now include derived `activeTask` projections for direct board/detail rendering. ([#35](https://github.com/kcosr/task-runner/pull/35))
- Shared run lifecycle contracts now hot-cut `RunCapabilities` to include `canReset` and `canDelete`, and the global run-summary stream now emits either `summary_upsert` or `summary_removed`. Daemon/web consumers must use the updated capability and event unions directly. ([#39](https://github.com/kcosr/task-runner/pull/39))
- Replaced the old assignment-owned/backend display-name contract with first-class nullable `run.name`. Fresh `task-runner run` / `init` now use `--name`, resume rejects name overrides, and bundled assignments/docs/examples no longer describe the removed contract.
- Replaced the previous single-root runtime env var and cwd-local bare-name definition lookup with split XDG-style roots: `TASK_RUNNER_CONFIG_DIR` for named agent/assignment definitions and `TASK_RUNNER_STATE_DIR` for runtime state. Bare names now resolve only from the config root, and run workspaces now live under repo-scoped state buckets instead of `<cwd>/.task-runner/`. ([#8](https://github.com/kcosr/task-runner/pull/8))
- Direct file-path args are now recognized only when the argument contains `/` or starts with `./`; bare names no longer implicitly resolve from the repo checkout. ([#8](https://github.com/kcosr/task-runner/pull/8))
- Run workspace and draft buckets under `${TASK_RUNNER_STATE_DIR}/runs/` and `${TASK_RUNNER_STATE_DIR}/drafts/` now use the repo basename (for example `task-runner`) instead of a slugified absolute repo path. Existing runs remain on disk at their old locations, but short-id lookup now resolves against the new basename bucket unless you resume by explicit workspace path. ([#10](https://github.com/kcosr/task-runner/pull/10))
- Manifest schema version is now `3`. Existing `schemaVersion: 2` runs from the pre-reset-seed generation are no longer resumable; start a fresh run instead.
- Manifest schema version is now `4`. Run manifests and daemon/CLI/web DTOs now require persisted `execution` provenance, and older `schemaVersion: 3` runs from before the abort-control hot cut are no longer resumable. ([#29](https://github.com/kcosr/task-runner/pull/29))
- Manifest schema version is now `5`. Run manifests now persist `dependencyRunIds`, and older `schemaVersion: 4` runs from before run dependencies are no longer resumable. ([#30](https://github.com/kcosr/task-runner/pull/30))
- Manifest schema version is now `6`. Run manifests now persist `attachments`, and older `schemaVersion: 5` runs from before run attachments must be upgraded explicitly with `scripts/migrate-manifests-v6.mjs` before they can be resumed. ([#32](https://github.com/kcosr/task-runner/pull/32))
- `task-runner status --output-format json` now emits the shared `RunDetail` contract, and `--field` projects top-level `RunDetail` fields. The raw `finalTasks` status projection is removed; use `--field tasks` instead. ([#17](https://github.com/kcosr/task-runner/pull/17))
- `RunCapabilities` is now a hot-cut machine-facing contract with nested task mutation booleans (`taskMutation.canSetStatus`, `canEditNotes`, `canAdd`). The old flat `canAbort` / `canMutateTasks` fields are removed, and `list runs --output-format json` now carries `capabilities` on every `RunSummary` row. ([#19](https://github.com/kcosr/task-runner/pull/19))
- Manifest schema version is now `7`. Runs now persist first-class `brief` text, `taskMode` and `pendingPrompt` are removed, and earlier manifest generations are no longer resumable. ([#34](https://github.com/kcosr/task-runner/pull/34))
- `task-runner status` and `task-runner brief` now require canonical run ids on the public read surface. Workspace-path targeting is no longer accepted for those commands. ([#34](https://github.com/kcosr/task-runner/pull/34))

### Added

- Added a selected-run Chat tab to the web dashboard selected-run panel,
  including persisted Chat/Detail tab state, timeline projection with
  stored run/session messages as Markdown user bubbles, daemon-synthesized
  prompts as System cards, inline assistant output without backend
  notices/diagnostics, loading skeletons while timeline history hydrates,
  mobile-safe sheet behavior, and resume composer support from the inset Send
  button or `Cmd/Ctrl+Enter`.
  ([#118](https://github.com/kcosr/task-runner/pull/118))
- Added first-class run groups across manifests, CLI, daemon APIs, and the
  web dashboard. Fresh child runs inherit the parent run group by default,
  `--group-id` overrides fresh run/init grouping, and
  `run set-group` / `run clear-group` mutate non-running runs.
  ([#111](https://github.com/kcosr/task-runner/pull/111))
- Added group dependencies with `task-runner run add-dep --group
  <group-id>` and `run remove-dep --group <group-id>`, including cycle
  detection, daemon auto-start readiness, and web dashboard editing.
  ([#111](https://github.com/kcosr/task-runner/pull/111))
- Added `scripts/migrate-manifests-v15.mjs` to promote schema v14
  manifests to schema v15 by deriving `runGroupId` and converting
  run-only dependencies to typed run refs.
  ([#111](https://github.com/kcosr/task-runner/pull/111))
- Added product-scope guidance for evaluating task-runner feature
  requests and linked it from the README and agent onboarding notes.
  ([#108](https://github.com/kcosr/task-runner/pull/108))
- Added `backendArgs.<backend>.extraArgs` in agent frontmatter for
  backend-owned CLI flags. Fresh runs and init resolve only the selected
  backend's args, freeze them into local `run.json`, and keep normal
  status DTOs closed. ([#107](https://github.com/kcosr/task-runner/pull/107))
- Added Codex WebSocket-over-UDS transport via `{ type: "uds", path:
  "/absolute/socket/path" }` and `TASK_RUNNER_CODEX_UDS_PATH`, with
  fast-fail conflict detection when both Codex UDS and websocket env
  defaults are set. ([#104](https://github.com/kcosr/task-runner/pull/104))
- Added a Knip baseline via `npm run check:knip` for unused files,
  exports, exported types, and dependency metadata.
- Added initialized-run reconfigure support across core, CLI, daemon
  HTTP/RPC, web dashboard, shared `RunCapabilities.canReconfigure`, and
  `run.reconfigured` audit rows. `task-runner run reconfigure <id>` can
  patch vars and/or the initial message all-or-nothing, and
  `--message-file` now supplies UTF-8 message text for `run`, `init`,
  resume, and reconfigure.
  ([#97](https://github.com/kcosr/task-runner/pull/97))
- Added `scripts/migrate-agent-seeds.mjs` to backfill missing
  `agent-seed.md` files for initialized runs created before frozen agent
  snapshots were persisted.
  ([#97](https://github.com/kcosr/task-runner/pull/97))
- Added scheduled runs with one-time and cron recurrence support across
  assignment config, `init` / `run ready`, `run schedule` CLI commands,
  daemon HTTP/RPC APIs, audit events, and web dashboard indicators and
  controls. ([#96](https://github.com/kcosr/task-runner/pull/96))
- Added shared review task definitions under `tasks/review/` and a
  bundled `code-review-direct` assignment for user-launched or Web UI
  code reviews that are not tied to an implementation run.
- Added reusable named task definitions under
  `${TASK_RUNNER_CONFIG_DIR}/tasks/<task-id>.md`, plus mixed assignment
  `tasks:` authoring that can combine named refs, explicit path refs,
  and inline task objects while keeping task resolution loader-only.
  ([#91](https://github.com/kcosr/task-runner/pull/91))
- Added `@task-runner/core/core/run/static-input-surface.js` to resolve
  the static fresh-run input surface for core consumers, including
  authored run-setting metadata and CLI-capable assignment inputs.
  ([#89](https://github.com/kcosr/task-runner/pull/89))
- Added `GET /api/run-input-surface` so daemon/browser clients can fetch
  the static fresh-run resolver output over HTTP before initializing or
  starting a run. ([#90](https://github.com/kcosr/task-runner/pull/90))
- Added a dedicated `/runs/new` web dashboard route with resolver-driven
  Context, Task, and Execution sections plus gated `Initialize` and
  `Start now` actions. ([#90](https://github.com/kcosr/task-runner/pull/90))
- Added daemon HTTP definition routes for agents, assignments, and
  launchers (`GET /api/agents|assignments|launchers` plus detail
  variants with optional `cwd`), and browser API client support for
  definition reads plus fresh-run `init` / `start` requests with
  explicit `callerCwd`. ([#90](https://github.com/kcosr/task-runner/pull/90))
- Added opt-in daemon perf diagnostics behind `TASK_RUNNER_DEBUG_PERF`
  for request timing, projection timing, task-state lock timing, and
  event-loop telemetry, plus `TASK_RUNNER_DEBUG_PERF_INTERVAL_MS` to
  tune the periodic event-loop sample interval. ([#88](https://github.com/kcosr/task-runner/pull/88))
- Added run-group filtering across the daemon and web dashboard:
  `GET /api/runs?runGroupId=<group-id>` scopes results to one group,
  `RunSummary` includes `runGroupId`, and dashboard cards expose a
  run-group filter chip. ([#85](https://github.com/kcosr/task-runner/pull/85))
- Added `--parent-run <run-id>` for fresh `task-runner run` / `init`
  invocations, and in connected mode the CLI now forwards parent lineage
  explicitly as structured daemon request `parentRunId` instead of
  relying on implicit env forwarding between the client and daemon.
  ([#81](https://github.com/kcosr/task-runner/pull/81))
- Added the built-in `require-children-success` task-transition hook so
  assignments can block completion of selected tasks until direct child
  runs reach `success`.
  ([#82](https://github.com/kcosr/task-runner/pull/82))
- Added `task-runner run audit <run-id>` plus daemon/web audit history
  surfaces for reading cursored persisted run event history, and
  `scripts/migrate-run-events-v2.mjs` for upgrading legacy uncursored
  `run-events.jsonl` rows to schema v2.
  ([#76](https://github.com/kcosr/task-runner/pull/76))
- Added a persisted notes-only board filter in the web dashboard, plus
  `Ctrl+Shift+N` / `Cmd+Shift+N` for notes-only and matching
  `Ctrl+Shift` / `Cmd+Shift` shortcuts for pinned-only, archived, and
  hide-empty board filters. ([#73](https://github.com/kcosr/task-runner/pull/73))
- Added `task-runner run ready <run-id>` plus `RunCapabilities.canReady`
  across the CLI, daemon, contracts, and web dashboard so initialized
  runs can be explicitly promoted before first execution.
  ([#71](https://github.com/kcosr/task-runner/pull/71))
- Added `scripts/migrate-manifests-v10.mjs` to promote schema v9 run
  manifests to schema v10 and canonicalize repairable schema v10
  manifests by backfilling frozen launcher capture plus
  `callerInstructions`.
  ([#71](https://github.com/kcosr/task-runner/pull/71))
- Added first-class launcher definitions under
  `${TASK_RUNNER_CONFIG_DIR}/launchers/*.yaml|*.yml`, plus `task-runner
  list launchers` and `task-runner show launcher` across embedded and
  daemon control planes. ([#70](https://github.com/kcosr/task-runner/pull/70))
- Added assignment hook support with frozen `prepare` outputs, named
  hooks under `${TASK_RUNNER_CONFIG_DIR}/hooks`, assignment-local path
  hooks, raw `.ts` / `.mts` runtime loading through `jiti`, built-in
  `command` / `git-worktree` hooks, and public hook authoring exports
  from `@task-runner/core/hooks`. ([#66](https://github.com/kcosr/task-runner/pull/66))
- Added compact `run.hook_recorded` entries to per-run
  `run-events.jsonl` history for prepare, attempt, and task-transition
  hook executions while keeping manifest `hookAudits` as the richer
  detail projection surface. ([#66](https://github.com/kcosr/task-runner/pull/66))
- Added narrow declarative `when.sessionIndex` and
  `when.attemptIndexInSession` support for attempt-phase hooks. `git-worktree`
  can now also run during `beforeAttempt`, so assignments can lazily
  create or reuse worktrees on the first execution attempt instead of at
  init time.
  ([#66](https://github.com/kcosr/task-runner/pull/66),
  [#86](https://github.com/kcosr/task-runner/pull/86))
- Added `scripts/migrate-manifests-v9.mjs` to promote schema v8 run
  manifests to schema v9 and canonicalize repairable schema v9 manifests
  by backfilling hook descriptor/state/audit surfaces, repairing
  `assignment-seed.md` workspace capture paths, and expanding the frozen
  `resetSeed` shape current resume/discovery expects.
  ([#68](https://github.com/kcosr/task-runner/pull/68))
- Added SSH-assisted connected CLI mode with `--connect-host` /
  `TASK_RUNNER_CONNECT_HOST` and `--connect-local-port` /
  `TASK_RUNNER_CONNECT_LOCAL_PORT`, so daemon-targeted commands can keep a
  logical remote `--connect` URL while routing WebSocket and attachment
  HTTP traffic through an invocation-scoped local SSH forward. ([#64](https://github.com/kcosr/task-runner/pull/64))
- Added inline web attachment preview support for `image/png`,
  `image/jpeg`, `image/gif`, `image/webp`, and `image/svg+xml`, using
  blob-backed `<img>` rendering in the existing preview drawer while
  keeping markdown/plain-text preview behavior unchanged. ([#65](https://github.com/kcosr/task-runner/pull/65))
- Added config-time `${...}` env interpolation for agent and assignment
  frontmatter scalar values, with exact-match typed surfaces, prose
  surfaces that only interpolate on whole-field `${...}` matches, and
  load-time config errors for missing, empty, or invalid env input.
  ([#62](https://github.com/kcosr/task-runner/pull/62))
- Added an MIT `LICENSE` file and set `license: "MIT"` on the root and
  workspace package manifests. ([#60](https://github.com/kcosr/task-runner/pull/60))
- Added persistent per-run note and pin metadata across the shared
  manifest/DTO surfaces, including `task-runner run set-note`,
  `run clear-note`, `run pin`, and `run unpin`, with daemon HTTP/RPC
  parity and JSON detail/list projections for `note`, `notePresent`, and
  `pinned`. ([#58](https://github.com/kcosr/task-runner/pull/58))
- Added `N`, `P`, and `A` as web dashboard shortcuts for opening the
  selected run's note, toggling pin, and toggling archive. ([#58](https://github.com/kcosr/task-runner/pull/58))
- Added a grouped Filters control to the web dashboard for exact-match repo, agent, and backend filtering, with clickable run-card metadata badges as filter shortcuts and a `Ctrl+Shift+F` keyboard shortcut to open the panel. ([#56](https://github.com/kcosr/task-runner/pull/56))
- Added per-run `run-events.jsonl` audit history files that append compact lifecycle, backend-session, and task-mutation records for debugging while keeping `run.json` canonical. Reset now preserves prior audit history and appends a reset event; delete removes the audit file with the workspace. ([#53](https://github.com/kcosr/task-runner/pull/53))
- Added runner-injected interpolation vars `config_dir`, `state_dir`, and `assignment_name` for repo-owned assignments and caller instructions. ([#52](https://github.com/kcosr/task-runner/pull/52))
- Added static web dashboard keyboard shortcuts for route-aware Escape handling, arrow-key run navigation, Ctrl+F search focus, and Enter primary actions for the selected run. ([#50](https://github.com/kcosr/task-runner/pull/50))
- Added `f` as a web dashboard shortcut to toggle the visible detail drawer between normal and fullscreen widths. ([#50](https://github.com/kcosr/task-runner/pull/50))
- Added previous/next navigation for attachment previews in the web detail drawer, including fullscreen left/right keyboard navigation while previewing attachments. ([#50](https://github.com/kcosr/task-runner/pull/50))
- Added a populated Keybindings settings page in the web dashboard so the current shortcut set is visible in the UI with keycap styling. ([#50](https://github.com/kcosr/task-runner/pull/50))
- Added a `Visible focus indicators` display preference in Settings > General for toggling dashboard focus-ring styling. ([#54](https://github.com/kcosr/task-runner/pull/54))

### Changed

- The web run detail drawer now starts Attempts timeline and Audit history
  loading only when those tabs are first opened, then keeps those streams
  active while the run remains selected. ([#113](https://github.com/kcosr/task-runner/pull/113))
- `npm test` and `npm run check` now use a remote test gate when
  `TASK_RUNNER_TEST_REMOTE_HOST` is set, with Node tests using the dot
  reporter. Without that env var, they use the local concurrent Node/web
  test runner. ([#112](https://github.com/kcosr/task-runner/pull/112))
- Daemon summary/detail projection refreshes now skip task-state filesystem
  locks by default to avoid stale-lock stalls; set
  `TASK_RUNNER_DAEMON_FILESYSTEM_LOCKS=true` to preserve locked daemon
  projection reads when mixing daemon mode with standalone writers.
  ([#112](https://github.com/kcosr/task-runner/pull/112))
- Dependencies now accept explicit typed refs: `run add-dep --run
  <run-id>` for one upstream run or `run add-dep --group <group-id>` for
  all non-archived members of a group. Remove commands use the same
  typed flags.
- Attachment listing now defaults to group scope. Group-scoped rows
  include `ownerRunId`, and the web dashboard presents one combined
  attachment list with other-run rows read-only.
- Parent lineage is now documented only as lineage and parent-var
  inheritance. Run grouping owns group filters, group attachments, and
  group dependency semantics.
- Split Biome scripts so `npm run lint` runs lint-only with warnings as
  failures, `npm run lint:fix` applies lint fixes, `npm run format`
  writes formatting, `npm run imports:fix` applies import organization,
  and `npm run check` verifies formatting and import organization with
  `format:check` and `imports:check`.
  ([#101](https://github.com/kcosr/task-runner/pull/101))
- Ready runs can now be schedule-gated: the daemon starts due schedules,
  skips overdue startup occurrences instead of replaying stale work, and
  recurring schedules advance according to `reuse`, `reset`, or `clone`
  mode. ([#96](https://github.com/kcosr/task-runner/pull/96))
- Updated the web tooling stack to Vite 8, `@vitejs/plugin-react` 6, and
  Vitest 4, and raised the documented Node.js floor to 20.19+ or 22.12+.
  ([#98](https://github.com/kcosr/task-runner/pull/98))
- Attempt-phase hooks now receive and match `attemptIndexInSession` for
  the zero-based attempt position inside the current session; monotonic
  run-wide attempt identity is exposed separately as `attemptNumber`.
  ([#94](https://github.com/kcosr/task-runner/pull/94))
- `plan-feature` now accepts optional `worktree_base_ref` so generated
  implementation worktrees can be based on refs other than `origin/main`,
  enabling pre-merge end-to-end testing from feature branches. ([#93](https://github.com/kcosr/task-runner/pull/93))
- Built-in code-review assignments now reference shared review tasks by
  named task refs such as `review/architecture`. ([#93](https://github.com/kcosr/task-runner/pull/93))
- Future `code-review` runs now use shared review-dimension task ids under
  `review/...` while keeping `plan_coverage` as the implementation-run
  plan check. Existing run manifests keep their frozen old task ids. ([#93](https://github.com/kcosr/task-runner/pull/93))
- Direct path loads outside `TASK_RUNNER_CONFIG_DIR` may now use authored
  agent, assignment, task, and launcher identities that differ from their
  filesystem-derived canonical ids. Config-root named definitions still
  require authored identities to match their canonical path ids.
  ([#92](https://github.com/kcosr/task-runner/pull/92))
- Task-transition hooks now match natively on `taskId`, `taskIds`,
  `fromStatus`, `toStatus`, and `source`; unmatched hooks are skipped
  without emitting accepted `run.hook_recorded` audit rows, and
  task-local hooks run before assignment-level task-transition hooks.
  ([#87](https://github.com/kcosr/task-runner/pull/87))
- Changed the web run detail drawer audit view to render friendlier hook
  messages, add `All` / `Hooks` / `Tasks` / `Run` filters, and show an
  explicit empty-filter state. ([#87](https://github.com/kcosr/task-runner/pull/87))
- Built-in implementer assignments now start from `repo_root` and use a
  first-attempt `git-worktree` hook plus explicit base-ref sync instead
  of creating worktrees during `prepare`.
  ([#86](https://github.com/kcosr/task-runner/pull/86))
- Assignment vars now default omitted `sources` to both `cli` and
  `web`, and authored source order can now include the explicit `web`
  runtime source for browser-submitted values.
  ([#90](https://github.com/kcosr/task-runner/pull/90))
- Changed daemon fresh-run start/init contracts so browser HTTP requests
  carry only `webVars` while connected CLI RPC requests carry only
  `cliVars`; the daemon now normalizes each transport into the shared
  internal run request at the boundary.
  ([#90](https://github.com/kcosr/task-runner/pull/90))

### Fixed

- Web dashboard Chat/Detail tabs now remove the inactive selected-run
  tab body from layout, preventing Detail content from appearing below
  the Chat composer.
- Web dashboard Chat now renders automatic follow-up attempt prompts as
  System cards inline instead of hiding prior attempt output behind a
  retry disclosure.
- Web dashboard Chat now renders the user's typed message as a plain
  user bubble and shows daemon-synthesized prompts (worker brief, added
  tasks reminder, implicit continue) as a separate "System" card
  instead of attributing the system text to the user.
- Wide content in Chat assistant bubbles (Markdown tables and code
  blocks) now wraps and scrolls inside the bubble instead of forcing
  the chat area to scroll horizontally.
- Web dashboard no longer renders an empty opaque right-surface overlay
  on mobile when no run is selected; the wrapper only mounts when the
  detail panel has content. The board is visible at `/` on narrow
  viewports.
- Web dashboard body uses `100dvh` for its minimum height so the page
  matches the visible viewport on mobile browsers and does not require
  a small downward scroll when the URL bar is shown.
- Attempts drawer now moves immediately to the live Response view when a
  resumed or follow-up run reports a new active attempt before timeline
  history has caught up.
  ([#116](https://github.com/kcosr/task-runner/pull/116))
- Daemon-connected fresh `init --message-file` and fresh
  `run --message-file` now forward the file contents in
  `overrides.message` instead of snapshotting overrides before the
  client reads the file.
  ([#114](https://github.com/kcosr/task-runner/pull/114))
- Test runtime isolation now preserves `TASK_RUNNER_DEBUG_PERF` and
  `TASK_RUNNER_DEBUG_PERF_INTERVAL_MS`, so perf diagnostics appear during
  `npm run check` when enabled by the caller. Tests also clear
  `TASK_RUNNER_RUN_GROUP_ID` so caller defaults do not leak into test
  runs. ([#112](https://github.com/kcosr/task-runner/pull/112))
- Dashboard Resume and run-note dialogs, plus the mobile Filters panel,
  now use native modal dialog behavior so Escape/back dismissal, focus
  trapping, and fullscreen drawer stacking behave consistently.
  ([#106](https://github.com/kcosr/task-runner/pull/106))
- Broke the hook loader/registry circular import by moving
  `HookConfigError` into a shared hook errors module.
  ([#102](https://github.com/kcosr/task-runner/pull/102))
- Dashboard `Enter` now triggers the selected run's primary action from
  fullscreen detail and attachment preview drawers, with the Resume dialog
  layered above fullscreen drawer surfaces.
  ([#103](https://github.com/kcosr/task-runner/pull/103))
- Cleaned high-confidence unused exports/types and declared direct `zod`
  dependencies for the CLI and web workspaces.
- Codex backend streams now ignore child/subagent thread turn events when
  accumulating transcript output and deciding whether the parent task-runner
  attempt has completed, preventing native subagent completion from prematurely
  ending the parent attempt.
  ([#99](https://github.com/kcosr/task-runner/pull/99))
- Markdown attachment previews now render leading YAML frontmatter as a
  preformatted code block instead of mixing it into the rendered Markdown
  body. ([#95](https://github.com/kcosr/task-runner/pull/95))
- The run detail timeline no longer flashes the stale-data warning on
  normal terminal-event reconciliation; terminal reloads now happen
  silently while real stream breakage still surfaces the warning.
  ([#88](https://github.com/kcosr/task-runner/pull/88))
- Fixed shared `RunDetail` projections to normalize missing legacy hook
  `taskScopeId` and `summary` fields before serving older manifests to
  the web dashboard. ([#87](https://github.com/kcosr/task-runner/pull/87))
- Fixed the mobile web shell for the new run flow so phone-sized
  viewports keep the main content visible, avoid bottom-nav overlap, and
  surface primary navigation in the top bar.
  ([#90](https://github.com/kcosr/task-runner/pull/90))

### Removed

- Removed live family grouping contracts: `familyRootRunId`,
  `familyOf=<run-id>`, and attachment `scope=family`.
- Removed the live run-only dependency array contract from current
  manifests and DTOs in favor of typed `dependencies`.
- Removed redundant per-attempt task snapshots from new
  `attemptRecords`; `finalTasks` remains the canonical task state.
  ([#105](https://github.com/kcosr/task-runner/pull/105))
- Removed the unreleased `git-sync-base` built-in hook in favor of
  explicit first-attempt fast-forward sync flows.
  ([#86](https://github.com/kcosr/task-runner/pull/86))

- Assignment vars now use ordered `sources` (`cli`, `env`, `parent`)
  instead of the old singular source contract, nested runs freeze
  `parentRunId` for lineage-based inheritance, and run summaries/details
  surface parent-run linkage while keeping env-backed vars redacted at
  read time.
- Changed the bundled planning workflow so `plan-feature` now requires
  `--var worktree_slug=...`, freezes `repo_root` plus a derived sibling
  `worktree_path` during planning, generates implementer drafts that
  inherit those vars through `sources: [parent]`, and keeps nested
  code-review runs in the same worktree cwd without manual var
  repetition. ([#80](https://github.com/kcosr/task-runner/pull/80))

- Changed daemon-managed ready-run scheduling so dependency-bearing runs
  auto-start once every dependency run is successful, including
  ready-time checks and daemon startup/rebuild sweeps after restarts.
  ([#75](https://github.com/kcosr/task-runner/pull/75))
- Changed `task-runner list runs` text output to append each run's exact
  persisted `cwd=...` alongside repo, agent, and assignment metadata.
  ([#73](https://github.com/kcosr/task-runner/pull/73))
- Changed attempt-log persistence to omit captured stdout by default;
  set `TASK_RUNNER_FULL_ATTEMPT_LOGS=1` to keep full stdout in
  per-attempt records for local debugging. ([#73](https://github.com/kcosr/task-runner/pull/73))
- Changed the web run detail drawer to expose read-only `Vars` and
  `Hook state` data in a dedicated `Data` tab with a clearer key/value
  table layout, and moved the mobile note/resume dialogs lower so they
  sit above the keyboard more reliably. ([#72](https://github.com/kcosr/task-runner/pull/72))
- Changed the web dashboard board and primary action semantics so
  initialized runs stay in `Initialized`, ready runs move to `Ready`, and
  the primary action switches between `Ready`, `Start`, and `Resume`
  based on lifecycle state and attempt history.
  ([#71](https://github.com/kcosr/task-runner/pull/71))
- Changed subprocess backend startup so agents can author `launcher`
  either as a named string or inline object, fresh runs can override it
  with named-only `--launcher`, connected mode resolves named launchers
  on the daemon host, and subprocess backends (`claude`, `cursor`, `pi`,
  Codex stdio) honor the frozen launcher while passive and Codex
  websocket runs stay on built-in `direct`.
  ([#70](https://github.com/kcosr/task-runner/pull/70))
- Changed shared run projections so `RunSummary` includes `hookCount`,
  `RunDetail` includes `resolvedHooks` / `hookState` / `hookAudits`, and
  hook-driven note/pin/task/attachment mutations reuse the existing
  summary/detail/timeline daemon event names instead of introducing a
  separate hook stream. ([#66](https://github.com/kcosr/task-runner/pull/66))
- Changed the bundled planning workflow so `plan-feature` creates the
  implementer run during the initial pass, keeps
  `assignment-seed.md` / `assignment-summary.md` on the planning run,
  teaches the caller to approve execution with `run ready`, and, when
  caller feedback arrives after init, refreshes the planning-run
  attachments and reinitializes the same implementer run with
  `init --run-id ...` instead of recreating it.
  ([#63](https://github.com/kcosr/task-runner/pull/63),
  [#71](https://github.com/kcosr/task-runner/pull/71))
- Changed the web run detail drawer so the attempts `Message` tab remains available after attempts start, keeping the concise run handoff visible alongside the full prompt. ([#63](https://github.com/kcosr/task-runner/pull/63))
- Changed the web run detail drawer so attempt `Output` is now split into `Response` (transcript) and `Diagnostics` (backend notices), and the top-level drawer section tabs stay on one line with horizontal scrolling on narrow layouts. ([#69](https://github.com/kcosr/task-runner/pull/69))
- Changed the web dashboard so pinned runs sort first within each status
  column, cards and the detail drawer share the same note editor/mutation
  flow, and the persisted preferences now include a pinned-only filter. ([#58](https://github.com/kcosr/task-runner/pull/58))
- Changed run status text output to surface compact note/pin indicators
  without printing note markdown bodies, and kept run notes out of worker
  brief/prompt composition by default. ([#58](https://github.com/kcosr/task-runner/pull/58))
- Changed daemon summary/detail publication and healthy-stream web
  mutations to avoid full run-list/detail recomputation and refetches for
  simple note/pin/rename/archive updates. ([#58](https://github.com/kcosr/task-runner/pull/58))
- Codex transport selection now uses the explicit
  `backendSpecific.codex.transport` contract, with fresh-run precedence of
  agent frontmatter → daemon request override → `TASK_RUNNER_CODEX_WS_URL`
  → stdio default. Runs and reset seeds now freeze the resolved Codex
  transport so resume ignores later client/daemon env drift. This change
  is Codex-only and does not add generic env passthrough for other
  backends. ([#55](https://github.com/kcosr/task-runner/pull/55))
- Changed the web run detail drawer summary to promote `Ended` and `Exit code`, widen long metadata rows to use the full summary width, and remove the separate `Timing` tab. ([#54](https://github.com/kcosr/task-runner/pull/54))
- Changed the web dashboard board so non-success terminal columns appear before `Completed`, and persisted each column's collapse state across reloads. ([#56](https://github.com/kcosr/task-runner/pull/56))
- Changed web dashboard Escape behavior so a fullscreen detail drawer exits fullscreen first, and only closes on a subsequent Escape. ([#50](https://github.com/kcosr/task-runner/pull/50))
- Added first-class `pi` backend support via Pi RPC over stdio, including
  cwd-scoped session-id validation/import, run-name propagation, and automatic
  cancellation of unsupported extension UI prompts while leaving extensions,
  skills, and prompt templates enabled. ([#49](https://github.com/kcosr/task-runner/pull/49))
- Added `task-runner attachment list --cwd-scope` for exact same-cwd peer attachment discovery, and split the web run-detail Attachments area into `Run` and `Group` tabs so peer attachments can be previewed and downloaded without changing per-run ownership. ([#47](https://github.com/kcosr/task-runner/pull/47))
- Added `task-runner run set-backend-session <id|path> <session-id>` and `task-runner run clear-backend-session <id|path>` for passive runs, with daemon HTTP/RPC parity plus inline web detail-drawer editing for passive and archived-passive backend session ids. ([#45](https://github.com/kcosr/task-runner/pull/45))
- Added `scripts/migrate-manifests-v8.mjs` to backfill persisted `repo` capture for existing `schemaVersion: 7` run manifests, including legacy state roots passed via `--root` such as `~/.local/state/agent-runner`, with repeated `--repo <name>` filters for migrating only selected repo buckets. ([#43](https://github.com/kcosr/task-runner/pull/43))
- Added a dedicated Settings area in the web shell with General and Keybindings sections, and moved dashboard defaults there while keeping the runs-toolbar toggles in sync. ([#42](https://github.com/kcosr/task-runner/pull/42))
- Added a persisted dashboard preference for recent-updates board ordering so runs can promote touched cards to the top of their columns, with move/reorder/insert card motion that respects `prefers-reduced-motion`. ([#42](https://github.com/kcosr/task-runner/pull/42))
- Added in-app preview for `text/markdown` and `text/plain` attachments in the web run detail drawer, including per-run remembered preview state when switching between runs. ([#40](https://github.com/kcosr/task-runner/pull/40))
- Added Mermaid diagram rendering for fenced `mermaid` blocks anywhere shared markdown is shown, including attachment previews, with inline render errors when a diagram fails to load. ([#40](https://github.com/kcosr/task-runner/pull/40))
- The attachment preview drawer is now resizable via the same edge drag/keyboard handle used by the run detail drawer, and both drawers gained a full-width toggle next to the close button (desktop only) that expands the drawer to fill the entire main content area while keeping the top bar and left sidebar interactive. ([#40](https://github.com/kcosr/task-runner/pull/40))
- Added `task-runner run delete <id|path>` plus daemon HTTP/RPC parity and web detail-drawer support for deleting archived runs. ([#39](https://github.com/kcosr/task-runner/pull/39))
- Added bundled `planner` and `test` agents for planning and validation flows. ([#38](https://github.com/kcosr/task-runner/pull/38))
- Added `scripts/migrate-manifests-v7.mjs` to upgrade existing v6 run manifests by converting `pendingPrompt` / `taskMode` into persisted `brief` fields for manifests, reset seeds, and sessions. ([#38](https://github.com/kcosr/task-runner/pull/38))
- Added normalized per-run timeline history at `GET /api/runs/:runId/timeline`, cursored live timeline envelopes over daemon SSE/WebSocket, and an attempt-oriented web drawer timeline that bootstraps from history before continuing live output. ([#36](https://github.com/kcosr/task-runner/pull/36))
- Added `scripts/task-list-markdown.mjs` to render `task-runner task list <run-id> --output-format json` output as Markdown, defaulting to `task-runner` on `PATH` with an optional `TASK_RUNNER_BIN` override. ([#33](https://github.com/kcosr/task-runner/pull/33))
- Added first-class `cursor` backend support via the public `cursor-agent` headless print mode, including streamed partial-output rendering, captured session-id resume for task-runner-created runs, `TASK_RUNNER_CURSOR_BIN`, and explicit rejection of unsafe bootstrap `--backend-session-id` import. ([#33](https://github.com/kcosr/task-runner/pull/33))
- Added `task-runner run --detach` for daemon-connected fresh runs and
  resumes so the CLI can dispatch `runs.start` / `runs.resume`, print a
  detached confirmation, and exit immediately without waiting for
  `run_finished`. ([#31](https://github.com/kcosr/task-runner/pull/31))
- Added persisted run execution context (`execution.hostMode` plus
  `execution.controller`) to shared run summaries/details and manifest
  writes, and added `daemonInstanceId` to daemon health/read surfaces so
  clients can distinguish embedded runs from daemon-owned sessions. ([#29](https://github.com/kcosr/task-runner/pull/29))
- Added collapsible kanban columns in the web dashboard, including
  persisted collapsed state, jump-strip expansion, and polished
  collapsed-label rendering. ([#28](https://github.com/kcosr/task-runner/pull/28))
- Added derived `effectiveStatus` to shared `RunSummary` / `RunDetail`
  read models so passive runs with `in_progress` tasks surface as
  running in CLI/daemon/web consumers without changing the canonical
  persisted lifecycle `status`. ([#26](https://github.com/kcosr/task-runner/pull/26))
- Added `task-runner run set-name <id|path> (<name> | --clear)` plus daemon/HTTP parity so existing runs can update persisted `run.name` without rewriting the run. Run list/status/web surfaces now render the stored run name, the web detail drawer can rename runs inline, Codex best-effort propagates live renames to the backend thread title, and Claude picks up the changed name on the next invocation. ([#25](https://github.com/kcosr/task-runner/pull/25))
- Added a local daemon control plane: `task-runner serve` now starts a
  loopback WebSocket JSON-RPC server, run/definition commands can opt
  into daemon mode with `--connect` / `TASK_RUNNER_CONNECT`, and daemon
  clients can subscribe to typed `RunEvent` notifications for live
  progress. ([#21](https://github.com/kcosr/task-runner/pull/21))
- Added browser-facing HTTP and SSE daemon transport alongside the
  existing loopback WebSocket RPC control plane. `task-runner serve`
  now exposes run/task HTTP endpoints under `/api/...`, streams live
  run events over `/api/events/...`, and keeps the shared
  `src/app/service.ts` seam as the transport-independent business
  layer. ([#24](https://github.com/kcosr/task-runner/pull/24))
- Added first-class run dependency management with `task-runner run add-dep`, `run remove-dep`, and `run clear-deps`, plus daemon RPC/HTTP and web dashboard support for editing and inspecting direct dependencies and dependents. Initialized runs now expose dependency readiness in list/status surfaces, and resume rejects unsatisfied prerequisites. ([#30](https://github.com/kcosr/task-runner/pull/30))
- Added `scripts/migrate-manifests-v5.mjs` to backfill `dependencyRunIds` and upgrade existing v4 run manifests in `${TASK_RUNNER_STATE_DIR}` to schema version 5. ([#30](https://github.com/kcosr/task-runner/pull/30))
- Added first-class run attachments with manifest-backed metadata, workspace-local attachment storage, CLI `attachment add|list|download|remove`, daemon HTTP upload/download endpoints, and a web detail-drawer attachments tab. Run summaries now expose `attachmentCount` and run details expose `attachments`. ([#32](https://github.com/kcosr/task-runner/pull/32))
- Added `scripts/migrate-manifests-v6.mjs` to backfill `attachments: []` and upgrade existing v5 run manifests in `${TASK_RUNNER_STATE_DIR}` to schema version 6. ([#32](https://github.com/kcosr/task-runner/pull/32))
- Added a transport-neutral `src/contracts/runs.ts` seam for shared run DTOs and pure mappers (`RunSummary`, `RunDetail`, `RunArchiveResult`, `RunCapabilities`) so later CLI/web/daemon surfaces can project from `RunManifest` without binding directly to raw manifest internals. ([#16](https://github.com/kcosr/task-runner/pull/16))
- Added `task-runner task list`, `task show`, and `task append-notes`, plus `task add --body`, for a fuller CLI task workflow surface. The new read commands return stable task snapshots in text or JSON, and append-notes uses deterministic single-newline joining.
- Added `task-runner brief <run-id>` as the canonical text-only worker handoff surface for initialized, running, and terminal runs. ([#34](https://github.com/kcosr/task-runner/pull/34))
- Added run-management commands: `task-runner list runs`, `task-runner run archive <id|path>`, and `task-runner run unarchive <id|path>`. Run discovery now scans current-generation manifests under `${TASK_RUNNER_STATE_DIR}/runs/`, `list runs` hides archived runs unless `--include-archived` is passed, and archive toggles are idempotent in text and JSON output. ([#15](https://github.com/kcosr/task-runner/pull/15))
- Added `agents/implementer/` — a bundled plan-feature execution agent (backend `codex`, model `gpt-5.4`, effort `high`, unrestricted). Tuned to read task bodies and `Done when:` criteria end-to-end, cite file paths in task Notes, and capture concrete evidence (file paths, exit codes, commit shas) for the reviewer's plan-coverage pass to consume. The `plan-feature` meta-assignment now hard-codes `--agent implementer` at `task-runner init` time, so every generated plan inherits a dedicated implementer agent instead of whatever the planner happened to pick.
- Added `assignments/plan-review/` — a bundled draft-plan reviewer for `plan-feature`. It reads the generated draft assignment plus the planner workspace artifact, checks contract fidelity, task quality, workflow wiring, and handoff clarity, and ends with an explicit `approval` gate so the planner can iterate until the draft is actually ready for handoff. ([#11](https://github.com/kcosr/task-runner/pull/11))
- Added `task-runner list <agents|assignments>` and `task-runner show <agent|assignment> <name|path>` commands for read-only definition inspection. Both discover named definitions from the configured task-runner config root, support `--output-format json`, and create no run artifacts. ([#8](https://github.com/kcosr/task-runner/pull/8))
- Added agent onboarding guidance in `AGENTS.md` and a `CLAUDE.md` symlink to the same content. ([#6](https://github.com/kcosr/task-runner/pull/6))
- Added a root `CHANGELOG.md` with unreleased and release-section structure for future updates. ([#6](https://github.com/kcosr/task-runner/pull/6))
- Added stricter assignment/task regression coverage for structural markdown escaping, task-command terminal-state handling, runtime var validation, Codex interruption, and subprocess abort paths. ([#6](https://github.com/kcosr/task-runner/pull/6))
- Added `assignments/plan-feature/` — a meta-assignment that turns a free-form feature description (passed as the positional message body) into an executable task-runner plan. The planner surveys repo conventions, impact surface, reuse opportunities, and risks, then copies a reference template into the repo-name task-runner drafts area under `${TASK_RUNNER_STATE_DIR}/drafts/`, fills in every placeholder with concrete file-level detail, and hands back the exact `task-runner init --agent implementer ...` command the caller should run once the draft is approved. ([#8](https://github.com/kcosr/task-runner/pull/8))
- Added `TASK_RUNNER_CMD` and the runner-injected `{{task_runner_cmd}}` template variable so user-facing workflow instructions can point at the installed `task-runner` command path instead of hardcoding the bare command name. ([#9](https://github.com/kcosr/task-runner/pull/9))
- Added `apps/web`, a phase-1 same-origin run dashboard built with
  React/Vite. `task-runner serve` now serves the packaged SPA,
  `/app-config.json`, and the existing `/api/*` + `/api/events/*`
  control-plane routes from one origin, and the repo now ships
  the canonical visual-contract mockup under
  `apps/web/mockups/run-dashboard.{html,css}`. ([#24](https://github.com/kcosr/task-runner/pull/24))

### Changed

- The web run detail drawer now shows a `Pending` attempt preview for initialized zero-attempt runs, defaults that pending state to `Message`, follows newly started attempts into `Output`, and consolidates peer attachments into one list with clickable source run ids plus combined attachment counts. ([#59](https://github.com/kcosr/task-runner/pull/59))
- Restructured the docs set into focused per-topic pages, refreshed `README.md` positioning and usage guidance, and moved the web dashboard mockup CSS into `apps/web/src/` while dropping the legacy mockup HTML/README reference. ([#51](https://github.com/kcosr/task-runner/pull/51))
- Attachment uploads now allow up to 100 attachments per run while keeping the existing 25 MiB per-attachment and 100 MiB total-per-run quotas. ([#50](https://github.com/kcosr/task-runner/pull/50))
- `task-runner attachment list --cwd-scope` now shows `owner=<run-id>` in text output so humans can download peer attachments without switching to JSON, and the bundled planning/review assignments now keep `assignment-seed.md` / `assignment-summary.md` on the planning run while teaching implementer and reviewer flows to discover them through cwd-scoped attachment listing. ([#47](https://github.com/kcosr/task-runner/pull/47))
- The web run detail drawer now requires inline confirmation before aborting or resetting a run. ([#46](https://github.com/kcosr/task-runner/pull/46))
- The web dashboard now persists only durable board preferences (`hideEmptyColumns`, `collapseFailureStates`, `showArchived`, `sortByRecentUpdates`); transient filters, collapsed columns, drawer width/fullscreen state, and per-run drawer tabs reset on full reload instead of carrying across sessions. ([#42](https://github.com/kcosr/task-runner/pull/42))
- The attachment preview drawer now uses a more compact header layout and hides MIME type metadata in preview mode to reduce wasted vertical space, especially on mobile. ([#40](https://github.com/kcosr/task-runner/pull/40))
- Replaced the bundled `repo-diagnostics` assignment with a bundled `test` assignment that only asks the agent to run `date` and `pwd`, without repo-specific context. ([#38](https://github.com/kcosr/task-runner/pull/38))
- The web run detail drawer now shows `Reset` for non-running runs and only renders `Reset` / `Delete` when the backend-derived shared lifecycle capabilities allow them. ([#39](https://github.com/kcosr/task-runner/pull/39))
- Archived-run delete in the web detail drawer now uses an inline confirm/cancel step, and the Attempts view now keeps the attempt + prompt/output controls pinned above a dedicated nested transcript scroller that only auto-follows live output while the user is already at the bottom. ([#42](https://github.com/kcosr/task-runner/pull/42))
- The web timeline drawer now uses an `Attempts` section label, drops the redundant per-attempt metadata header, and renders attempt prompts/output as Markdown so streamed transcripts can progressively format in place. ([#36](https://github.com/kcosr/task-runner/pull/36))
- The web run detail drawer now shows `Start` for initialized resumable runs, keeps `Resume` for existing sessions, makes follow-up messages optional behind a disclosure while incomplete tasks remain, still requires a message once all tasks are complete, and truncates in-progress card task labels so long titles do not widen the board layout. ([#37](https://github.com/kcosr/task-runner/pull/37))
- The web dashboard now applies live `RunSummary` and `RunDetail` snapshots directly to the board/detail caches, so card progress, attachment/dependency badges, and active-task labels update from streamed projections without relying on selected-run invalidation. ([#35](https://github.com/kcosr/task-runner/pull/35))
- Polished the web detail drawer's Attachments and Dependencies tabs: attachment rows now render with the shared row card styling and human-readable sizes (e.g. `2.1 MB`), dependency rows show a status badge instead of plain-text status, destructive actions use the destructive-outline button tone, and empty "Depends on" / "Required by" sections are hidden instead of showing duplicate empty-state copy. ([#32](https://github.com/kcosr/task-runner/pull/32))
- Kanban run cards now surface dependency readiness and attachment presence directly in the card metadata row so planning artifacts and blocked prerequisites are visible without opening the drawer. ([#32](https://github.com/kcosr/task-runner/pull/32))
- `assignments/plan-feature/` now attaches `assignment-seed.md` and `assignment-summary.md` to the planning run, waits for explicit caller approval before creating the implementer run, and teaches generated implementer/code-review orientations to review `assignment-summary.md` for supplemental context when it exists. ([#32](https://github.com/kcosr/task-runner/pull/32))
- The web dependency editor now searches candidate runs by run name, assignment name, and run id before submitting the selected dependency run id. ([#30](https://github.com/kcosr/task-runner/pull/30))

- Relaxed resume validation so task-backed runs can resume without a
  caller message when incomplete tasks remain; core now synthesizes an
  implicit continue prompt for that empty-resume case. ([#29](https://github.com/kcosr/task-runner/pull/29))
- Run capabilities now expose explicit abort authority:
  `canAbort=false` with `abortReason` for terminal or daemon-unowned
  runs, and daemon/read/web surfaces now gate Abort from that
  capability instead of inferring it from liveness alone.
- `task-runner status` and `task-runner list runs` now render the
  shared derived `effectiveStatus` as their primary status surface, and
  the web dashboard groups/badges by `effectiveStatus` while keeping
  archive/resume/task-mutation affordances keyed to canonical
  lifecycle `status`. ([#26](https://github.com/kcosr/task-runner/pull/26))
- `task-runner serve` no longer restricts `--listen` / `TASK_RUNNER_LISTEN` to loopback hosts, and the web dashboard now keeps long kanban/task lists scrollable while the detail drawer sections start collapsed and can be expanded on demand. ([#24](https://github.com/kcosr/task-runner/pull/24))
- Refined the web dashboard interaction model: the detail drawer now closes on `Escape`, the board toolbar exposes archived / empty-column / failure-grouping toggles directly in the header, and mobile kanban scrolling snaps more reliably between columns. ([#24](https://github.com/kcosr/task-runner/pull/24))
- Added a board jump strip above the kanban that exposes only the currently rendered non-empty columns and scrolls them into view when the board overflows. ([#24](https://github.com/kcosr/task-runner/pull/24))
- Renamed task-body tabs in the detail drawer from `Description` to `Instructions` for consistency with assignment/task wording. ([#24](https://github.com/kcosr/task-runner/pull/24))
- Refactored the daemon control plane so HTTP and WebSocket commands
  now flow through one shared operations layer, keeping transport
  parsing thin while preserving shared run/definition DTO behavior. ([#24](https://github.com/kcosr/task-runner/pull/24))
- Split the repo into npm workspaces: the root package is now a private orchestration workspace, `apps/cli` owns the `task-runner` executable plus `serve` transport host, and `packages/core` owns shared run lifecycle, config/assignment loading, backend adapters, contracts, and helpers. Root `npm run build`, `test`, `lint`, and `check` still work unchanged, but generated build output now lives under the workspace packages instead of a single root `dist/`. ([#23](https://github.com/kcosr/task-runner/pull/23))
- `task-runner` now has an explicit dual-host model. Embedded mode keeps
  the existing in-process CLI behavior, while daemon mode moves live run
  ownership and external abort control into the local daemon without
  silently falling back to embedded execution. ([#21](https://github.com/kcosr/task-runner/pull/21))
- Root build/test/check wiring now includes the new `apps/web` workspace,
  and the CLI package build/prepack flow copies built web assets into
  `apps/cli/dist/web` so installed `task-runner serve` can host the
  dashboard without depending on a sibling workspace checkout. ([#24](https://github.com/kcosr/task-runner/pull/24))
- Fresh run cwd resolution now preserves whether an agent file explicitly
  authored `cwd`. `--cwd` still wins, explicit agent `cwd` still wins
  next, daemon runs otherwise use the client caller's cwd, and embedded
  runs otherwise fall back to the host process cwd. ([#21](https://github.com/kcosr/task-runner/pull/21))
- Build and packaging no longer rely on git-tracked `dist/` output. `dist/` is generated locally and during `prepack`, and the build step explicitly marks `dist/cli.js` executable on Unix-like systems.
- Extracted an explicit internal `src/core/` seam: transport-neutral run lifecycle, command services, schema/interpolation helpers, and the abstract backend contract now live under `src/core/`, while CLI parsing and text rendering remain at the transport edge. `config/loader.ts` is now filesystem-only, and the old mixed `runner/output.ts` responsibilities were split into core live-status shaping plus CLI renderers. ([#20](https://github.com/kcosr/task-runner/pull/20))
- Refactored command execution around transport-agnostic core contracts: non-run commands now execute through typed `src/commands/` services, `runAgent` emits typed events instead of writing terminal text directly, and the CLI renders text/json output at the transport edge. ([#13](https://github.com/kcosr/task-runner/pull/13))
- `assignments/plan-feature/` handoff init commands now freeze generated plans with `--backend passive` and `--var repo_path=<worktree-dir>` instead of hard-coding `--agent implementer` and a machine-specific repo path. `assignments/plan-review/` now enforces that passive-backend handoff shape during draft review. ([#15](https://github.com/kcosr/task-runner/pull/15))
- Run manifests now carry `archivedAt`, existing schema-version-3 manifests normalize a missing archive marker to `null`, `task-runner status` surfaces archive metadata, and archived runs are rejected by `task-runner run --resume-run` until unarchived. ([#15](https://github.com/kcosr/task-runner/pull/15))
- `task-runner run reset` now restores the initialized manifest seed without regenerating a live workspace task file. Assignment-backed runs keep an immutable `assignment-seed.md` snapshot for audit only. ([#34](https://github.com/kcosr/task-runner/pull/34))
- Run task state is now manifest-canonical for every run. Workers are handed a run id plus task CLI workflow through `brief`, passive `init` points callers at `task-runner brief <run-id>`, and in-flight non-passive runs allow `task set` / `task append-notes` without any task-mode split. ([#34](https://github.com/kcosr/task-runner/pull/34))
- `agents/code-reviewer/` flipped from `codex` / `gpt-5.3-codex` to `claude` / `claude-opus-4-6`. The role body and severity format are unchanged; only the backend and model. Plan-feature-driven reviews now run on opus without needing template-level `--backend` / `--model` overrides. Callers that want the old configuration can still override via `--backend codex --model gpt-5.3-codex` at run time.
- Shared workspace task-state loading and persistence between the run loop and CLI task commands so assignment overlays, manifest snapshots, and canonical writes follow one code path. ([#6](https://github.com/kcosr/task-runner/pull/6))
- Updated the standard verification workflow so `npm run check` runs build, lint, and test coverage together. ([#6](https://github.com/kcosr/task-runner/pull/6))
- `assignments/code-review/` now uses required `implementation_run_id` input and reads canonical run tasks/attachments by run id for plan-coverage review instead of parsing a workspace markdown file. ([#34](https://github.com/kcosr/task-runner/pull/34))
- `assignments/code-review/` now ends with an explicit `approval` ship / no-ship decision task. The task lives separately from the synthesis so the reviewer's *decision* ("I approve this work") is distinct from the synthesis *deliverable* ("here is the ranked findings list"). Review runs exit `success` (code 0) only when the reviewer approves; unresolved HIGH/CRITICAL findings or open plan-coverage gaps mark the task `blocked` and the run exits `blocked` (code 2), giving scripts a first-class ship gate. Delta re-reviews re-evaluate the approval against the post-fix state and preserve prior decision records for audit. ([#34](https://github.com/kcosr/task-runner/pull/34))
- `assignments/plan-feature/` now runs an ambiguity gate in `capture_feature` that enumerates contract dimensions by feature type (CLI, API, data/schema, UI, refactor, other) and requires the planner to mark the task `blocked` with up to three targeted questions if any dimension is unanswered — preventing guessed requirements from silently propagating into the plan. Adds a new `produce_contract_artifact` task that produces a concrete, greppable contract deliverable (command tables, signatures, schema diffs, etc.) which the implementer and reviewer both work from. Requires every code-bearing task in the generated plan to carry a `**Done when:**` block with test-backed completion criteria, verified by the reviewer's plan-coverage pass. The implementer template's `orient` now inlines `<<PLACEHOLDER_FEATURE_CONTRACT>>` so the reviewer sees the contract when reading the implementer's workspace, and the template's `callerInstructions` explain the reviewer-reads-the-implementer's-workspace wiring directly to reduce misconceptions. A new `commit` task finalizes git state at the end of every plan run.
- Built-in assignments now use semantic task ids (`orient`, `internal_review`, `approval`) instead of numeric prefixes. Array order remains the execution order, while ids stay stable when tasks are inserted or reordered. ([#11](https://github.com/kcosr/task-runner/pull/11))
- `assignments/plan-feature/` now runs a nested `plan-review` pass before handoff, passing both the generated draft and the planner workspace as review artifacts. The planner applies draft-review fixes until approval, then hands the caller the exact `task-runner init --agent implementer --assignment <draft> --var repo_path=...` command to run. Planner, template, reviewer, and onboarding guidance now also default to hot-cut designs: avoid fallback logic, heuristics, and backward-compatibility shims unless the caller explicitly asks for migration support. ([#11](https://github.com/kcosr/task-runner/pull/11))
- `assignments/plan-feature/` templates now create a review-candidate `commit` before `internal_review`, rename the final git-wrap-up step to `final_commit`, drop the scaffold guidance that implied a pre-edit baseline check gate, and teach task-workflow prompts to use quoted heredocs for multi-line CLI notes. ([#14](https://github.com/kcosr/task-runner/pull/14))
- `assignments/plan-feature/` now produces a human-facing markdown summary artifact alongside the approved draft. A new `produce_summary` task (inserted after `apply_review_fixes`) renders the planner's existing notes through a new `summary-template.md` into `${TASK_RUNNER_STATE_DIR}/drafts/<repo-name>/plan-<slug>-<shortid>.summary.md`, covering overview, motivation, scope, contract, schema, impact surface, higher-level steps, Mermaid diagrams where applicable, risks, test strategy, and open assumptions. The summary's Contract and Open Assumptions blocks must match the draft verbatim, and `handoff` now surfaces the summary path alongside the draft path so the caller can skim the plan before running init. ([#21](https://github.com/kcosr/task-runner/pull/21))
- Built-in planner/reviewer/orientation assignments and the local `plan-feature` skill now teach the run-id-plus-`brief` workflow instead of `pendingPrompt` scraping or workspace assignment-file handling. ([#34](https://github.com/kcosr/task-runner/pull/34))
- The web detail drawer now uses an inline confirm step for attachment deletion: the trash action expands into compact confirm/cancel icon buttons in the same row instead of deleting immediately. ([#38](https://github.com/kcosr/task-runner/pull/38))

### Fixed

- Fixed shared run capabilities and web primary-action gating so `ready`
  runs with unsatisfied dependencies no longer expose `Start` or
  `Resume` before their dependencies complete.
- Fixed the web attachment preview flow so full-row clicks in the detail drawer open previewable attachments and browser/mobile back returns to the selected run's Attachments view instead of closing the drawer. ([#61](https://github.com/kcosr/task-runner/pull/61))
- Fixed the web dashboard so disabling visible focus indicators suppresses fullscreen drawer `:focus-visible` outlines without removing the selected-card highlight. ([#54](https://github.com/kcosr/task-runner/pull/54))
- Fixed embedded and daemon-managed runs so thrown backend launch failures such as `ENOENT` still settle `run.json` to terminal `error` and write an attempt log, instead of leaving the run stuck in `running`. ([#48](https://github.com/kcosr/task-runner/pull/48))
- Fixed shared run detail and timeline lookup so bare run ids can resolve across repo buckets after v8 manifest migration, preventing dashboard/sidebar fetches from failing when the selected run lives outside the daemon's local repo bucket. ([#43](https://github.com/kcosr/task-runner/pull/43))
- Fixed the Attempts drawer to preserve loaded timeline history when a live run settles instead of flashing back through a loading state. ([#42](https://github.com/kcosr/task-runner/pull/42))
- Fixed `plan-feature` workflow drift around delayed implementer-run creation and execution handoff. The planner assignment now prepares `task-runner init --agent implementor --backend passive ...`, the planning handoff now treats `task-runner brief <new-run-id>` as the canonical execution surface for that passive implementer run, the generated implementation template now teaches the same brief-first passive workflow, and the local `plan-feature` skill was slimmed down to defer run-specific operational detail to the emitted assignment/brief.
- Fixed restored web drawer widths to clamp to the current viewport, kept the detail drawer open after archiving, restored the active mobile board column after closing the detail overlay, and blocked horizontal swipe gestures in the board and drawers from triggering browser navigation. ([#40](https://github.com/kcosr/task-runner/pull/40))
- Fixed Mermaid preview rendering to apply Mermaid's returned post-render bindings so interactive diagrams keep their event handlers. ([#40](https://github.com/kcosr/task-runner/pull/40))
- Fixed run detail projections to preserve the canonical repo bucket from the workspace path instead of re-probing `cwd`, preventing web dashboard cards from disappearing under repo filters after the detail drawer refreshed a selected run. ([#39](https://github.com/kcosr/task-runner/pull/39))
- Fixed non-passive terminal runs so any task left `in_progress` is persisted back to `pending` when the run stops, preventing stale running indicators in CLI/web until the next resume. ([#38](https://github.com/kcosr/task-runner/pull/38))
- Fixed daemon-managed run settlement so terminal detail projections clear live abort capability immediately after completion or abort, preventing stale `Abort` actions in the web drawer after a resume finishes. ([#36](https://github.com/kcosr/task-runner/pull/36))
- Fixed per-run timeline recovery to stop retrying forever on unrecoverable live-stream gaps, added explicit client coverage for timeline envelope application, and hardened timeline-history loading to ignore attempt log paths that escape the run workspace. ([#36](https://github.com/kcosr/task-runner/pull/36))
- Fixed attachment uploads when the selected filename contained non-ISO-8859-1 characters (emoji, diacritics, non-Latin scripts): the `x-task-runner-attachment-name` header is now percent-encoded by the web and CLI daemon clients and percent-decoded by the daemon HTTP route. ([#32](https://github.com/kcosr/task-runner/pull/32))
- Fixed the attachments tab in the web detail drawer showing the native file input's "Choose File / No file chosen" UI next to the Upload button — the `.sr-only` utility class was referenced but never defined, so the supposedly hidden input was fully visible. ([#32](https://github.com/kcosr/task-runner/pull/32))
- Fixed Ctrl+C handling for Codex-managed and daemon-target runs so
  task-runner only reports a clean interrupt after cancellation is
  actually confirmed. Unconfirmed interruption now fails loudly instead
  of pretending the remote run stopped. ([#29](https://github.com/kcosr/task-runner/pull/29))
- Fixed the web dashboard so running file-mode kanban cards now show the
  same live task progress as the detail drawer instead of stale persisted
  manifest counts. ([#27](https://github.com/kcosr/task-runner/pull/27))
- Fixed passive `effectiveStatus` so runs with completed work but no
  currently `in_progress` task still surface as running in CLI, daemon,
  and web status badges instead of falling back to pending.
  ([#27](https://github.com/kcosr/task-runner/pull/27))
- Fixed resume/run startup to reject already-running manifests, claim
  the `running` transition for reused workspaces under the shared
  task-state lock, and refresh the latest initialized task snapshot
  before execution so stale resume snapshots cannot clobber task state.
  ([#26](https://github.com/kcosr/task-runner/pull/26))
- Fixed Codex WebSocket transport handling so post-open protocol/socket
  errors now propagate through the transport close path and reject
  pending JSON-RPC requests instead of hanging callers like run-name
  propagation. ([#26](https://github.com/kcosr/task-runner/pull/26))
- Fixed daemon-hosted web asset resolution to use real filesystem paths,
  preventing packaged dashboard failures on Windows and URL-encoded
  install paths, and hardened frontend serving so directory requests
  like `/assets` no longer crash `task-runner serve`. ([#24](https://github.com/kcosr/task-runner/pull/24))
- Fixed the web dashboard to validate runtime config and daemon API
  payloads before using them, so malformed responses now fail cleanly
  instead of being trusted as typed contracts. ([#24](https://github.com/kcosr/task-runner/pull/24))
- Fixed the board jump strip to stay stable while switching selected
  runs, validated daemon SSE envelopes and stored board settings before
  trusting them, and stopped drawer resize cancels from committing
  stray widths. ([#24](https://github.com/kcosr/task-runner/pull/24))
- Fixed daemon-hosted frontend routes to return `405 Method Not Allowed`
  with an `Allow: GET, HEAD` header for unsupported methods. ([#24](https://github.com/kcosr/task-runner/pull/24))
- Fixed the web dashboard SSE client to treat malformed daemon event
  payloads as a stale-stream condition instead of crashing the live
  updates subscription. ([#24](https://github.com/kcosr/task-runner/pull/24))
- Fixed dashboard copy actions to fall back when the async Clipboard API
  is unavailable, and removed the duplicate header-level backend session
  copy control in the detail drawer. Copy confirmations now render as
  bottom toasts that auto-dismiss after a short delay. ([#24](https://github.com/kcosr/task-runner/pull/24))
- Fixed the web dashboard live-update loop to ignore noisy daemon
  transport events, revalidate state before clearing stale-stream
  warnings after reconnect, lock conflicting run actions while a
  mutation is in flight, and reset detail-drawer UI state when
  switching between runs. ([#24](https://github.com/kcosr/task-runner/pull/24))
- Fixed daemon-hosted SSE subscriptions to stay attached under normal
  HTTP backpressure, and hardened frontend asset serving so filesystem
  read/stat failures return controlled 500 responses instead of
  crashing the daemon. ([#24](https://github.com/kcosr/task-runner/pull/24))
- Fixed `assignments/plan-feature/` scaffold guidance to require implementers to verify they are in a non-`main` worktree, confirm local `main` is already in sync with `origin/main`, and sync the current worktree to local `main` before starting. Generated plans now block instead of proceeding when that preflight fails, and `assignments/plan-review/` flags drafts that omit it. ([#15](https://github.com/kcosr/task-runner/pull/15))
- Fixed workspace persistence to use atomic writes for manifests, attempt logs, and assignment files, and reject resume targets whose manifest paths do not match the workspace they were loaded from. ([#6](https://github.com/kcosr/task-runner/pull/6))
- Fixed Codex timeout/abort cleanup to wait for late-arriving turn ids and retry interruption, reducing the risk of orphaned remote turns. ([#6](https://github.com/kcosr/task-runner/pull/6))
- Fixed persisted backend attempt transcripts so streamed partial output is retained on completion instead of shrinking after timeline reloads, joining differing streamed/final text with a Markdown divider when needed. ([#38](https://github.com/kcosr/task-runner/pull/38))
- Fixed assignment/task mutation hardening around structural marker escaping, single-line task titles, terminal non-passive notes-only edits, and undeclared or mistyped runtime vars. ([#6](https://github.com/kcosr/task-runner/pull/6))
- Fixed subprocess handling to short-circuit pre-aborted launches before spawning child processes. ([#6](https://github.com/kcosr/task-runner/pull/6))

### Removed

- Removed the legacy bundled `basic`, `chat`, `codex-chat`, `codex-example`, `example`, and `passive-example` agents. ([#38](https://github.com/kcosr/task-runner/pull/38))
- Removed `--task-mode`, assignment-level `taskMode`, and all task-mode-specific runtime branching. ([#34](https://github.com/kcosr/task-runner/pull/34))
- Removed `pendingPrompt` from manifests and public status surfaces. ([#34](https://github.com/kcosr/task-runner/pull/34))
- Removed the generated workspace `assignment.md` task surface from new runs. ([#34](https://github.com/kcosr/task-runner/pull/34))

## [0.1.0] - 2026-04-11

### Breaking Changes

### Added

- Initial `task-runner` release: CLI support for `run`, `init`, `status`, and `task` workflows backed by manifest-canonical workspaces.
- Built-in Claude, Codex, and passive backend support, markdown assignment/task parsing, and resume-aware run persistence.
- Test coverage for lifecycle, resume, passive mode, validation, subprocess handling, and task mutation flows.
- Project documentation covering usage and runtime design.

### Changed

### Fixed

### Removed
