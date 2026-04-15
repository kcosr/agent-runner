# Run dependencies

> **Status:** Dependency wiring is in place end-to-end — you can
> declare, inspect, and remove dependencies from the CLI, daemon, and
> web dashboard, and resume refuses to start a dependent run until
> every prerequisite reaches `status=success`. That gate is the
> **only** behavior dependencies drive today. task-runner does **not**
> currently start a dependent run on your behalf when its
> prerequisites land — you still run `task-runner run --resume-run
> <dependent-run-id>` yourself. Automatic invocation is on the
> [roadmap](../README.md#roadmap).

Initialized runs can declare prerequisite run ids. A run with unsatisfied
dependencies is rejected by `--resume-run` until every dependency
reaches canonical `status=success`. Useful for chaining orchestration:
a `plan-feature` run can depend on a `familiarize` run, an
`implementation` run can depend on `plan-feature`, and so on.

## CLI surface

```bash
task-runner run add-dep <run-id> <dependency-run-id>
task-runner run remove-dep <run-id> <dependency-run-id>
task-runner run clear-deps <run-id>

task-runner run add-dep <run-id> <dependency-run-id> --output-format json
```

## Semantics

- Allowed only while the target run is still `initialized`.
- `add-dep` rejects missing runs, self-dependencies, duplicate edges,
  and any edge that would create a dependency cycle.
- `remove-dep` rejects unknown dependency ids on the target run.
- `clear-deps` is idempotent and succeeds with `changed: false` when
  the run already has no dependencies.
- Dependency ids are persisted into both `manifest.dependencyRunIds`
  and the frozen reset seed, so `run reset` restores the same
  prerequisites.
- `task-runner run --resume-run <id>` rejects initialized runs until
  every dependency run reaches canonical `status=success`.
- `status`, `list runs`, daemon RPC/HTTP, and the web dashboard expose
  dependency state plus direct dependency/dependent lists.

## Success output

```text
task-runner: added dependency def456 to run abc123
task-runner: removed dependency def456 from run abc123
task-runner: cleared dependencies for run abc123
```

```json
{
  "runId": "abc123",
  "dependencyRunIds": ["def456"],
  "changed": true
}
```
