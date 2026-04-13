# Changelog

## [Unreleased]

### Breaking Changes

- Replaced the previous single-root runtime env var and cwd-local bare-name definition lookup with split XDG-style roots: `TASK_RUNNER_CONFIG_DIR` for named agent/assignment definitions and `TASK_RUNNER_STATE_DIR` for runtime state. Bare names now resolve only from the config root, and run workspaces now live under repo-scoped state buckets instead of `<cwd>/.task-runner/`. ([#8](https://github.com/kcosr/task-runner/pull/8))
- Direct file-path args are now recognized only when the argument contains `/` or starts with `./`; bare names no longer implicitly resolve from the repo checkout. ([#8](https://github.com/kcosr/task-runner/pull/8))
- Run workspace and draft buckets under `${TASK_RUNNER_STATE_DIR}/runs/` and `${TASK_RUNNER_STATE_DIR}/drafts/` now use the repo basename (for example `task-runner`) instead of a slugified absolute repo path. Existing runs remain on disk at their old locations, but short-id lookup now resolves against the new basename bucket unless you resume by explicit workspace path. ([#10](https://github.com/kcosr/task-runner/pull/10))
- Manifest schema version is now `3`. Existing `schemaVersion: 2` runs from the pre-reset-seed generation are no longer resumable; start a fresh run instead.
- `task-runner status --output-format json` now emits the shared `RunDetail` contract, and `--field` projects top-level `RunDetail` fields. The raw `finalTasks` status projection is removed; use `--field tasks` instead. ([#17](https://github.com/kcosr/task-runner/pull/17))
- `RunCapabilities` is now a hot-cut machine-facing contract with nested task mutation booleans (`taskMutation.canSetStatus`, `canEditNotes`, `canAdd`). The old flat `canAbort` / `canMutateTasks` fields are removed, and `list runs --output-format json` now carries `capabilities` on every `RunSummary` row. ([#19](https://github.com/kcosr/task-runner/pull/19))

### Added

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
- Added a transport-neutral `src/contracts/runs.ts` seam for shared run DTOs and pure mappers (`RunSummary`, `RunDetail`, `RunArchiveResult`, `RunCapabilities`) so later CLI/web/daemon surfaces can project from `RunManifest` without binding directly to raw manifest internals. ([#16](https://github.com/kcosr/task-runner/pull/16))
- Added `task-runner task list`, `task show`, and `task append-notes`, plus `task add --body`, for a fuller CLI task workflow surface. The new read commands return stable task snapshots in text or JSON, and append-notes uses deterministic single-newline joining.
- Added `task-runner run reset <run-id>` to restore a non-running run to its original initialized state, rewrite `run.json` and `assignment.md` from a persisted reset seed, clear prior attempt/session history, and remove stale `attempts/` artifacts.
- Added run-management commands: `task-runner list runs`, `task-runner run archive <id|path>`, and `task-runner run unarchive <id|path>`. Run discovery now scans current-generation manifests under `${TASK_RUNNER_STATE_DIR}/runs/`, `list runs` hides archived runs unless `--include-archived` is passed, and archive toggles are idempotent in text and JSON output. ([#15](https://github.com/kcosr/task-runner/pull/15))
- Added `--task-mode <file|cli>` as a fresh run / init override for assignment task workflow mode. The selected mode is now also lockable via `lockedFields: [taskMode]` and remains frozen on resume. ([#10](https://github.com/kcosr/task-runner/pull/10))
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
  control-plane routes from one loopback origin, and the repo now ships
  the canonical visual-contract mockup under
  `apps/web/mockups/run-dashboard.{html,css}`. ([#24](https://github.com/kcosr/task-runner/pull/24))

### Changed

- `task-runner serve` no longer restricts `--listen` / `TASK_RUNNER_LISTEN` to loopback hosts, and the web dashboard now keeps long kanban/task lists scrollable while the detail drawer sections start collapsed and can be expanded on demand. ([#24](https://github.com/kcosr/task-runner/pull/24))
- Refined the web dashboard interaction model: the detail drawer now closes on `Escape`, the board toolbar exposes archived / empty-column / failure-grouping toggles directly in the header, and mobile kanban scrolling snaps more reliably between columns. ([#24](https://github.com/kcosr/task-runner/pull/24))
- Added a board jump strip above the kanban that exposes only the currently rendered non-empty columns and scrolls them into view when the board overflows. ([#24](https://github.com/kcosr/task-runner/pull/24))
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
- Assignment config now supports `taskMode: file | cli` with default `file`. `taskMode=cli` switches prompts to a run-id-and-command workflow, treats `run.json.finalTasks` as canonical live task state, and renders `assignment.md` as an audit projection instead of a live input surface.
- Running non-passive CLI-mode runs now allow `task set` and `task append-notes` during execution through a shared per-run persistence lock. `task add` remains rejected while a run is in flight.
- `agents/code-reviewer/` flipped from `codex` / `gpt-5.3-codex` to `claude` / `claude-opus-4-6`. The role body and severity format are unchanged; only the backend and model. Plan-feature-driven reviews now run on opus without needing template-level `--backend` / `--model` overrides. Callers that want the old configuration can still override via `--backend codex --model gpt-5.3-codex` at run time.
- Shared workspace task-state loading and persistence between the run loop and CLI task commands so assignment overlays, manifest snapshots, and canonical writes follow one code path. ([#6](https://github.com/kcosr/task-runner/pull/6))
- Updated the standard verification workflow so `npm run check` runs build, lint, and test coverage together. ([#6](https://github.com/kcosr/task-runner/pull/6))
- `assignments/code-review/` now accepts an optional `implementation_plan` var pointing at a task-runner workspace `assignment.md`. When set, a new `plan_coverage` task verifies that every task in the referenced plan actually shipped in the diff — flagging silent deferrals and dropped review fixes at HIGH/CRITICAL severity. The synthesis task is renumbered to `synthesis` and folds plan-coverage findings into its ranked list. Reviews launched without the var skip the plan-coverage pass cleanly.
- `assignments/code-review/` now ends with an explicit `approval` ship / no-ship decision task. The task lives separately from the synthesis so the reviewer's *decision* ("I approve this work") is distinct from the synthesis *deliverable* ("here is the ranked findings list"). Review runs exit `success` (code 0) only when the reviewer approves; unresolved HIGH/CRITICAL findings or open plan-coverage gaps mark the task `blocked` and the run exits `blocked` (code 2), giving scripts a first-class ship gate. Delta re-reviews re-evaluate the approval against the post-fix state and preserve prior decision records for audit.
- `assignments/plan-feature/` now runs an ambiguity gate in `capture_feature` that enumerates contract dimensions by feature type (CLI, API, data/schema, UI, refactor, other) and requires the planner to mark the task `blocked` with up to three targeted questions if any dimension is unanswered — preventing guessed requirements from silently propagating into the plan. Adds a new `produce_contract_artifact` task that produces a concrete, greppable contract deliverable (command tables, signatures, schema diffs, etc.) which the implementer and reviewer both work from. Requires every code-bearing task in the generated plan to carry a `**Done when:**` block with test-backed completion criteria, verified by the reviewer's plan-coverage pass. The implementer template's `orient` now inlines `<<PLACEHOLDER_FEATURE_CONTRACT>>` so the reviewer sees the contract when reading the implementer's workspace, and the template's `callerInstructions` explain the reviewer-reads-the-implementer's-workspace wiring directly to reduce misconceptions. A new `commit` task finalizes git state at the end of every plan run.
- Built-in assignments now use semantic task ids (`orient`, `internal_review`, `approval`) instead of numeric prefixes. Array order remains the execution order, while ids stay stable when tasks are inserted or reordered. ([#11](https://github.com/kcosr/task-runner/pull/11))
- `assignments/plan-feature/` now runs a nested `plan-review` pass before handoff, passing both the generated draft and the planner workspace as review artifacts. The planner applies draft-review fixes until approval, then hands the caller the exact `task-runner init --agent implementer --assignment <draft> --var repo_path=...` command to run. Planner, template, reviewer, and onboarding guidance now also default to hot-cut designs: avoid fallback logic, heuristics, and backward-compatibility shims unless the caller explicitly asks for migration support. ([#11](https://github.com/kcosr/task-runner/pull/11))
- `assignments/plan-feature/` templates now create a review-candidate `commit` before `internal_review`, rename the final git-wrap-up step to `final_commit`, drop the scaffold guidance that implied a pre-edit baseline check gate, and teach task-workflow prompts to use quoted heredocs for multi-line CLI notes. ([#14](https://github.com/kcosr/task-runner/pull/14))
- `assignments/plan-feature/` now produces a human-facing markdown summary artifact alongside the approved draft. A new `produce_summary` task (inserted after `apply_review_fixes`) renders the planner's existing notes through a new `summary-template.md` into `${TASK_RUNNER_STATE_DIR}/drafts/<repo-name>/plan-<slug>-<shortid>.summary.md`, covering overview, motivation, scope, contract, schema, impact surface, higher-level steps, Mermaid diagrams where applicable, risks, test strategy, and open assumptions. The summary's Contract and Open Assumptions blocks must match the draft verbatim, and `handoff` now surfaces the summary path alongside the draft path so the caller can skim the plan before running init. ([#21](https://github.com/kcosr/task-runner/pull/21))
- Built-in planner/reviewer/orientation assignments now opt into `taskMode: cli` by default for `plan-feature`, `plan-review`, `code-review`, `doc-review`, and `familiarize`. ([#21](https://github.com/kcosr/task-runner/pull/21))

### Fixed

- Fixed daemon-hosted web asset resolution to use real filesystem paths,
  preventing packaged dashboard failures on Windows and URL-encoded
  install paths, and hardened frontend serving so directory requests
  like `/assets` no longer crash `task-runner serve`. ([#24](https://github.com/kcosr/task-runner/pull/24))
- Fixed the web dashboard to validate runtime config and daemon API
  payloads before using them, so malformed responses now fail cleanly
  instead of being trusted as typed contracts. ([#24](https://github.com/kcosr/task-runner/pull/24))
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
- Fixed assignment/task mutation hardening around structural marker escaping, single-line task titles, terminal non-passive notes-only edits, and undeclared or mistyped runtime vars. ([#6](https://github.com/kcosr/task-runner/pull/6))
- Fixed subprocess handling to short-circuit pre-aborted launches before spawning child processes. ([#6](https://github.com/kcosr/task-runner/pull/6))

### Removed

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
