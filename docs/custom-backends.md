# Custom Backends

A custom backend lets you run the worker through a runtime that is not
one of the built-ins (`claude`, `codex`, `cursor`, `opencode`, `pi`). It
is trusted local code — a module you author and place under the config
root — that owns its own invocation, config resolution, session
handling, and optional session-history import.

This page is the authoring reference. For selecting and configuring the
built-in backends, see [backends.md](backends.md).

## Module location

Custom backend modules live under the config root:

```text
${AGENT_RUNNER_CONFIG_DIR}/backends/<backend-name>/backend.ts
${AGENT_RUNNER_CONFIG_DIR}/backends/<backend-name>/backend.mts
${AGENT_RUNNER_CONFIG_DIR}/backends/<backend-name>/backend.js
${AGENT_RUNNER_CONFIG_DIR}/backends/<backend-name>/backend.mjs
```

When multiple files exist, agent-runner uses that order. Missing
`backends/` means no custom backends; a named backend directory without a
candidate module is a config error.

## The backend contract

The module must default-export a backend object with:

- `id` equal to the backend directory name
- `invoke(ctx)` as a function
- optional `resolveConfig(ctx)` as a function
- optional `validateSessionId(ctx)` as a function
- optional `resolveSessionHistorySource(ctx)` as a function
- optional `readSessionHistory(ctx)` as a function
- optional `agentRunnerPromptMatchesSyncedTurn(ctx)` as a function
- optional `agentRunnerAttemptTimingMatchesSyncedTurn(ctx)` as a function
- optional `supportsBootstrapSessionImport` as a boolean
- optional `launcherApplies(ctx)` as a function
- optional `launcherMode` as `"applies"` or `"direct"`
- optional `renameSession(ctx)` as a function

Built-in names (`claude`, `codex`, `cursor`, `opencode`, `pi`,
`passive`) are reserved. Import and validation errors include the backend
name and resolved module path.

Built-ins and custom backends use the same `Backend` contract. The run
loop resolves a backend object, passes the same invoke context shape, and
persists the same invoke result fields for both built-in and custom
backends. A backend can stream visible assistant text with
`ctx.emit({ type: "agent_message_delta", text })`, capture a resumable
backend session by returning `sessionId`, and receive that id on the next
invoke as `ctx.resumeSessionId`.

Minimal direct SDK-style backend:

```js
const backend = {
  id: "my-backend",
  launcherMode: "direct",
  supportsBootstrapSessionImport: false,

  resolveConfig(ctx) {
    return {
      ...recordOrEmpty(ctx.authoredConfig),
      ...recordOrEmpty(ctx.overrideConfig),
    };
  },

  async invoke(ctx) {
    // Apply ctx.cwd yourself when calling an SDK, RPC client, or subprocess.
    const text = await callMyModel({
      prompt: ctx.prompt,
      cwd: ctx.cwd,
      model: ctx.model,
      effort: ctx.effort,
      config: ctx.backendConfig,
      resumeSessionId: ctx.resumeSessionId,
      signal: ctx.abortSignal,
    });

    ctx.emit?.({ type: "agent_message_delta", text });

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: ctx.abortSignal?.aborted === true,
      sessionId: null,
      transcript: text,
      rawStdout: text,
      rawStderr: "",
    };
  },
};

function recordOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export default backend;
```

## Resumable sessions

For resumable backends, return a stable non-null `sessionId` from
`invoke()`. Task-runner persists it as the run's backend session id and
passes it back as `ctx.resumeSessionId` on resume. Implement
`validateSessionId(ctx)` when the backend can cheaply verify imported
`--backend-session-id` values before the first invocation. Set
`supportsBootstrapSessionImport: false` when public resume ids are not
self-validating enough to import safely.

## Session history import and sync

Backends can opt into backend-owned session history import by implementing
both `resolveSessionHistorySource(ctx)` and `readSessionHistory(ctx)`.
Task-runner calls them for `--backend-session-id` bootstrap import and
before `agent-runner run --resume-run <id>` allocates a new session or
attempt.

Set `AGENT_RUNNER_BACKEND_SESSION_SYNC=false` (also accepts `0`, `no`, or
`off`) to disable backend-owned session history import/sync for the
current process, including daemon subscribed-run polling.

`resolveSessionHistorySource(ctx)` receives `sessionId`, `cwd`, `env`,
resolved backend config/args, and the previous source when one exists. It
returns either:

- `{ available: false, reason }` when no durable history source can be
  read for that session
- `{ available: true, source }` with a persistable source descriptor

Most built-ins use `file` sources for local history files. Custom backends
can return `{ kind: "custom", label, changeToken }`; `changeToken` must be
JSON-persistable and should change whenever `readSessionHistory` needs to
run again. `label` is a human-readable source name for diagnostics and
audit context. For `file` sources, agent-runner stores path, size, and
mtime as the source change token. Cursor uses a custom SQLite source token
based on its session root pointer instead of filesystem mtime.

`readSessionHistory(ctx)` receives the resolved source, the previous
cursor when one exists, and a mode of `"bootstrap"` or `"sync"`. It
returns:

- the current `source`
- a JSON-persistable `cursor`
- ordered turns with `backendTurnId`, `status`, timestamps, user text,
  and assistant text

Complete turns are imported as canonical session and attempt records with
`backend_session` provenance. Open turns are tracked in
`manifest.backendSessionSync.openTurnIds` but are not persisted as
attempts until a later sync reports them complete. If a backend returns a
non-persistable cursor, source change token, or malformed turn,
agent-runner aborts the sync and leaves the prior manifest unchanged.

When sync sees a backend history turn that may correspond to an
already-recorded agent-runner attempt, exact prompt equality is matched
first. Backends with storage quirks can additionally implement
`agentRunnerPromptMatchesSyncedTurn({ prompt, turn })` so sync can upgrade
the existing attempt instead of importing a duplicate turn. Backends with
history timestamps that do not overlap agent-runner attempt timestamps can
implement `agentRunnerAttemptTimingMatchesSyncedTurn(ctx)` to own that
matching policy.

## Trusted code and dependencies

Custom backend code is trusted local code. It is loaded into the
agent-runner process without sandboxing and cached for the process
lifetime; daemon changes require a daemon restart, including the first
creation of the `backends/` root after daemon startup. Dependencies
resolve normally from the backend file location. Install them under the
config directory, for example:

```bash
cd ~/.config/agent-runner
npm install <package>
```

## cwd handling

Native backend implementations receive the resolved run cwd as `ctx.cwd`.
They are responsible for applying that cwd to any subprocess, RPC client,
or SDK they invoke.

## Reference implementations

Use built-ins as reference implementations, but do not treat their helper
imports as public API for custom modules:

- [`passive`](../packages/core/src/backends/passive.ts) is the smallest
  backend result shape.
- [`claude`](../packages/core/src/backends/claude.ts) and
  [`cursor`](../packages/core/src/backends/cursor.ts) show subprocess
  backend patterns.
- [`codex`](../packages/core/src/backends/codex.ts) shows backend-owned
  `resolveConfig()` and config validation.
- [`opencode`](../packages/core/src/backends/opencode.ts) shows a
  subprocess JSON-event backend with SQLite-backed session history.
- [`pi`](../packages/core/src/backends/pi.ts) shows backend session
  validation, history import/sync, and resume id handling.

A few built-in backends use optional backend hooks: `codex` owns
transport-specific launcher applicability and thread rename propagation,
`pi` owns session rename propagation, `cursor` owns its sync timestamp
matching policy, and `opencode` owns its stored-prompt equivalence rule.
`passive` still has externally driven run behavior in core because it is
an agent-runner lifecycle mode, not an invokable subprocess backend.
