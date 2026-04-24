---
schemaVersion: 1
id: review/concurrency
title: Concurrency & async safety
---
This is usually the highest-leverage dimension. Look for:
  - Promise/future rejections that are silently swallowed
    (`.catch(() => {})`, bare `try { } catch {}` without
    rethrow/log, Go `_ = err`, Rust `.unwrap()` on a
    genuinely fallible result, etc.)
  - Race conditions: shared mutable state touched from
    multiple async paths without ordering guarantees
  - Listeners (`.on`, `addEventListener`, channels,
    observers) that aren't removed on every completion
    path, especially error/close paths
  - Timers (`setTimeout`, `setInterval`, select timeouts)
    that aren't cleared on every exit
  - AbortSignal / cancellation handling: pre-cancelled
    signals, listeners that fire after the awaited
    operation already settled
  - Child processes, file handles, and sockets that aren't
    cleaned up on failure paths
  - `Promise.race` / `select` patterns where the losing
    branch keeps running and may still cause side effects
  - `async`/`await` mistakes: forgotten `await`, awaiting
    in a loop when parallel would be correct, awaiting
    outside a `try` so errors bypass handlers

Read every backend adapter, every subprocess wrapper, and
the main loop(s) for the code. Format per role instructions.
