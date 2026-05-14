# Dependencies

Runs can declare dependencies on upstream runs or run groups.
Dependencies are lightweight metadata on initialized runs; at execution
time they gate execution until every upstream dependency ref is
satisfied. When a daemon manages the run, it also auto-starts `ready`
runs whose dependencies have all become satisfied.

Dependencies do not alter runtime identity. A dependent run keeps its
frozen backend, selected `backendConfig`, custom backend choice, and
`backendArgs` from initialization; dependency satisfaction only controls
whether execution may start.

## Why dependencies

Multi-stage workflows (plan -> review -> implement, or implementation ->
code-review) want to:

- keep related runs linked in the manifest
- surface readiness on the board (`dependencyState`)
- reject premature execution of downstream runs

Dependencies gate execution and, for daemon-managed `ready` runs, trigger
auto-start when all upstream dependencies are satisfied. They do not copy
state, transfer attachments, or carry message content between runs.

## CLI

```bash
agent-runner run add-dep    <run-id> --run <dependency-run-id>
agent-runner run add-dep    <run-id> --group <group-id>
agent-runner run remove-dep <run-id> --run <dependency-run-id>
agent-runner run remove-dep <run-id> --group <group-id>
agent-runner run clear-deps <run-id>
```

Rules:

- Dependency mutations require the target run to be in `initialized`
  status.
- `add-dep` requires exactly one of `--run` or `--group`.
- Run dependencies reject self-dependencies.
- Group dependencies reject the target run's own `runGroupId`.
- `add-dep` rejects duplicates.
- `add-dep` rejects any addition that would create a cycle in the
  dependency graph.
- `remove-dep` errors if the dependency does not exist.
- `clear-deps` errors if there are no dependencies.

All dependency mutations run under the agent-runner global lock so the
graph cannot race with itself.

## Execution gate

When you attempt to run or resume a dependent run, agent-runner resolves
its typed `dependencies` refs:

```ts
type RunDependencyRef =
  | { type: "run"; runId: string }
  | { type: "group"; groupId: string }
```

A run dependency is satisfied when the referenced run's status is
`success`. If the referenced run is missing, archived with non-success
terminal status, or not-yet-success, execution is blocked before backend
invocation.

A group dependency is satisfied when every non-archived run in the group
is `success`. Archived group members are excluded from the group total.
An empty or missing group is treated as missing and unsatisfied.

Once every dependency resolves as satisfied, the gate clears. Daemon-
managed runs that are already in `ready` status are resumed
automatically; other runs can be started or resumed manually on the next
invocation.

## DTOs

The shared contracts expose dependency refs and two dependency views:

```ts
RunDependencyDetail =
  | {
      type: "run"
      runId: string
      name: string | null
      status: ManifestStatus | null
      effectiveStatus: ManifestStatus | null
      archivedAt: string | null
      satisfied: boolean
      missing: boolean
    }
  | {
      type: "group"
      groupId: string
      total: number
      successful: number
      unsatisfied: number
      archivedExcluded: number
      satisfied: boolean
      missing: boolean
    }

RunDependentDetail =
  | {
      type: "run"
      via: "run"
      runId: string
      name: string | null
      status: ManifestStatus | null
      effectiveStatus: ManifestStatus | null
      archivedAt: string | null
      satisfied: boolean
      missing: boolean
    }
  | {
      type: "run"
      via: "group"
      runId: string
      dependencyGroupId: string
      name: string | null
      status: ManifestStatus | null
      effectiveStatus: ManifestStatus | null
      archivedAt: string | null
      satisfied: boolean
      missing: boolean
    }

RunDependencyState {
  ready: boolean                // true iff unsatisfied === 0
  total: number
  satisfied: number
  unsatisfied: number
}
```

`RunSummary.dependencyState`, `RunDetail.dependencies`, and
`RunDetail.dependents` surface these to the CLI, daemon, and web UI.

## Missing and archived dependencies

- A **missing run dependency** is reported with `missing: true` and
  `satisfied: false`. Execution is blocked until the dependency is
  removed or the target run is restored.
- A **missing group dependency** is reported with `missing: true`,
  `total: 0`, and `satisfied: false`.
- An **archived run dependency** is still evaluated for satisfaction via
  its status. Archiving the upstream run does not unlink the dependency.
- Archived members of a group dependency are excluded from that group's
  satisfaction count.

## Cycle detection

`add-dep` walks the existing graph before accepting a new edge. Group
membership is part of that graph: each run belongs to exactly one
`runGroupId`, run dependencies add edges to specific runs, and group
dependencies add edges to the group node. Any edge that would create a
cycle is rejected with a clear error, and no partial mutation is
persisted.

Changing a run's group with `run set-group` is also cycle-checked because
group membership can change dependency reachability.

## Web dashboard

The web dashboard surfaces dependencies on run cards (summary) and in the
detail drawer (full dependency details plus dependents). The drawer can
edit a non-running run's `runGroupId` and can add or remove run and group
dependencies while the target run is initialized. Unsatisfied
dependencies are called out on the card as a readiness indicator. While
the dependency gate is still closed, the drawer hides `Start` / `Resume`;
once the gate clears, daemon-managed `ready` runs auto-start and manual
execution controls become available again where appropriate.

## CLI output

`agent-runner run status <run-id> --output-format json` includes the full
`RunDetail` with `runGroupId`, `dependencies`, and `dependents`.
`agent-runner list runs` includes `runGroupId` and `dependencyState` so
scripts can filter runs by group and readiness.
