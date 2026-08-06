# DeepPi Review Fixes

## Goal

Close the five findings from the review of commit `a37103b` without adding a
locking dependency or weakening the existing safety regressions.

## Design

DeepPi will serialize writes to the same path inside the running Pi process
with a keyed promise queue. Unlike a sidecar lock, this queue cannot survive a
crash and therefore cannot become orphaned; it also needs no timeout clock.
Temporary-file preparation happens before entering the queue, and the source
snapshot is checked as the last asynchronous filesystem operation before the
rename. This protects every cooperating DeepPi writer and minimizes the
remaining external-editor window.

Portable Node filesystem APIs do not provide an atomic compare-and-replace
operation against arbitrary writers. DeepPi therefore will not claim that an
editor which ignores its process-local queue can never win or lose a race. It
will retain the post-rename verification, which detects an external writer that
wins after DeepPi's rename.

Line anchors will use the first 32 bits of SHA-256: eight hexadecimal
characters. Validation already addresses exact line numbers, so the relevant
false-accept probability is one stale replacement matching its former line,
not the birthday collision probability among unrelated lines. Eight characters
reduce the new annotation overhead from twelve to four characters per line
while retaining a 1-in-2^32 accidental stale-anchor match probability.

## Alternatives Considered

- Keep the sidecar lock and add PID/TTL recovery. Rejected because PID reuse,
  heartbeat, ownership, and stale-time semantics add failure modes and code.
- Add `proper-lockfile`. Rejected because it adds runtime dependencies while
  still requiring external writers to cooperate.
- Keep 64-bit anchors. Rejected because every read pays twelve extra characters
  per line compared with the original format, contrary to DeepPi's price goal.

## Tests

- A pre-existing `.lock` artifact must not block or be removed by a write.
- Two in-process writers must queue deterministically without sleeps; after the
  first commits, the second must reject its stale snapshot.
- The test must wait on an explicit "rename entered" signal.
- Known 16-bit collisions must remain distinct with exactly eight-character
  annotations, and all schema/prompt examples must use that width.
- Typecheck, the complete Vitest suite, package dry-run, and diff checks must
  pass.
