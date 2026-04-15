# Resuming, aborting, importing

## Resume

```bash
task-runner run --resume-run <id>
task-runner run --resume-run <id> "follow-up message"
```

Picks up the prior run from its workspace, normalizes any non-completed
tasks back to `pending` (preserving their notes), and starts a new
session. Under the manifest-canonical design, **the agent config is
reconstructed from the frozen manifest** — the source `agent.md` is
not re-read.

The first attempt of the new session sends *only* the follow-up message
when one is provided. If you resume without a message and the run still
has incomplete tasks, task-runner synthesizes `Continue working through
the remaining task list items.` instead. The role instructions and
task workflow aren't re-rendered, since the backend already has them
cached in the session it's resuming. If no incomplete tasks remain,
resume still requires a follow-up message or `--add-task`.

`--add-task "<title>"` works alongside (or instead of) a follow-up
message; the runner prepends a short reminder telling the agent to
re-read the workspace `assignment.md`.

## What's overridable on resume

The manifest carries the frozen agent state, so most CLI overrides
either don't apply or would actively break the captured backend
session. The rules:

- **Rejected on any resume** (regular *or* execute-after-init):
  `--agent`, `--assignment`, `--backend`, `--backend-session-id`,
  `--cwd` (sessions are cwd-bound), `--var` (vars are frozen into
  the manifest at first write).
- **Allowed on regular resume** (still vetted against the run's
  frozen `lockedFields`): `--model`, `--effort`, `--timeout-sec`,
  `--max-retries`, `--unrestricted`, `--add-task`, positional
  `[message]`.
- **Execute-after-init** (resuming a run whose prior status was
  `initialized`): **no overrides at all**. Init deliberately froze
  every resolvable field; the only valid call is
  `task-runner run --resume-run <id>`. If you need different values,
  create a fresh run.

The frozen values live under `manifest.agent.instructions`,
`manifest.lockedFields`, `manifest.timeoutSec`, and the usual
top-level fields — you can read the full state with
`task-runner status <id> --output-format json`.

## Abort (Ctrl+C)

The first Ctrl+C requests backend interruption. For Claude that still
means a normal subprocess SIGINT. For Codex, `task-runner` now treats
Ctrl+C as a confirmed-interrupt handshake:

- If Codex confirms interruption, the run persists
  `status = "aborted"` and exits 130.
- If Codex never yields a turn id, `turn/interrupt` fails, or the turn
  finishes without an interrupted terminal event, the run exits 1 with
  a diagnostic explaining that interruption was not confirmed and the
  remote session may still be active.

The second Ctrl+C force-exits if the backend doesn't respond. Confirmed
aborted runs are fully resumable like any other terminal state.

## External interrupt (codex only)

If you've attached another client to the same codex thread and cancel
the turn from there, codex emits `turn/completed { status:
"interrupted" }` to all attached clients, including task-runner.

The runner detects this case (interrupted with no internal cause) and
stops with status `aborted` instead of treating it as a failure to
retry. You can take over the conversation by hand and then resume
task-runner whenever you're ready.

## Import an existing backend session

```bash
task-runner init --agent <name> [--assignment <name>] \
  --backend-session-id <existing-session-or-thread-id> \
  --cwd /the/cwd/that/session/was/created/under

task-runner run --resume-run <id>
```

Validates the id read-only before any workspace creation when the
selected backend supports bootstrap import:

- **claude**: stats the session JSONL file under
  `~/.claude/projects/<encoded-cwd>/`.
- **codex**: opens the JSON-RPC transport, calls `thread/read`, and
  enforces that the thread's recorded `cwd` matches the cwd you're
  about to operate under. Mismatched cwd is a hard error — codex itself
  allows it but it almost always means the user is confused.
- **cursor**: unsupported. Public Cursor resume ids are not safely
  self-validating, so `--backend-session-id` fails before workspace
  creation with a validation/config error.

If validation passes, the id is persisted in the manifest and used as
the resume target on the very first invocation. From then on, the run
flows through the existing resume path.

`--backend-session-id` also works on `task-runner run` directly
(without going through `init`) for one-shot import on supported
backends. It is forbidden with `--resume-run` (the resume target
already carries one).

## Archiving

Archive toggles are orthogonal to `status`: they keep the run's current
lifecycle state but add or clear `manifest.archivedAt`. By default
`task-runner list runs` hides archived runs, and
`task-runner run --resume-run <id>` rejects them until unarchived.

See [cli.md](cli.md) for `run archive` / `run unarchive` / `run reset`
syntax.
