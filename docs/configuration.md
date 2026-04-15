# Configuration

## Environment variables

| Var | Purpose |
|---|---|
| `TASK_RUNNER_CONFIG_DIR` | Root for named definitions. Agents live under `agents/<name>/agent.md`; assignments live under `assignments/<name>/assignment.md`. Defaults to `${XDG_CONFIG_HOME}/task-runner` or `~/.config/task-runner`. |
| `TASK_RUNNER_STATE_DIR` | Root for runtime state. Runs live under `runs/<repo-name>/<run-id>/`; drafts live under `drafts/<repo-name>/`. Defaults to `${XDG_STATE_HOME}/task-runner` or `~/.local/state/task-runner`. |
| `TASK_RUNNER_CMD` | Override the CLI command name used in user-facing messages, prompts, and assignment templates. Defaults to the `task-runner` binary found on `PATH`, then bare `task-runner`. |
| `TASK_RUNNER_CONNECT` | Opt commands into daemon mode by pointing them at a local daemon WebSocket URL. Default: unset (embedded mode). |
| `TASK_RUNNER_LISTEN` | Default WebSocket listen URL for `task-runner serve`. Falls back to `ws://127.0.0.1:4773/`. The same listener also serves HTTP/SSE on the derived `http://` origin. |
| `TASK_RUNNER_CLAUDE_BIN` | Path to the `claude` binary. Defaults to `claude` on `PATH`. |
| `TASK_RUNNER_CURSOR_BIN` | Path to the `cursor-agent` binary. Defaults to `cursor-agent` on `PATH`. |
| `TASK_RUNNER_CODEX_BIN` | Path to the `codex` binary for stdio mode. Defaults to `codex` on `PATH`. |
| `TASK_RUNNER_CODEX_WS_URL` | If set, the codex backend connects to this WebSocket URL instead of spawning a stdio subprocess. |
| `TASK_RUNNER_CALL_DEPTH` | Internal: current recursion depth. Set automatically when one task-runner spawns another via the backend env. |
| `TASK_RUNNER_MAX_CALL_DEPTH` | Hard cap on nested task-runner invocations. Default `1` — a top-level run can spawn one nested run, no deeper. Override with `TASK_RUNNER_MAX_CALL_DEPTH=N`. |

## State directory layout

```
${TASK_RUNNER_STATE_DIR}/
├── runs/
│   └── <repo-name>/
│       └── <run-id>/
│           ├── run.json
│           ├── assignment.md
│           ├── attempts/NN.json
│           └── attachments/<attachment-id>/<sanitized-name>
└── drafts/
    └── <repo-name>/
```

Run discovery scans `runs/*/*/run.json` and returns current-generation
manifests whose recorded workspace paths still match the containing
directory. Drafts are used by `plan-feature`-style meta-assignments to
stage generated assignment files.

## Config directory layout

```
${TASK_RUNNER_CONFIG_DIR}/
├── agents/
│   └── <name>/agent.md
└── assignments/
    └── <name>/assignment.md
```

Bare names on `--agent` / `--assignment` are looked up here. Bare names
do **not** fall back to `./agents/` or `./assignments/` in the current
working directory; definitions in a repo checkout should be referenced
by path unless you export `TASK_RUNNER_CONFIG_DIR=$PWD`.

## Recursion guard

A hard cap (default `1`) on nested `task-runner run` invocations is
propagated through the environment, so an orchestrator agent can't
accidentally fork-bomb itself. If the cap is hit, the runner exits
with a clear error telling you to raise `TASK_RUNNER_MAX_CALL_DEPTH`
if the nesting is intentional.

The `plan-feature` assignment nests `plan-review`, and the
implementation plan it generates nests `code-review`, so both of those
flows expect `TASK_RUNNER_MAX_CALL_DEPTH=2`.
