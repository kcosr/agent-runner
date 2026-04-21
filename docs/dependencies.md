# Dependencies

Runs can declare dependencies on other runs. Dependencies are lightweight
metadata on initialized runs; at execution time they act as a gate that
prevents a dependent run from starting until every upstream run reaches
`success`.

## Why dependencies

Multi-stage workflows (plan → review → implement, or implementation →
code-review) want to:

- keep related runs linked in the manifest
- surface readiness on the board (`dependencyState`)
- reject premature execution of downstream runs

Dependencies are strictly a gate; they do not copy state, transfer
attachments, or carry message content between runs.

## CLI

```bash
task-runner run add-dep    <run-id> <dependency-run-id>
task-runner run remove-dep <run-id> <dependency-run-id>
task-runner run clear-deps <run-id>
```

Rules:

- All three mutations require the target run to be in `initialized`
  status.
- `add-dep` rejects self-dependencies.
- `add-dep` rejects duplicates.
- `add-dep` rejects any addition that would create a cycle in the
  dependency graph.
- `remove-dep` errors if the dependency does not exist.
- `clear-deps` errors if there are no dependencies.

All three mutations run under the task-runner global lock so the graph
cannot race with itself.

## Execution gate

When you attempt to run or resume a dependent run, task-runner resolves
its `dependencyRunIds`. A dependency is *satisfied* when the referenced
run's status is `success`. If any dependency is missing, archived with
non-success terminal status, or not-yet-success, the run is rejected
before invocation.

Removing or successfully completing the upstream run clears the gate on
the next invocation.

## DTOs

The shared contracts expose two dependency views:

```ts
RunDependencyDetail {
  runId: string
  name: string | null           // display name, or assignment name
  status: ManifestStatus | null // latest manifest status
  effectiveStatus: ManifestStatus | null
  archivedAt: string | null
  satisfied: boolean            // true iff status === "success"
  missing: boolean              // true iff the target manifest is missing
}

RunDependencyState {
  ready: boolean                // true iff unsatisfied === 0
  total: number
  satisfied: number
  unsatisfied: number
}
```

`RunSummary.dependencyState` and `RunDetail.dependencies` /
`RunDetail.dependents` surface these to the CLI, daemon, and web UI.

## Missing and archived dependencies

- A **missing** dependency (the target workspace was deleted) is reported
  with `missing: true` and `satisfied: false`. Execution is blocked until
  the dependency is removed or the target run is restored.
- An **archived** dependency is still evaluated for satisfaction via its
  status. Archiving the upstream run does not unlink the dependency.

## Cycle detection

`add-dep` walks the existing graph before accepting a new edge. Any edge
that would create a cycle (including self-edges) is rejected with a clear
error — no partial mutation is persisted.

## Web dashboard

The web dashboard surfaces dependencies on run cards (summary) and in the
detail drawer (full `RunDependencyDetail[]` plus dependents). Unsatisfied
dependencies are called out on the card as a readiness indicator, and the
drawer keeps showing that readiness state while the backend rejects
`Start` / `Resume` until the dependency gate is satisfied.

## CLI output

`task-runner run status <run-id> --output-format json` includes the full
`RunDetail` with `dependencies` and `dependents` arrays. `task-runner list
runs` includes `dependencyState` so scripts can filter runs that are ready
to execute.
