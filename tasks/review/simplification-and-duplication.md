---
schemaVersion: 1
id: review/simplification-and-duplication
title: Simplification & duplication
---
Two related dimensions that often pay for themselves
immediately:

**Simplification.** Look for code that's more complex than
the problem it solves:
  - Functions doing multiple unrelated things
  - Class hierarchies where a tagged union or plain
    function would do
  - Conditional chains longer than three branches that
    could be a lookup table, map, or polymorphic dispatch
  - 20-40 line blocks that express what 5-10 well-named
    helper calls would
  - "Clever" patterns (bitwise flags, stringly-typed
    registries, reflection gymnastics) where the intent
    isn't obvious from the code
  - Layered indirection where the layers don't add
    anything (e.g. wrapper classes that just forward
    every method)
  - Pre-optimizations: caches, pools, or batching for
    operations that aren't actually hot

For each, quote the current shape (a few lines) and
sketch the simpler shape in the suggested fix.

**Duplication.** Look for repeated logic whose invariants
must stay in sync:
  - The same computation inlined in multiple call sites
  - Parallel code paths that differ only in one parameter
  - Copy-pasted error handling blocks
  - Validation logic duplicated between the schema and
    the runtime check
  - Cross-language duplication (e.g. a type defined in
    both a TS file and a Rust file that will silently
    diverge)

For each, cite every instance. Propose the extraction
point — the shared helper, the shared type, the shared
module — and note which invariant the consolidation
protects.

Be specific: "this is duplicated" is not a finding.
"`src/a.ts:12-28` and `src/b.ts:40-56` both implement
retry with exponential backoff; if the backoff constant
changes in one, the other silently diverges" is.
