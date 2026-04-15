# Backends

task-runner ships with four backends. Each is an adapter over a
different agent runtime; the run loop only sees the common backend
interface (`invoke`, `validateSessionId`, interrupt semantics).

| Backend | Wraps | Session id source | Bootstrap import |
|---|---|---|---|
| [`claude`](#claude) | `claude --print --output-format stream-json` | Claude system init event | ✅ (JSONL file stat) |
| [`codex`](#codex) | codex JSON-RPC app-server (stdio or WS) | Codex thread id | ✅ (`thread/read` + cwd match) |
| [`cursor`](#cursor) | `cursor-agent -p --output-format stream-json` | First non-empty `session_id` output | ❌ (ids not self-validating) |
| [`passive`](#passive) | nothing — null object | N/A | N/A |

## Claude

Wraps the `claude` CLI in `--print --output-format stream-json` mode.
Streams partial assistant text to stdout, captures the session id from
the system init event, persists it for resume, and uses `--resume <id>`
to continue.

Set `TASK_RUNNER_CLAUDE_BIN` to use a custom binary.

## Codex

Speaks the codex JSON-RPC app-server protocol in managed mode. Default
transport is stdio (spawns the `codex` CLI as a subprocess); set
`TASK_RUNNER_CODEX_WS_URL=ws://host:port` to connect to a running
app-server over WebSocket instead.

Codex over WebSocket has a useful property: multiple clients can attach
to the same thread, so you can connect with the codex CLI in another
terminal and watch or even interact while task-runner is driving the
agent.

If you cancel the turn from another client mid-attempt, task-runner
notices the external interrupt and stops cleanly with status `aborted`
instead of retrying — see [resume.md#external-interrupt-codex-only](resume.md#external-interrupt-codex-only).

The runner sends `thread/start` (or `thread/resume`) at session start,
optionally `thread/name/set` if the run has a persisted `name`, then
`turn/start` for each attempt and `turn/interrupt` on timeout, abort,
or external Ctrl+C.

## Cursor

Wraps `cursor-agent` in public headless print mode:

```bash
cursor-agent -p --trust --output-format stream-json --stream-partial-output \
  --workspace <cwd> [--model <id>] [--force] [--resume <session-id>] "<prompt>"
```

- Streams only `partial_output` deltas to the terminal as
  `agent_message_delta`.
- Captures the first non-empty `session_id` from any output record and
  persists it for normal task-runner resume.
- Uses the final `result.result` string as the canonical attempt
  transcript; successful runs without that field are treated as backend
  errors instead of guessing from partial output.
- Strips any provider prefix from `--model` before forwarding it
  (for example `provider/foo` → `foo`).
- Accepts task-runner's `--effort` surface but ignores it for Cursor
  v1 because the public CLI does not expose an effort flag.
- Maps `--unrestricted` to `cursor-agent --force`.
- Does **not** support bootstrap `--backend-session-id` import; only
  task-runner-created Cursor runs with a captured session id can be
  resumed.

Set `TASK_RUNNER_CURSOR_BIN` to use a custom Cursor binary.

## Passive

A null-object backend for runs that task-runner will never execute.
Passive agents are driven externally — a script or out-of-process agent
calls `task-runner init` to create the run, reads the task list and
role instructions via `status`, and reports progress back through
`task set` / `task add`. task-runner acts purely as a structured
checklist service, with no LLM involvement.

Declare a passive agent like any other:

```yaml
---
schemaVersion: 1
name: my-passive-agent
backend: passive
lockedFields:
  - backend
---
Role instructions for the external driver (a human reader or the
agent that will run the task list).
```

### Passive-specific behavior

- **`task-runner run` is rejected** on passive agents with a clear
  pointer to `init` and `task set`. Applies to fresh runs and
  `--resume-run` alike.
- **`task-runner run reset` is allowed** on passive runs. It restores
  the original initialized task set, rewrites `assignment.md`, keeps
  the run externally driven, and clears prior task-history-derived
  terminal state back to `initialized`.
- **`task-runner init` prints the full bootstrap** — the composed
  agent instructions + assignment context + CLI workflow reminder —
  to **stdout**, so you can pipe it: `task-runner init ...
  > /tmp/brief.txt`. Brief progress lines still go to stderr.
- **`task set` / `task add` auto-finalize** the run. After every
  mutation, the manifest status is re-derived from the task map:
  - any `pending` or `in_progress` task → `initialized`
  - all terminal, at least one `blocked` → `blocked` (exit code 2)
  - all `completed` → `success` (exit code 0)

  Self-healing: reopening a completed task or adding a new one on a
  `success` run flips the status back to `initialized`.
- **Locking `backend`** in the agent's `lockedFields` is strongly
  recommended. It prevents callers from overriding the backend at
  `init` time (e.g. `--backend claude`) and turning a passive agent
  into an executable one. The bundled `agents/passive-example/` does
  this.
- **Hidden status fields**: `task-runner status` omits the `Attempts:`
  and `Sessions:` lines for passive runs since they're always zero.
- **Re-orient an external driver**: the composed bootstrap is
  persisted in `manifest.pendingPrompt` and never consumed, so an
  agent can refetch it any time with:

  ```bash
  task-runner status <run-id> --output-format json --field pendingPrompt
  ```

### Sidecar driver loop

```bash
# 1. Prepare the run (prints the full bootstrap to stdout)
task-runner init \
  --agent ./agents/passive-example/agent.md \
  --assignment ./assignments/repo-orientation/assignment.md \
  --var repo_path=. 2>/dev/null > /tmp/brief.txt

# 2. Parse out the run id from the earlier stderr, or from JSON mode:
RUN=$(task-runner init \
  --agent ./agents/passive-example/agent.md \
  --assignment ./assignments/repo-orientation/assignment.md \
  --var repo_path=. --output-format json | jq -r .runId)

# 3. Walk the task list (agent-specific logic omitted)
task-runner task set $RUN read_conventions --status in_progress
# ...do the work...
task-runner task set $RUN read_conventions --status completed --notes "..."

# 4. When every task is terminal, the run auto-finalizes.
task-runner status $RUN | grep "Status: success"
```

See [tasks.md#sidecar-pattern](tasks.md#sidecar-pattern) for the
generic (non-passive) sidecar pattern that also works with claude or
codex backends.
