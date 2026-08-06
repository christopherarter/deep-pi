# DeepPi Adversarial Regression Tests

## Goal

Add deterministic failing tests for the nine defects found in the 2026-08-06
DeepPi review. The change is test-only: production modules remain untouched so
another agent can use the red suite as its repair loop.

## Placement

Keep each regression beside the module it specifies:

- `tests/stability.test.ts`
  - Pi-style `context` result chaining must remove plain-turn thinking.
  - Generic user-authored `Date:` lines must not be frozen.
- `tests/telemetry.test.ts`
  - An unsupported provider with a supported-looking model ID must not change
    direct-DeepSeek totals.
- `tests/stormbreaker.test.ts`
  - A no-tool assistant turn must end the active blocked-turn streak.
  - Model-visible tool errors must retain actionable content beyond character
    500.
- `tests/hashlines.test.ts`
  - Overlapping edit ranges must be rejected.
  - Editing a symlink must either update its target while preserving the link,
    or reject without changing either path.
  - An atomic replacement supplied with the source snapshot must reject when
    the file changed after that snapshot.
  - Meaningfully different line content must not share the known 12-bit hash
    collision used by the review reproduction.

## Test Shape

Tests use real exported functions and minimal Pi-compatible hook captures. They
do not mock filesystem results. Temporary files live under the operating
system temporary directory and are removed after each test.

The context-hook regression reproduces Pi's actual chaining contract: the next
message array changes only when a handler returns `{ messages }`. The
stormbreaker regressions apply returned `tool_result` content the same way Pi
does. The concurrency regression uses a wished-for guarded-write call shape
with `expectedContent`; the current two-argument implementation ignores that
third argument and therefore fails the preservation assertion.

## Red Contract

Each new test must fail on commit `719b583` for its named behavior, not because
of a type error, missing fixture, timeout, or nondeterministic race. Existing
tests must continue to pass when the new regression tests are filtered out.

No production code, package metadata, documentation claims, or dependencies
change in this task. `.pi-subagents/` remains untouched and untracked.

## Run Commands

```bash
npx vitest --run tests/stability.test.ts tests/telemetry.test.ts tests/stormbreaker.test.ts tests/hashlines.test.ts
npm test
```

Both commands are expected to exit nonzero until the nine defects are fixed.
