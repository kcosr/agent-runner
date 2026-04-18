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
    source: cli
    default: full
    description: Git range to review (e.g. main..HEAD)
  implementation_run_id:
    type: string
    source: cli
    required: true
  log_level:
    type: enum
    values: [debug, info, warn]
    source: either
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
  source?: "cli" | "env" | "either"                  // default: "cli"
  envName?: string                                   // default: same as key
  default?: unknown                                  // must match type
  description?: string
  values?: string[]                                  // required for enum
}
```

## Resolution at run creation

For each declared variable, task-runner resolves a value in the following
order:

1. If `source` is `cli` or `either` and `--var key=value` was provided on
   the CLI, use the CLI value.
2. Otherwise, if `source` is `env` or `either` and an env var named
   `envName` (or the var key, if `envName` is absent) is set, use the env
   value.
3. Otherwise, if `default` is defined, use it.
4. Otherwise, if `required: true`, the run errors at creation.
5. Otherwise, the variable is omitted from the resolved var set.

## Type coercion

- `string` — pass-through.
- `number` — parsed via `Number(value)`; rejects `NaN`.
- `boolean` — accepts `"true"` / `"1"` as true, `"false"` / `"0"` as
  false; anything else errors.
- `enum` — must be one of the declared `values`.

CLI values come in as strings and are coerced; env values are coerced the
same way. `default` must already match the declared type.

## Injected variables

task-runner always provides these variables in addition to the declared
ones:

| Key | Value |
|-----|-------|
| `run_id` | the run's short id |
| `cwd` | the resolved working directory |
| `assignment_path` | path to the workspace assignment seed |
| `task_runner_cmd` | resolved CLI command for subcommand examples |

These cannot be overridden by `--var`.

## Interpolation syntax

References use `{{key}}` with optional whitespace. The matching pattern is
`/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g`. Undefined or `null` values leave the
token unchanged.

Interpolation is applied to:

- Agent role instructions
- Assignment instructions
- Task titles and bodies
- Caller instructions

Values are stringified with `String(value)` before substitution.

## Persistence and redaction

Resolved variables are frozen into `manifest.runtimeVars`. Env-sourced
values are redacted to avoid persisting secrets:

```json
"runtimeVars": {
  "range": "main..HEAD",
  "log_level": {
    "redacted": true,
    "source": "env",
    "envName": "LOG_LEVEL"
  }
}
```

CLI- and default-sourced values persist their concrete value.

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

## Inspecting resolved variables

- `task-runner status <run-id> --output-format json` includes
  `runtimeVars` (with env values redacted).
- `show assignment <name>` renders the declared var schema and defaults.
