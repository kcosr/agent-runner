# Variables

Assignments declare typed variables that are resolved at run creation,
frozen into the manifest, and interpolated into agent instructions,
assignment instructions, task titles, task bodies, and caller instructions.

## Declaring variables

Variables are declared on the assignment under `vars`:

```yaml
---
schemaVersion: 1
name: code-review
vars:
  range:
    type: string
    sources: [cli]
    default: full
    description: Git range to review (e.g. main..HEAD)
  implementation_run_id:
    type: string
    sources: [cli]
    required: true
  log_level:
    type: enum
    values: [debug, info, warn]
    sources: [parent, env]
    envName: LOG_LEVEL
    default: info
tasks: [...]
---
```

### Schema

```ts
{
  type?: "string" | "number" | "boolean" | "enum"   // default: "string"
  required?: boolean                                 // default: false
  requiredAt?: "initial" | "prepare"                 // default: "initial"
  sources?: ("cli" | "env" | "parent")[]             // default: ["cli"]
  envName?: string                                   // default: same as key
  default?: unknown                                  // must match type
  description?: string
  values?: string[]                                  // required for enum
}
```

## Resolution at run creation

For each declared variable, task-runner walks the authored `sources` array
from left to right:

1. `cli` reads `--var key=value`.
2. `env` reads `envName` (or the var key when `envName` is omitted).
3. `parent` walks the declared `parentRunId` chain and picks the nearest
   ancestor run that already froze that variable.

If every authored source fails, task-runner then applies `default`, then
`required`, and otherwise omits the variable.

`parent` is a hot-cut source, not a fallback heuristic. Nested
`task-runner` invocations launched from a worker automatically receive
`TASK_RUNNER_PARENT_RUN_ID`, so descendant runs can inherit parent vars
without repeating `--var` flags.

Prepare hooks run after the initial resolution pass and can add or mutate
runtime vars such as `worktree_path`. Fresh-run interpolation is then
recomputed against the final runtime namespace so descendant assignments
can author patterns like:

```yaml
cwd: "{{worktree_path}}"
vars:
  worktree_path:
    type: string
    required: true
    sources: [parent]
```

## Type coercion

- `string` — pass-through.
- `number` — parsed via `Number(value)`; rejects `NaN`.
- `boolean` — accepts `"true"` / `"1"` as true, `"false"` / `"0"` as
  false; anything else errors.
- `enum` — must be one of the declared `values`.

CLI values come in as strings and are coerced; env values are coerced the
same way. `default` must already match the declared type.

## Config-time env interpolation in definitions

Before task-runner validates agent or assignment frontmatter, it resolves
shell-style env expressions in parsed scalar values:

- `${VAR}` — use `VAR`; fail if it is unset or empty
- `${VAR:-fallback}` — use `fallback` when `VAR` is unset or empty
- `${VAR-fallback}` — use `fallback` only when `VAR` is unset

This happens during definition loading, before run creation and before
schema validation. Resolved values are then validated and coerced by the
existing schemas.

Field surfaces are split explicitly:

- Exact-match typed fields accept only a single env expression for the
  whole value. This includes scalar config such as `schemaVersion`,
  `name`, `backend`, `model`, `effort`, `timeoutSec`, `unrestricted`,
  `cwd`, `maxRetries`, task ids, lock entries, var metadata, and Codex
  transport leaf fields.
- String prose fields accept env interpolation only when the entire field
  value is exactly one `${...}` expression. This includes assignment
  `message`, `callerInstructions`, task titles and bodies, var
  descriptions, and the markdown body text for agent and assignment
  instructions. Partial `${...}` inside a larger prose string is left
  literal.
- Object and array containers do not accept blob replacement. `${...}`
  cannot inject YAML or JSON into `backendSpecific`, `vars`, `tasks`, or
  `lockedFields`.

Failures are load-time config errors, not runtime interpolation misses.
The error includes the definition path, config path, env var name, and the
reason (`missing`, `empty`, `invalid syntax`, or field-surface mismatch).

## Injected variables

task-runner always provides these variables in addition to the declared
ones:

| Key | Value |
|-----|-------|
| `run_id` | the run's short id |
| `cwd` | the resolved working directory |
| `config_dir` | the resolved task-runner config root |
| `state_dir` | the resolved task-runner state root |
| `assignment_name` | the frozen assignment name, when the run has an assignment |
| `assignment_path` | path to the workspace assignment seed |
| `task_runner_cmd` | resolved CLI command for subcommand examples |

These cannot be overridden by `--var`. When a run has no assignment,
`assignment_name` is omitted, so `{{assignment_name}}` remains
uninterpolated under the normal undefined-value rule.

## Runtime interpolation syntax

References use `{{key}}` with optional whitespace. The matching pattern is
`/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g`. Undefined or `null` values leave the
token unchanged.

This runtime `{{key}}` interpolation is separate from the config-time
`${...}` env interpolation above.

Runtime interpolation is applied to:

- Agent role instructions
- Assignment instructions
- Task titles and bodies
- Caller instructions

Values are stringified with `String(value)` before substitution.

## Persistence and redaction

Resolved variables are frozen into `manifest.runtimeVars`, and their
provenance is frozen into `manifest.runtimeVarSources`.

The manifest persists the concrete resolved value, including inherited
values, so descendants can keep resolving from frozen lineage state. CLI,
daemon, and web read surfaces redact env-backed values at projection time:

```json
"runtimeVars": {
  "range": "main..HEAD",
  "log_level": "info"
},
"runtimeVarSources": {
  "range": { "source": "cli" },
  "log_level": {
    "source": "parent",
    "envName": "LOG_LEVEL",
    "redacted": true,
    "inheritedFromRunId": "abc123"
  }
}
```

Projected `RunDetail.runtimeVars` still redacts env-derived or
inherited-env-derived values for humans.

## Resume and variables

Variables are resolved once at run creation and frozen. Resume rejects
`--var` flags — use dependencies, new tasks, or follow-up messages to pass
new information. See [resume.md](resume.md).

## CLI usage

```bash
task-runner run \
  --agent implementer \
  --assignment code-review \
  --var range=main..HEAD \
  --var implementation_run_id=abc123
```

`--var` is repeatable. Values are split on the first `=`, so
`--var message=key=value` yields `message=key=value`.

Nested descendant runs usually should not repeat parent-owned vars
manually. Prefer assignment schemas that declare `sources: [parent]` or
`sources: [parent, env]` and let lineage resolution reuse the frozen
parent values.

## Inspecting resolved variables

- `task-runner run status <run-id> --output-format json` includes
  `runtimeVars` (with env values redacted).
- `show assignment <name>` renders the declared var schema and defaults.
