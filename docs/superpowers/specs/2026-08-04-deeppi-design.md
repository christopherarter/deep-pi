# DeepPi Design

Date: 2026-08-04

## Summary

DeepPi is a Pi extension that brings Reasonix-style price/performance behavior to the direct DeepSeek API. It supports only `deepseek-v4-flash` and `deepseek-v4-pro` through Pi's `deepseek` provider.

DeepPi stabilizes cacheable request prefixes, measures real cache usage and cost, diagnoses prefix churn, and reduces paid retry waste through loop guards and hash-verified editing. It deliberately excludes generic provider support, plan mode, and rewind behavior already better handled by Pi or Git.

The product promise is:

> The direct-DeepSeek price/performance layer for Pi.

## Goals

- Increase direct DeepSeek context-cache reuse without changing normal Pi workflows.
- Preserve valid DeepSeek reasoning and tool-call round trips.
- Report measured cache-hit tokens, uncached tokens, actual input cost, and estimated savings.
- Explain locally detectable causes of prompt-prefix churn.
- Reduce repeated tool-call and edit failures that consume paid tokens.
- Remain dependency-free and inactive outside the two supported direct DeepSeek models.
- Establish DeepPi as a materially different, narrowly focused derivative while preserving upstream attribution.

## Non-goals

- Supporting OpenRouter, proxies, or providers other than direct DeepSeek.
- Supporting DeepSeek models other than `deepseek-v4-flash` and `deepseek-v4-pro` in v1.
- Replacing Pi's provider adapter, session tree, model configuration, or cost calculation.
- Providing plan mode, file rewind, snapshots, or general agent orchestration.
- Persisting telemetry across Pi process or session restarts.
- Promising a fixed cache-hit percentage; cache expiry and provider-side state are outside DeepPi's control.
- Publishing to npm in v1; Git installation is sufficient.

## Approaches considered

### Cache only

Implement request normalization and cache telemetry only. This is smallest, but it ignores retry loops and failed edits, which are another material source of DeepSeek token spend.

### Focused performance core — selected

Combine cache stability and observability with the two reliability mechanisms that directly reduce paid retries: storm-breaking and hashline editing. This covers total DeepSeek price/performance while keeping a clear boundary.

### Full Reasonix parity

Port planning, rewind, persistence, snapshots, and broader orchestration. This duplicates Pi, expands maintenance substantially, and weakens DeepPi's identity. It is rejected.

## Activation and lifecycle

DeepPi is active only when both conditions hold:

```text
provider = deepseek
model = deepseek-v4-flash | deepseek-v4-pro
```

Matching is exact. Names, display labels, URLs, and substrings are not used as fallbacks. Unsupported models and providers receive byte-identical requests from DeepPi.

Session telemetry resets on `session_start` and is separated by model within the active session. Model selection updates the footer immediately. Switching away from an eligible model makes DeepPi dormant and clears its footer status.

The eligibility module also controls the registered `edit_lines` tool. It adds only that tool to Pi's active tool set for eligible models and removes only that tool for unsupported models, preserving every other user-selected tool. This prevents DeepPi's tool schema from changing unsupported provider requests.

DeepPi has no runtime configuration in v1. Pi already controls whether the extension is enabled, and the supported models and behavior define the product.

## Components

DeepPi remains a single Pi extension with five focused modules.

### Eligibility

Owns the exact provider/model check and exposes one predicate used by every hook. No module performs its own fuzzy model matching.

### Request stability

Performs three transformations before a direct DeepSeek request:

1. On past assistant messages without tool calls, remove accumulated `thinking` content blocks so completed private reasoning is not replayed as paid input.
2. On assistant messages containing Pi `toolCall` content blocks, preserve all thinking blocks and signatures required for the following tool-result round trip.
3. Sort final provider tool schemas deterministically by function name.

Tool-call detection uses Pi's internal content-block representation, not raw OpenAI `tool_calls` fields. DeepPi never manufactures provider-level `reasoning_content`; Pi's native DeepSeek adapter remains responsible for serializing the correct field, including empty values where the API requires them.

Recognized Pi-generated date/time lines are frozen to their first value for the session. DeepPi does not delete or rewrite arbitrary dates in user-authored prompts.

Transformations are idempotent. Reapplying them produces identical messages and tools.

### Cache diagnostics

After stabilization and immediately before each provider request, DeepPi records a prefix shape using Node's built-in SHA-256 implementation. The shape contains:

- the model ID;
- the final system-message digest;
- the sorted tool-schema digest;
- one digest per serialized conversation message.

On the next request, DeepPi checks whether the previous system message and tool schema remain identical and whether the previous conversation messages form an exact prefix of the current message list. Detected changes are classified as:

- model change;
- system-prompt change;
- tool-schema change;
- conversation-history mutation.

Newly appended assistant, tool-result, and user messages are normal growth and are not churn. Compaction may legitimately produce conversation-history mutation; DeepPi reports it without blocking the request.

An API cache miss with no local shape change is recorded as unexplained. DeepPi does not claim local churn when provider cache expiry or backend state could be responsible.

### Usage telemetry

Pi already maps DeepSeek's `prompt_cache_hit_tokens` to `usage.cacheRead`, maps uncached prompt tokens to `usage.input`, and calculates actual cost from the active model definition. DeepPi consumes the finalized assistant message at `message_end`; it does not parse raw response bodies or maintain a pricing table.

For each eligible response:

```text
hit tokens        = usage.cacheRead
miss tokens       = usage.input
cache hit rate    = hit / (hit + miss)
actual input cost = usage.cost.cacheRead + usage.cost.input
estimated savings = hit / 1,000,000 * (model.cost.input - model.cost.cacheRead)
```

The hit rate is omitted when both hit and miss tokens are zero. Savings are omitted if the finalized message model cannot be matched safely to the active model pricing metadata. Flash and Pro totals are stored separately and may also be shown as a combined session total.

### Retry economy

Storm-breaking tracks normalized tool failures by agent turn. File paths, timestamps, and line numbers are normalized only for comparison; the displayed error retains useful details.

- Below three equivalent all-failed batches, DeepPi returns enhanced diagnostics without interrupting the agent.
- At the third equivalent failure, DeepPi appends a guard to the tool result instructing the model to change approach or report the blocker.
- If the same failure batch occurs once more, DeepPi aborts the loop and reports the blocker to the user.
- Any partial or complete tool success resets the relevant failure streak.
- Alternating blocked calls contribute to a separate all-blocked-turn streak so argument rewording cannot evade the guard.

Hashline editing annotates model-visible read results with line numbers and short content hashes, while the user continues to see normal file content. The `edit_lines` tool verifies both endpoints of every edit against a fresh read and rejects the complete batch on any mismatch. Edits are applied in reverse line order only after every edit validates. Pi's built-in edit tool remains available as a fallback.

## Data flow

```text
Pi context
  -> exact direct-DeepSeek eligibility check
  -> prune replayed plain-turn thinking
  -> preserve tool-call thinking and signatures
  -> freeze recognized session timestamps
  -> sort tool schemas
  -> capture and compare prefix shape
  -> direct DeepSeek API
  -> Pi normalizes usage and calculates cost
  -> DeepPi aggregates cache and savings telemetry
  -> footer and /deeppi report
```

Tool execution follows a parallel path through error enhancement, batch-aware loop tracking, and hashline editing.

## User experience

When an eligible model is active and at least one response has usage data, the footer shows:

```text
DeepPi · 84% cache
```

Before the first measured response, it shows `DeepPi · warming`. It remains quiet for unsupported models.

`/deeppi` displays:

- active provider and model eligibility;
- response count;
- cache-read and uncached input tokens;
- cache-hit rate;
- actual input cost;
- estimated savings against fully uncached input;
- the latest prefix-churn classification;
- guarded and aborted loop counts;
- hashline edit attempts, mismatches, and successes.

Warnings are limited to actionable local prefix churn, missing usage telemetry, or a loop abort. Warm-up misses and unexplained provider misses do not generate notifications.

## Failure handling

DeepPi fails open for cache optimization and telemetry:

- If a transformation throws, the original Pi messages or provider payload continue unchanged and one diagnostic counter increments.
- If usage is missing, optimization continues and `/deeppi` reports telemetry as unavailable.
- If prefix-shape capture fails, the request continues without churn classification.
- Unsupported models and providers are never modified.
- Duplicate warnings are suppressed for the session.

File editing fails closed:

- All paths and edit parameters are validated at the tool boundary.
- Hash mismatch, invalid range, or a fresh-read failure prevents every edit in the batch.
- Partial file writes are never reported as success.

## Verification

Default verification is deterministic and makes no network calls.

### Unit checks

- exact eligibility for the direct provider and two supported model IDs;
- thinking removal on plain assistant turns;
- thinking and signature preservation on Pi `toolCall` turns;
- timestamp freezing without modifying arbitrary user dates;
- deterministic tool ordering and transformation idempotence;
- prefix-shape comparison and every churn classification;
- telemetry formulas for Flash, Pro, mixed-model sessions, zero usage, and missing pricing;
- failure-signature normalization;
- atomic hashline validation and application.

### Hook-level checks

A small fake `ExtensionAPI` registers and invokes the same callbacks used in production. Tests use current Pi message and event shapes rather than reimplementing DeepPi's transformations in test helpers.

Checks cover:

- eligible requests being stabilized;
- unsupported requests remaining byte-identical;
- `edit_lines` activation for eligible models and removal for unsupported models without disturbing other active tools;
- `message_end` usage aggregation;
- model switching and footer clearing;
- repeated failed batches, partial success, guard injection, and abort escalation;
- model-visible read annotation and user-visible output separation.

### Opt-in live benchmark

The live benchmark runs only as `DEEPPI_LIVE=1 npm run benchmark:live` with `DEEPSEEK_API_KEY` present. It exercises Flash and Pro separately. Before sending requests it prints the model, request count, token ceiling, and estimated maximum spend, then requires interactive confirmation. Purpose-built CI may bypass the prompt only with `DEEPPI_LIVE_CONFIRM=I_ACCEPT_COST`.

The benchmark sends repeated-prefix turns and verifies that later responses report nonzero cache-read tokens. It records results but does not enforce a fixed cache-hit percentage.

### Required verification command

The existing `npm run verify` command remains the local release gate and must run type checking, tests, and package dry-run checks.

## Packaging and migration

- Product name: `DeepPi`.
- Package name: `deep-pi`.
- Command: `/deeppi`.
- Initial installation: `pi install git:github.com/christopherarter/deep-pi`.
- npm publication: out of scope for v1.
- Runtime dependencies: none beyond Pi peer dependencies.

Implementation removes:

- plan mode and its command;
- rewind and its destructive Git operations;
- generic provider/model patterns;
- all `PI_HARNESS_*` runtime configuration;
- the no-op custom message renderer;
- the completed parity `PLAN.md` from the repository;
- benchmark simulations superseded by measured usage telemetry;
- tests that duplicate production transformation logic.

The package metadata, README, screenshot, command names, status keys, and source identifiers are renamed consistently to DeepPi. The repository keeps its Git history and upstream remote.

## Attribution and license

DeepPi remains BSD-3-Clause. The original copyright notice for Jason Rimmer is retained. A separate copyright notice identifies the DeepPi modifications.

The README states that DeepPi is derived from `jrimmer/pi-deepseek-optimized`, retains credit for the underlying Howard Chen and Can Akay techniques, and describes DeepPi's original scope: direct V4 model gating, real Pi usage telemetry, prefix-churn diagnostics, batch-aware retry economy, safer removal of rewind, and tests against current Pi event shapes.

The package may describe the DeepPi modifications as the maintainer's work, but it must not describe the inherited implementation as wholly original.

## Acceptance criteria

DeepPi v1 is complete when:

1. Only direct `deepseek-v4-flash` and `deepseek-v4-pro` requests are modified.
2. Plain-turn thinking is pruned while tool-call reasoning survives a real Pi-format round trip.
3. Repeated requests have stable system and tool-schema shapes unless Pi legitimately changes them.
4. `/deeppi` reports measured cache tokens, actual input cost, and model-aware savings from finalized Pi usage.
5. Local prefix churn is classified without mislabeling unexplained provider misses.
6. Three equivalent failed tool batches inject a guard, a fourth aborts, and any success resets the streak.
7. Hashline edits are fresh-read verified and atomic.
8. Unsupported providers and models remain byte-identical.
9. Default verification passes without credentials or network access.
10. The Git package dry run contains only the intended DeepPi files, README, and retained license notices.
