# Execution Environments

An execution environment runs the backend somewhere other than the host
process — today, inside a Docker or Podman container. It sits a layer
below backend invocation: the backend contract is unchanged, but
agent-runner transforms `cwd`, env, and the process launcher so the
backend subprocess runs in the container.

An environment is a named definition type. An agent selects one with
`executionEnvironment: <name>`; fresh `run` / `init` can override that
with `--environment <name|path>`. The resolved environment is frozen on
the run manifest and reset seed.

Container execution applies only to subprocess-backed backends using the
built-in `direct` launcher. Passive runs, Codex websocket/UDS transports,
and non-direct launchers reject container environments.

## Definition files

Environment files are YAML (not markdown) under the config root:

```text
${AGENT_RUNNER_CONFIG_DIR}/environments/<name>.yaml
```

There are two modes: `managed`, where agent-runner creates and owns the
container, and `existing`, where it attaches to a container someone else
owns.

## Managed environments

A managed environment is created, started, validated, used, audited, and
cleaned up by agent-runner.

```yaml
schemaVersion: 1
name: dev-container
kind: container
mode: managed
engine: podman              # docker (default) or podman
image: node:22
lifetime: group             # run (default) or group
cwd: "{{workspace_host_path}}"
workspace:
  scope: group              # run or group
  hostRoot: "{{state_dir}}/workspaces"
  containerPath: /workspace
  mode: rw                  # ro or rw
  create: true
sessionMounts: backend
cleanup:
  policy: terminal          # terminal (default) or manual
```

### Workspace

The `workspace` block is the preferred way to mount a run working
directory into a managed container. `scope: run` creates/reuses a host
path for one run; `scope: group` creates/reuses one host path shared by
every run in the run group. Provide either `hostRoot` (agent-runner
derives the path from the run or run group id) or an explicit `hostPath`,
not both. With `create: true`, agent-runner creates the host directory
before the container starts. If the resolved `cwd` is inside the
workspace host path, agent-runner rewrites it to the matching container
path before invoking the backend. Once the workspace resolves,
`workspace_host_path` and `workspace_container_path` are available for
interpolation.

### Lifecycle phases

Managed environments can define two lifecycle phases:

- `lifecycle.afterStart` runs after the container is started or reused and
  inspected, before workspace setup and backend `cwd` validation.
- `lifecycle.onWorkspaceCreate` runs once per host workspace; host-side
  state next to the workspace records completion, so later runs reusing a
  group workspace skip it without dirtying the checked-out tree. This
  phase requires a `workspace` block.

Each phase is an ordered list of steps. A `command` step runs an
arbitrary command; a `git-clone` step clones a repo into the workspace:

```yaml
lifecycle:
  onWorkspaceCreate:
    - kind: git-clone
      target: container
      source: /host/repos/project.git
      baseRef: origin/main
      branch: "agent-runner/{{run_id}}"
    - kind: command
      target: container       # host or container
      command: npm
      args: [install]
```

Command steps require an explicit `target`; `user` and `detach` are valid
only for `target: container`. Readiness is expressed as an ordinary
command step, not a built-in primitive. `mode: existing` environments
reject lifecycle phases.

### Session mounts

`sessionMounts` expands built-in backend session stores into same-path
read-write mounts, so host-side session-history sync keeps working.
`sessionMounts: backend` mounts the selected backend's store; a list such
as `sessionMounts: [codex, pi]` mounts explicit stores. Presets are
`claude`, `codex`, `cursor`, `opencode`, and `pi`. These are separate
from the `workspace` mount and from generic `mounts`.

### Generic mounts

`mounts` binds extra host paths into the container — auth stores, caches,
sockets. Same-absolute-path mounts are the recommended default because
they preserve backend `cwd` semantics and keep host-side session-history
readers working:

```yaml
mounts:
  - hostPath: /home/me/.cache/agent-tools
    containerPath: /home/me/.cache/agent-tools
    mode: rw
```

### Engine and security

Runtime engine behavior uses structured fields, with raw arg arrays as an
explicit escape hatch:

```yaml
engine: podman
network: default            # default, none, host, bridge, or a named network
security:
  userns: keep-id           # keep-id or host
  selinuxLabel: disable     # disable, shared, or private
  readOnlyRootFilesystem: false
  capDrop: []
  capAdd: []
extraRunArgs: []            # appended to container creation
extraExecArgs: []           # appended to docker/podman exec
```

### Lifetime and cleanup

`lifetime: run` containers are per-run. `lifetime: group` containers are
shared by every run in the run group and get a stable group-scoped
container name; group-scoped runs cannot be moved to another group after
creation, because the workspace and container identity are frozen.

`cleanup.policy` controls removal. With the default `terminal` policy,
agent-runner removes a `lifetime: run` container once the run reaches a
terminal status, and a `lifetime: group` container once no initialized,
ready, or running run in the group still references it. `policy: manual`
leaves removal to `agent-runner run environment cleanup`.

## Existing environments

`mode: existing` attaches to an already-running, externally managed
container. agent-runner validates it and executes inside it, but never
starts, stops, or removes it.

```yaml
schemaVersion: 1
name: external-dev
kind: container
mode: existing
engine: docker
container: devbox
cwd: "{{cwd}}"
expectedMounts:
  - hostPath: "{{cwd}}"
    containerPath: "{{cwd}}"
    mode: rw
```

`expectedMounts` are validation-only — `mode: existing` cannot add mounts
to a running container.

## Variables and interpolation

Environment files may declare `vars` using the same schema and approved
sources as assignment vars. The selected environment's vars are merged
with the assignment vars for the run and frozen into `runtimeVars`;
duplicate names must have identical definitions. Paths, container names,
`cwd`, `env`, image, and mount paths are interpolated with the same
injected variables as launchers (`run_id`, `run_group_id`, `cwd`,
`config_dir`, `state_dir`, `assignment_name`, `agent_runner_cmd`), plus
`workspace_host_path` / `workspace_container_path` once the workspace
resolves. Unknown tokens fail run creation.

## Runtime lifecycle

The resolved environment is frozen on the run manifest and reset seed;
resume and reset do not re-read current environment files.

- **Fresh run / init** — the environment is resolved after final `cwd`
  and backend selection. `init` validates static config but does not
  create a managed container until execution starts.
- **Resume** — managed mode revalidates the container and may recreate it
  from the frozen config if it is missing; existing mode revalidates the
  external container and fails clearly rather than recreating it.
- **Reset** — `run reset` stops and removes an owned managed container
  before restoring the initialized seed; existing containers are left
  untouched.
- **Delete** — deleting an archived run attempts cleanup of any owned
  managed container first.

## CLI

```bash
agent-runner list environments
agent-runner show environment <name|path>

agent-runner run environment status <id|path>
agent-runner run environment validate <id|path>
agent-runner run environment cleanup <id|path>
```

`status` prints the frozen environment state from the run manifest;
`validate` checks an existing container or starts/validates a managed
container and persists the updated state; `cleanup` removes an
agent-runner-managed container when the run is not running and no
same-group run still references it. See [cli.md](cli.md) for flags and
exit codes.
