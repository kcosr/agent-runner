# Variables and interpolation

Assignments declare typed input variables in frontmatter:

```yaml
vars:
  repo_path:
    type: string                # string | number | boolean | enum
    required: true              # default false
    source: cli                 # cli | env | either
    envName: REPO_PATH          # only when source includes env
    default: null               # optional fallback
    description: Path to target repo
    values: [a, b, c]           # only for type: enum
```

Vars are passed via repeated `--var key=value` flags (or read from
`process.env[envName]` if the source allows it). They're validated
at run start; missing required vars or type mismatches exit with
code 3 before any backend is invoked.

Vars are resolved once at first write and frozen into the run manifest.
`--var` is therefore rejected on `--resume-run`: a resume re-uses the
frozen values rather than re-resolving them. If you need different
values, create a fresh run.

## Interpolation

Interpolation uses `{{key}}` syntax and is applied to the assignment
instructions body, the agent instructions body, and any other string
field rendered into a user-visible prompt. In addition to user-declared
vars, the runner injects:

- `{{run_id}}` — short run id
- `{{cwd}}` — resolved absolute working directory
- `{{task_runner_cmd}}` — resolved CLI command name for user-facing
  workflow instructions
- `{{assignment_path}}` — absolute workspace path for the historical
  `assignment.md` buffer. Retained for continuity; the new workspace
  layout stores an immutable `assignment-seed.md` instead of a live
  file, so prefer referencing the run id and the task CLI in new
  assignment bodies.

## Related

Locked fields (which caller-provided overrides are rejected on a given
run) are documented alongside the agent/assignment frontmatter schema
in [agents-and-assignments.md#locked-fields](agents-and-assignments.md#locked-fields).
Vars themselves are never lockable; the individual *scalar* fields
you might substitute them into (`model`, `cwd`, `message`, etc.) are.
