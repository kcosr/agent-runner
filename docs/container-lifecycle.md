# Container Lifecycle Design

This document describes first-class container lifecycle management for
task-runner. It is based on the current manifest-canonical run model, the
existing launcher and backend contracts, and the container lifecycle notes in
`/home/kevin/assistant/task-runner-container-lifecycle-design-notes.md`.

## Summary

Container support is a task-runner execution-environment layer below
backend invocation. It does not replace backends, and it is not hidden
inside launcher wrappers.

The implementation supports two modes:

- `managed`: task-runner creates, starts, validates, uses, audits, and cleans up
  a run- or run-group-scoped container.
- `existing`: task-runner attaches to an already-running external container,
  validates it, executes backend subprocesses inside it, audits use, and never
  stops or removes it.

This keeps the backend contract focused on native backend semantics while giving
task-runner a durable place to own containment, mounts, validation, cleanup, and
status.

## Scope Fit

This feature is in scope because it strengthens run execution, lifecycle,
orchestration, audit, and external-driver ergonomics. It does not turn
task-runner into an interactive coding environment, and it does not reimplement
backend-native tools, skills, MCP servers, or model/tool guardrails.

Container support should be documented as execution containment, not as a
security guarantee. Read-write bind mounts, backend auth mounts, host networking,
and externally owned containers all grant meaningful authority.

## Why Not Use The OpenAI Agents SDK Directly

The OpenAI Agents SDK Docker sandbox is a useful reference model for long-lived
idle containers, `docker exec`, workspace materialization, bind mounts, cleanup,
resume, and Docker/Podman edge cases. It is not the right primary abstraction
for task-runner because task-runner invokes executable backends and transports:
`claude`, `codex`, `cursor-agent`, `opencode`, `pi`, passive/custom backends,
and Codex app-server modes.

Those backends own session handles, auth, local state, tool calls, permissions,
and resume semantics. The SDK owns a different layer: TypeScript agent objects,
tool routing, guardrails, approvals, and sandbox sessions. A future
`openai-agents` backend could use the SDK directly, but general container
support for subprocess backends should be task-runner-native.

## Existing Mechanisms

### Launchers

Launchers currently provide a subprocess prefix and are frozen into the manifest
at fresh-run/init time. They can wrap subprocess-backed backends, and the README
already describes using a launcher wrapper for persistent-container workflows.

Launchers should remain as generic subprocess prefixes. First-class container
support should replace launcher-wrapper container conventions when task-runner
needs to validate, audit, reuse, or clean up containers.

Launchers still compose with non-container use cases such as SSH wrappers. For
containerized runs, the execution environment should produce the effective
command plan instead of requiring users to encode container lifecycle in
`launcher.command` and `launcher.args`.

### Backends

The existing `BackendInvokeContext` already carries the fields a container
environment must transform:

- `cwd`
- `env`
- `launcher`
- `resolvedBackendArgs`
- `abortSignal`
- backend config and resume session id

The backend interface should remain mostly intact. The environment layer should
wrap or adapt invocation for supported subprocess backends before
`backend.invoke()` spawns the actual process.

### Manifest And Reset Seed

The current manifest already freezes execution fields such as `cwd`,
`backendConfig`, `resolvedBackendArgs`, `launcher`, and `execution`. Container
configuration and resolved runtime identity should follow the same pattern:
freeze the selected environment at first write and store reset-safe fields in
`resetSeed`.

Reset should not re-read current environment definitions. It should restore the
frozen authored/resolved environment config and then revalidate or recreate
runtime state according to ownership mode.

### Daemon Forwarding

Workers use the task CLI, not workspace files. In containerized active runs, the
worker should not need a read-write mount of `TASK_RUNNER_STATE_DIR` just to run
`task-runner task set`.

When a daemon is available, task-runner should inject the existing connected CLI
contract into container exec environments so task mutations route through the
daemon. The exact variables should match the daemon connection contract already
used by the CLI, plus the existing per-run overlay:

- `TASK_RUNNER_CONNECT`
- `TASK_RUNNER_DAEMON_TOKEN` when daemon auth is enabled
- `TASK_RUNNER_RUN_ID`
- `TASK_RUNNER_RUN_GROUP_ID`
- `TASK_RUNNER_CWD`

Backend auth and session directories are separate from task-runner state. They
may still need explicit read-write mounts.

## Proposed Model

Add an execution environment layer:

```text
run-loop
  -> resolve backend
  -> resolve execution environment
  -> prepare environment for session/attempt
  -> invoke backend with transformed cwd/env/launcher
  -> finalize attempt/session/run environment state
  -> persist manifest and audit events
```

Conceptually, the environment receives the same durable run identity as the
backend invocation and may return:

- effective `cwd` inside the environment
- effective `env` overlay
- effective launcher/command wrapper
- persisted runtime state such as container id
- cleanup actions to run on terminal, reset, delete, or manual cleanup

The run loop remains the owner of task completion, retries, sessions, hooks,
schedule handling, and audit publication.

## Code Integration Points

The implementation should touch these existing boundaries:

- `packages/core/src/core/config/schema.ts`: add environment references to the
  agent schema and add the environment definition schema.
- `packages/core/src/config/runtime-paths.ts`: add
  `resolveEnvironmentsRoot()`.
- `packages/core/src/config/loader.ts`: load named environment files from
  `${TASK_RUNNER_CONFIG_DIR}/environments`.
- `packages/core/src/core/run/run-loop.ts`: resolve and freeze the environment
  after backend/cwd resolution, prepare the environment before active attempts,
  and run cleanup during terminal/reset paths.
- `packages/core/src/core/commands/service.ts`: run owned-environment cleanup
  before archived run deletion and expose manual validate/cleanup commands.
- `packages/core/src/core/run/manifest.ts`: persist the frozen environment and
  runtime state on `RunManifest` and `RunResetSeed`.
- `packages/core/src/core/run/run-events.ts`: add audit event types and append
  helpers for validation, exec, and cleanup.
- `packages/core/src/core/backends/types.ts`: expose a narrow subprocess
  execution hook to built-in/custom subprocess backends.
- `packages/core/src/util/spawn.ts`: keep host process spawning behavior in one
  place and route supported subprocess executions through the prepared
  environment.
- `packages/core/src/contracts/`: project environment state, warnings, and
  capabilities to CLI/daemon/web clients.

Do not overload the existing `manifest.execution` field. It records embedded vs
daemon controller identity. The container state is a separate execution
environment.

## Invocation Boundary

The container layer should not persist a synthetic launcher in
`manifest.launcher`. Launchers are a user-authored subprocess prefix and already
have their own freeze/reset semantics. Environment execution should be stored in
`manifest.executionEnvironment`.

The preferred implementation is to introduce a small backend process executor
instead of making each backend know Docker/Podman details. Built-in subprocess
backends would call the executor when they need to run a process. The host
executor delegates to the existing `runProcess()` / `buildSpawnCommand()` path;
the container executor builds `docker exec` / `podman exec`, injects env, sets
container cwd, and preserves timeout/abort behavior.

Initial compatibility rule: container execution and non-direct launchers should
be mutually exclusive. That avoids ambiguous composition such as SSH launcher
then container exec versus container exec then launcher. Existing launcher-based
container wrappers continue to work unchanged as the legacy/manual path. A later
remote-engine design can add explicit composition order if there is a concrete
need.

## Authored Configuration

Add named environment definitions under the config root:

```text
${TASK_RUNNER_CONFIG_DIR}/environments/<name>.yaml
```

Agents may reference an environment because agents already own runtime/backend
selection:

```yaml
---
schemaVersion: 1
name: implementer-container
backend: claude
executionEnvironment: agent-dev
---
Operate in the configured container.
```

Assignments should not select a backend execution environment initially. They
own work, vars, tasks, schedule, hooks, and cwd. Keeping environment selection on
agents preserves the current split between runtime and work definition. A later
CLI override can allow named-only environment selection for fresh-run/init, with
the same lock/freeze behavior as launchers.

Suggested named environment shape:

```yaml
schemaVersion: 1
name: agent-dev
kind: container
mode: managed
engine: podman
image: agent-dev:latest
lifetime: group
cwd: "{{workspace_host_path}}"
workspace:
  scope: group
  hostRoot: "{{state_dir}}/workspaces"
  containerPath: /workspace
  mode: rw
  create: true
lifecycle:
  afterStart:
    - kind: command
      target: container
      user: "0"
      detach: true
      command: acl-proxy
      args: [--config, /etc/acl-proxy/acl-proxy.toml]
      env:
        AW_IDENTITY_TOKEN: "{{aw_identity_token}}"
    - kind: command
      target: host
      command: sudo
      args: ["{{aw_home}}/bin/aw-iptables", add, "{{container_pid}}"]
  onWorkspaceCreate:
    - kind: git-clone
      target: container
      source: /host/repos/project.git
      baseRef: origin/main
      branch: "task-runner/{{run_id}}"
    - kind: command
      target: container
      command: npm
      args: [install]
sessionMounts: backend
mounts:
  - hostPath: /home/kevin/.cache/agent-tools
    containerPath: /home/kevin/.cache/agent-tools
    mode: rw
network: default
security:
  userns: keep-id
  selinuxLabel: disable
```

Existing-container shape:

```yaml
schemaVersion: 1
name: external-agent-dev
kind: container
mode: existing
engine: podman
container: agent-dev
cwd: "{{cwd}}"
expectedMounts:
  - hostPath: "{{cwd}}"
    containerPath: "{{cwd}}"
    mode: rw
```

Interpolation should use the same injected variables as launchers after final
`cwd` is known: `run_id`, `run_group_id`, `cwd`, `config_dir`, `state_dir`,
`task_runner_cmd`, and `assignment_name` when present. Unknown interpolation
tokens should fail for environment paths and container names because unresolved
mounts or container identities are unsafe.

Managed environments may use a first-class `workspace` block for the primary
working directory. If `hostPath` is omitted, task-runner derives the host path
from `hostRoot` plus the run id for `scope: run` or the run group id for
`scope: group`. With `create: true`, task-runner creates that host directory
before the container starts. If the resolved environment cwd is inside the host
workspace path, task-runner rewrites it to the corresponding container path.
Generic `mounts` remain available for auth stores, caches, sockets, and other
explicit bind mounts. After resolving the workspace, managed environments can
interpolate `workspace_host_path` and `workspace_container_path` in cwd, env,
image, container name, and generic mount paths.

Managed environments may define top-level `lifecycle.afterStart` and
`lifecycle.onWorkspaceCreate` phases. `afterStart` runs after the managed
container is started or reused and inspected, before workspace setup and
backend cwd validation. It can start a detached container-local helper such
as `acl-proxy`, then run a host command such as `aw-iptables add
{{container_pid}}`. Readiness is not a built-in primitive; express it as
an ordinary command step. `mode: existing` environments reject lifecycle
phases.

`onWorkspaceCreate` runs once per host workspace. The `git-clone` step
clones into the workspace root and checks out a branch from a base ref.
The `command` step runs an arbitrary host or container command with
optional args and env. Host-side state outside the mounted workspace
records successful completion, so group-scoped workspaces run setup once
and later runs skip it without dirtying the checked-out repository.
Lifecycle state is stored outside the mounted workspace under
`{{state_dir}}/workspace-state/<workspace-key>`. For workspaces derived from
`hostRoot`, the key is the path under that root, such as the run id or run
group id. Explicit `hostPath` workspaces use a stable hash of the resolved host
path. Clearing that state directory causes the lifecycle to run again on the
next environment validation. When `onWorkspaceCreate` is configured, the
managed container starts with `--workdir` set to the workspace mount root;
task-runner validates the authored `cwd` only after lifecycle setup has
had a chance to create it.

`sessionMounts` expands same-path read-write mounts for built-in backend
session stores. `sessionMounts: backend` resolves to the selected backend's
known store; explicit lists can mount multiple stores, for example
`sessionMounts: [codex, pi]`. Presets are `claude`, `codex`, `cursor`,
`opencode`, and `pi`. These resolved mounts are frozen into the manifest so
resume/reset do not re-read current host environment paths.
For containerized backends with host-readable session history, these mounts are
also the bridge that lets task-runner sync or import backend-owned history
using the container execution cwd. Without the selected backend's session mount,
the run can still execute, but host-side session history sync may report no
durable history for that backend session.

## Manifest Shape

Add a frozen `executionEnvironment` field to `RunManifest` and `RunResetSeed`.
Use `null` for host execution.

Managed runtime example:

```json
{
  "executionEnvironment": {
    "kind": "container",
    "mode": "managed",
    "engine": "podman",
    "image": "agent-dev:latest",
    "lifetime": "group",
    "containerName": "task-runner-group-abc123",
    "containerId": "9d2f...",
    "cwd": "/workspace",
    "workspace": {
      "scope": "group",
      "hostRoot": "/home/kevin/.task-runner/workspaces",
      "hostPath": "/home/kevin/.task-runner/workspaces/abc123",
      "containerPath": "/workspace",
      "mode": "rw",
      "create": true,
      "createdAt": "2026-05-06T00:00:00.000Z",
      "lifecycle": null
    },
    "mounts": [],
    "cleanup": {
      "policy": "terminal",
      "cleanedAt": null,
      "lastError": null
    }
  }
}
```

Existing runtime example:

```json
{
  "executionEnvironment": {
    "kind": "container",
    "mode": "existing",
    "engine": "podman",
    "container": "agent-dev",
    "containerIdAtValidation": "9d2f...",
    "cwd": "/home/kevin/worktrees/task-runner",
    "expectedMounts": [],
    "lastValidatedAt": "2026-05-06T00:00:00.000Z"
  }
}
```

Persisted fields should be JSON data only. Runtime-derived values such as
container ids and cleanup errors belong in the manifest because they affect
resume, cleanup, status, and audit. Large inspect output should not be stored in
the manifest; summarize it in audit fields or status diagnostics.

## Lifecycle Semantics

### Fresh Run And Init

Fresh-run/init should resolve the environment after final `cwd` and backend
selection are known and before the manifest is frozen.

For `init`, validate static config and persist the frozen environment. Do not
create managed containers until execution starts. This preserves `init` as a
prepared run workspace operation.

For fresh active `run`, prepare the environment before the first backend
attempt.

### Attempt Execution

For supported subprocess backends, container execution should run backend
commands through `docker exec` or `podman exec` against an idle container:

```bash
podman exec -i \
  -w /home/kevin/worktrees/task-runner \
  -e TASK_RUNNER_RUN_ID=<run-id> \
  -e TASK_RUNNER_RUN_GROUP_ID=<group-id> \
  -e TASK_RUNNER_CWD=/home/kevin/worktrees/task-runner \
  task-runner-<run-id> \
  claude --print ...
```

The environment layer should preserve abort and timeout behavior. If a backend
attempt is aborted, task-runner should terminate the exec process. Managed
container cleanup follows the configured cleanup policy, not every aborted exec.

### Resume

Resume should reuse the frozen environment config and runtime state from the
manifest:

- Managed mode validates that the container still exists and is running. If the
  managed lifetime is `run` or `group` and the container is missing,
  task-runner may recreate it from the frozen config and audit the recreation.
- Existing mode validates that the named/id container exists, is running, and
  still matches required cwd/mount expectations. If validation fails, resume
  fails clearly and never recreates the container.

### Reset

Reset should restore initialized state and clear backend execution history as it
does today. Environment behavior depends on mode:

- Managed: stop/remove any owned container for the previous execution if present,
  audit cleanup, restore the frozen environment config from `resetSeed`, and
  leave the run initialized with no live container until next start.
- Existing: keep the external container untouched, restore the frozen external
  reference from `resetSeed`, and require validation on next start.

### Terminal State

Managed `lifetime: run` containers are cleaned up when a run reaches a terminal
status unless cleanup policy says otherwise. Managed `lifetime: group`
containers are cleaned up only after no initialized, ready, or running run in
the group still references the same container identity. Cleanup failure should
be audited and surfaced in status, but it should not rewrite task outcome or run
exit code by default.

### Archive And Delete

Archive should not be the primary cleanup trigger because archived state is a
human organization action. Delete must attempt cleanup for any owned managed
container before removing the workspace. If cleanup fails, delete should fail
unless the user passes a future explicit force flag.

Existing containers are never stopped or removed by archive, delete, reset, or
manual cleanup.

### Schedules

Recurring schedule `reuse` and one-time schedules should use the run's frozen
environment config.

For recurring `clone`, each clone gets a new managed container identity derived
from the cloned run id when `lifetime: run`, or the run group id when
`lifetime: group`. Run-scoped workspace host paths derived from `hostRoot` are
also rewritten to the cloned run id. Group-scoped workspace paths remain tied to
the group id.

## Backend Compatibility

Container execution should initially apply only to subprocess-backed
invocations:

- `claude`
- `codex` stdio
- `cursor`
- `opencode`
- `pi`

It should not apply to:

- `passive`, because no backend process is invoked
- Codex websocket/UDS transports, because task-runner connects to an existing
  transport instead of spawning a local subprocess
- custom backends that run in-process or declare `launcherMode: "direct"`

Custom backends can later opt into environment support by using a helper API or
by declaring an environment capability separate from launcher support.

## Mount Policy

Read-write bind mounts should be explicit and auditable. Do not mount all of
`$HOME` by default.

Same-absolute-path mounts are the recommended default:

```text
host:      /home/kevin/.codex/sessions
container: /home/kevin/.codex/sessions
```

Same-path mounts preserve backend cwd semantics and allow existing host-side
backend session history readers to keep working. Mapped paths should be allowed
only when there is an explicit backend-specific reason because they may require
env overrides and path translation.

The managed `workspace` block is the preferred mapped-path mechanism for the
primary working directory because it records scope, can create the host
directory, participates in run/group lifecycle decisions, and performs cwd
rewriting explicitly. Generic `mounts` do not rewrite cwd.

Existing-container mode cannot add mounts to an already-running container.
`expectedMounts` are validation-only.

## Backend Session Sync

Task-runner's backend session history readers are host-side readers. Container
execution can break them if backend session stores exist only inside the
container or if cwd paths differ.

Initial policy:

- When backend session sync is enabled for containerized runs, require
  same-path read-write mounts for known backend session stores, or fail sync with
  an actionable message.
- Allow users to disable backend session sync for containerized runs when the
  session store is not host-visible.
- Defer container-aware readers using `docker exec` or `docker cp`.

Backend-specific notes:

- Claude: same-path repo cwd and `~/.claude/projects` mounts preserve cwd-encoded
  project paths.
- Codex: same-path `~/.codex/sessions` keeps existing host readers viable.
- Cursor/OpenCode: SQLite-backed stores need integration testing for WAL and
  locking behavior over bind mounts.

## Runtime Engine

Support `docker` and `podman` engines with structured common options:

```yaml
engine: podman
network: default
security:
  userns: keep-id
  selinuxLabel: disable
  readOnlyRootFilesystem: false
  capDrop: []
  capAdd: []
extraRunArgs: []
extraExecArgs: []
```

Prefer structured fields for common behavior and allow raw `extraRunArgs` /
`extraExecArgs` as an explicit escape hatch. Raw args must be included in audit
summaries because they can materially change isolation.

The Podman prototype on this host needed:

```text
--security-opt label=disable
--userns=keep-id
```

The native design should support those without relying on a PATH shim.

## Audit Events

Add environment/container events to `run-events.jsonl`:

- `run.environment.validated`
- `run.environment.validation_failed`
- `run.container.created`
- `run.container.removed`
- `run.container.cleanup_failed`

Audit fields should include:

- engine
- mode
- image for managed containers
- container name/id
- cwd
- lifetime and cleanup policy
- mount summaries
- redacted env/secret-sensitive values
- command summary and exit/signal for exec events
- error message for failed validation or cleanup

These events are diagnostic history. The manifest remains canonical for current
environment state.

## CLI And API Surface

Named environment management:

```bash
task-runner list environments
task-runner show environment agent-dev
```

Fresh-run/init override:

```bash
task-runner run --agent implementer --assignment work --environment agent-dev
```

Run-scoped status and actions:

```bash
task-runner run environment status <run-id>
task-runner run environment validate <run-id>
task-runner run environment cleanup <run-id>
```

The command group is `environment`, not `container`, so future execution
environment kinds do not require a second command surface.

Daemon APIs expose the same run-scoped environment status, validation, and
cleanup actions as the embedded CLI path.

## Implementation Status

Implemented:

- environment config loading from
  `${TASK_RUNNER_CONFIG_DIR}/environments`
- `agent.executionEnvironment` plus fresh-run/init `--environment`
  override
- frozen `manifest.executionEnvironment` and
  `manifest.resetSeed.executionEnvironment`
- schemaVersion `24` manifest validation
- existing-container validation for running state, cwd, and expected
  mounts
- managed run- and group-lifetime container creation, reuse, and
  terminal/manual cleanup state
- first-class managed workspaces with run/group scope, host directory
  creation, bind mounting, and host-to-container cwd rewriting
- top-level managed lifecycle phases with `afterStart` and
  `onWorkspaceCreate` `command` / `git-clone` steps plus host-side
  workspace completion state
- backend session mount presets for same-path Claude, Codex, Cursor,
  OpenCode, and Pi session stores
- generated `docker exec` / `podman exec` subprocess launchers for
  supported backends
- environment validation, container creation/removal, and cleanup failure
  audit events
- embedded and connected CLI/API status, validate, and cleanup surfaces

Deferred:

- same-path session-store validation before backend session sync
- daemon startup scavenging for labeled abandoned managed containers
- `attempt` and `session` managed container lifetimes
- extended container audit events for reuse, exec start/finish, stopped,
  and disappeared transitions
- richer web status/capability rendering
- optional native `openai-agents` backend integration

## Testing Strategy

Unit tests:

- config parsing and interpolation
- schema validation and lock/freeze behavior
- manifest/reset seed cloning
- managed vs existing normalization
- mount validation rules
- generated Docker/Podman commands
- backend invocation transformation
- cleanup policy decisions
- audit event creation

Integration tests with fake engines:

- fake `docker`/`podman` executables record commands and return scripted inspect
  output
- existing mode never stops/removes containers
- managed mode creates/reuses/stops/removes containers
- timeout/abort terminates exec and preserves cleanup policy
- reset/delete trigger owned cleanup

Optional real-runtime tests:

- rootless Podman same-path repo mount
- read-write backend session dir mounts
- daemon forwarding from container to host
- Codex/Claude session sync through host-mounted state
- SQLite-backed session store behavior for Cursor/OpenCode

## Deferred Decisions

- Whether `executionEnvironment` should become lockable immediately, or whether
  first-write freezing is sufficient for the initial release.
- Whether cleanup failure should ever be fatal to run outcome, or only to manual
  cleanup/delete commands.
- Exact daemon forwarding env for host/container networking across Docker,
  Podman, Linux, and macOS.
- Whether mapped session paths should be rejected initially instead of merely
  unsupported for sync.
- How much Docker/Podman inspect mount-mode data is reliable enough for strict
  validation.
