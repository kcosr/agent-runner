---
schemaVersion: 1
id: feature-implement/verify-surface-coverage
title: Verify surface inventory coverage
---
**Category**: hybrid

Read the **Surface Inventory** block from the
`feature-plan/surface-inventory` planning task. For every entry — added,
changed, or removed — locate three points in the
current diff and record `file:line` for each in
Notes:

  1. **Declaration / parser** — where the value
     enters from the user. CLI flag in the parser,
     HTTP route in the route table, env var in the
     env-read site, config key in the schema, UI
     field in the form binding, etc.
  2. **Consumer** — where the parsed value is
     *read* by business logic, not just stored on
     a parsed-args object or unused parameter. A
     parser that produces a value nobody reads is
     the canonical "advertised but unwired" bug;
     the reviewer's surface-completeness pass will
     flag it as HIGH.
  3. **Integration test** — a test that exercises
     the surface from its outermost entry point
     (CLI shell-out, HTTP request, RPC call, UI
     interaction). Unit tests on internal helpers
     do not count; the test must enter through the
     same surface a user would.

For each **symmetric peer** declared in the
inventory (CLI ↔ HTTP ↔ RPC ↔ UI), repeat all
three traces. An asymmetric peer (one transport
accepts the surface, another rejects or ignores it
without a contract note explaining the asymmetry)
is a HIGH gap that this task must catch before the
reviewer does.

For each **removed** entry, grep the codebase for
the old name. Hits outside the project's changelog
history, migration scripts, and pre-existing
legacy-version test fixtures are leftover wiring
that should have been deleted in lockstep. Either
delete them now or document in Notes why they must
stay.

If the inventory is the explicit "no surfaces"
statement, record that in Notes and mark the task
complete — there is nothing to trace. Do **not**
invent surfaces to fill the section.

If fixing a gap here requires code, docs, test, or
template edits, make the edits in this task and record
every file path plus the focused check command and exit
code in Notes. If the gap is larger than this task can
safely repair, mark `blocked` and explain exactly which
surface entry is incomplete.

**Done when:**

  - Every Surface Inventory entry has all three
    locations recorded in Notes (or, for removed
    entries, the trace plus the grep result).
  - Every symmetric peer is wired and traced.
  - Every removal twin has been grepped and the
    live runtime path is clean.
  - Any gap discovered during the trace has been
    fixed in this task or escalated as `blocked`
    with an explanation. Do not leave gaps for the
    reviewer to find — that is the failure mode
    this task exists to prevent.

Surface gaps caught here cost minutes; surface
gaps caught by the reviewer cost a full delta
cycle; surface gaps that ship cost user-visible
breakage. Spend the time.
