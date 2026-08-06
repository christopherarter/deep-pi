# DeepPi Performance Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]) syntax for tracking.

**Goal:** Build DeepPi, a direct-DeepSeek performance extension for Pi that stabilizes cache prefixes, reports measured cache economics, and reduces paid tool/edit retries.

**Architecture:** One Pi entry point wires five focused modules: exact model eligibility, request stability/prefix diagnostics, usage telemetry, batch-aware storm-breaking, and hashline editing. Pi remains responsible for provider serialization and normalized usage/cost; DeepPi is dormant and request-byte-neutral outside direct `deepseek-v4-flash` and `deepseek-v4-pro`.

**Tech Stack:** TypeScript 5.9, Node.js 22.19+, Pi ExtensionAPI, Vitest 4, Node standard library.

## Global Constraints

- Product name is `DeepPi`; package name is `deep-pi`; command name is `/deeppi`.
- Eligible provider is exactly `deepseek`; eligible model IDs are exactly `deepseek-v4-flash` and `deepseek-v4-pro`.
- OpenRouter, proxies, fuzzy model matching, plan mode, rewind, persistence, and npm publication are out of scope.
- Add no runtime or development dependency.
- Default tests and `npm run verify` must make no network calls and require no credentials.
- The live benchmark must require `DEEPPI_LIVE=1`, `DEEPSEEK_API_KEY`, and interactive confirmation or `DEEPPI_LIVE_CONFIRM=I_ACCEPT_COST`.
- Keep the original BSD-3-Clause copyright notice and add a separate notice for Christopher Arter's DeepPi modifications.
- Preserve the existing uncommitted `package-lock.json` correction and `.pi-subagents/`; never discard or stage `.pi-subagents/`.
- Use the current worktree's `package-lock.json` as the base when Task 7 intentionally changes its package name and version.
- This plan file is intentionally untracked when execution begins; include it in Task 1's commit.
- Per project `AGENTS.md`, prefix every shell command shown below with `rtk` when executing it.

## Final File Structure

```text
extensions/
  deeppi.ts                 Plugin entry point, command, footer, lifecycle wiring
  deeppi/
    eligibility.ts         Exact provider/model gate and edit_lines active-tool gate
    stability.ts           Thinking pruning, timestamp freezing, tool sorting, prefix shapes
    telemetry.ts           Per-model usage aggregation, savings, footer/report formatting
    stormbreaker.ts        Batch collection, error enhancement, guard/abort escalation
    hashlines.ts            Read annotations and atomic hash-verified edit_lines tool
    utils.ts                Shared line-hash and error-text utilities
tests/
  fake-pi.ts                Minimal reusable ExtensionAPI/context test double
  eligibility.test.ts
  stability.test.ts
  telemetry.test.ts
  stormbreaker.test.ts
  hashlines.test.ts
  deeppi.integration.test.ts
  package.test.ts
scripts/
  live-benchmark.mjs        Explicitly paid direct-DeepSeek cache smoke test
```

---

### Task 1: Establish the DeepPi boundary and exact eligibility

**Files:**
- Move: `extensions/harness.ts` -> `extensions/deeppi.ts`
- Move: `extensions/harness/` -> `extensions/deeppi/`
- Move: `tests/harness.test.ts` -> `tests/deeppi.test.ts` (temporary legacy suite; removed in Task 6)
- Create: `extensions/deeppi/eligibility.ts`
- Create: `tests/eligibility.test.ts`
- Modify: `package.json`
- Modify imports in: `extensions/deeppi.ts`, `tests/deeppi.test.ts`, `tests/benchmarks.test.ts`

**Interfaces:**
- Produces: `DeepPiModel`, `DeepPiModelId`, `isDeepPiModel(model)`, and `withEditLinesActive(activeTools, eligible)`.
- Later tasks consume `isDeepPiModel` in every hook and `withEditLinesActive` in the entry point.

- [x] **Step 1: Perform the mechanical source rename and restore a green baseline**

Run:

```bash
git mv extensions/harness.ts extensions/deeppi.ts
git mv extensions/harness extensions/deeppi
git mv tests/harness.test.ts tests/deeppi.test.ts
```

Update `package.json` to load the renamed entry while leaving package identity for Task 7:

```json
"pi": {
  "extensions": [
    "./extensions/deeppi.ts"
  ]
}
```

Change imports from `../extensions/harness.js` to `../extensions/deeppi.js` and from `./harness/` to `./deeppi/`. Run:

```bash
npm test
npm run typecheck
```

Expected: both commands pass with behavior unchanged.

- [x] **Step 2: Write failing exact-eligibility tests**

Create `tests/eligibility.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
	isDeepPiModel,
	withEditLinesActive,
} from "../extensions/deeppi/eligibility.js";

describe("isDeepPiModel", () => {
	it.each(["deepseek-v4-flash", "deepseek-v4-pro"])(
		"accepts direct DeepSeek %s",
		(id) => expect(isDeepPiModel({ provider: "deepseek", id })).toBe(true),
	);

	it.each([
		{ provider: "openrouter", id: "deepseek/deepseek-v4-pro" },
		{ provider: "deepseek", id: "deepseek-v4-pro-preview" },
		{ provider: "deepseek-proxy", id: "deepseek-v4-pro" },
		undefined,
	])("rejects $provider/$id", (model) => {
		expect(isDeepPiModel(model)).toBe(false);
	});
});

describe("withEditLinesActive", () => {
	it("adds edit_lines once without disturbing existing tools", () => {
		expect(withEditLinesActive(["read", "bash"], true)).toEqual([
			"read",
			"bash",
			"edit_lines",
		]);
		expect(withEditLinesActive(["read", "edit_lines"], true)).toEqual([
			"read",
			"edit_lines",
		]);
	});

	it("removes only edit_lines when DeepPi is dormant", () => {
		expect(withEditLinesActive(["read", "edit_lines", "bash"], false)).toEqual([
			"read",
			"bash",
		]);
	});
});
```

- [x] **Step 3: Run the focused test and verify the missing module failure**

Run:

```bash
npx vitest --run tests/eligibility.test.ts
```

Expected: FAIL because `extensions/deeppi/eligibility.ts` does not exist.

- [x] **Step 4: Implement the exact eligibility and active-tool transform**

Create `extensions/deeppi/eligibility.ts`:

```typescript
export const DEEPPI_MODEL_IDS = [
	"deepseek-v4-flash",
	"deepseek-v4-pro",
] as const;

export type DeepPiModelId = (typeof DEEPPI_MODEL_IDS)[number];
export interface DeepPiModel {
	provider: string;
	id: string;
}

const modelIds = new Set<string>(DEEPPI_MODEL_IDS);

export function isDeepPiModel(
	model: DeepPiModel | null | undefined,
): model is DeepPiModel & { id: DeepPiModelId } {
	return model?.provider === "deepseek" && modelIds.has(model.id);
}

export function withEditLinesActive(
	activeTools: readonly string[],
	eligible: boolean,
): string[] {
	const withoutDeepPi = activeTools.filter((name) => name !== "edit_lines");
	return eligible ? [...withoutDeepPi, "edit_lines"] : withoutDeepPi;
}
```

- [x] **Step 5: Run the eligibility tests and the renamed baseline**

Run:

```bash
npx vitest --run tests/eligibility.test.ts
npm test
npm run typecheck
```

Expected: all commands pass.

- [x] **Step 6: Commit the package boundary**

```bash
git add package.json extensions/deeppi.ts extensions/deeppi tests/deeppi.test.ts tests/benchmarks.test.ts tests/eligibility.test.ts
git add docs/superpowers/plans/2026-08-04-deeppi-performance-core.md
git commit -m "refactor: establish DeepPi package boundary"
```

---

### Task 2: Build request stability and prefix diagnostics

**Files:**
- Move: `extensions/deeppi/cache.ts` -> `extensions/deeppi/stability.ts`
- Replace implementation in: `extensions/deeppi/stability.ts`
- Create: `tests/stability.test.ts`
- Modify import path in: `extensions/deeppi.ts`

**Interfaces:**
- Consumes: `DeepPiModelId` from `eligibility.ts`.
- Produces: `StabilityState`, `PrefixShape`, `PrefixChurnReason`, `stabilizeMessages`, `freezeSessionTimestamps`, `sortProviderTools`, `capturePrefixShape`, and `classifyPrefixChurn`.
- Task 6 consumes `StabilityState.latestChurn` and wires the hooks.

- [x] **Step 1: Move the cache module and write failing Pi-format message tests**

Run:

```bash
git mv extensions/deeppi/cache.ts extensions/deeppi/stability.ts
```

Update the entry-point import from `./deeppi/cache.js` to `./deeppi/stability.js` before running the focused suite.

Create `tests/stability.test.ts` with the real Pi content-block shapes:

```typescript
import { describe, expect, it } from "vitest";
import {
	stabilizeMessages,
	freezeSessionTimestamps,
	type TimestampState,
} from "../extensions/deeppi/stability.js";

describe("stabilizeMessages", () => {
	it("prunes thinking from a plain assistant turn without mutating input", () => {
		const input = [{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "private" },
				{ type: "text", text: "answer" },
			],
		}];
		const result = stabilizeMessages(input);
		expect(result.messages[0]).toEqual({
			role: "assistant",
			content: [{ type: "text", text: "answer" }],
		});
		expect(result.prunedThinking).toBe(1);
		expect(input[0].content).toHaveLength(2);
	});

	it("preserves thinking and signatures on a Pi toolCall turn", () => {
		const input = [{
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "need the file",
					thinkingSignature: "reasoning_content",
				},
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
			],
		}];
		const result = stabilizeMessages(input);
		expect(result.messages).toEqual(input);
		expect(result.preservedThinking).toBe(1);
	});
});

describe("freezeSessionTimestamps", () => {
	it("freezes recognized generated lines but preserves user-authored dates", () => {
		const state: TimestampState = { frozenLines: new Map() };
		const first = freezeSessionTimestamps(
			"Current date and time is: 2026-08-04 10:00\nShip on 2026-08-08.",
			state,
		);
		const second = freezeSessionTimestamps(
			"Current date and time is: 2026-08-04 10:01\nShip on 2026-08-08.",
			state,
		);
		expect(second).toBe(first);
		expect(second).toContain("Ship on 2026-08-08.");
	});
});
```

- [x] **Step 2: Run the message tests and verify the export failures**

Run:

```bash
npx vitest --run tests/stability.test.ts
```

Expected: FAIL because the new stability exports are absent.

- [x] **Step 3: Implement thinking pruning and session timestamp freezing**

Replace the reasoning/timestamp helpers in `extensions/deeppi/stability.ts` with:

```typescript
type ContentBlock = Record<string, unknown> & { type?: string };
type MessageLike = Record<string, unknown> & { role?: string; content?: unknown };

export interface TimestampState {
	frozenLines: Map<string, string>;
}

const GENERATED_TIME_LINE =
	/^(Current date\/time is:|Current date and time is:|Today is:|Date:|Time:)\s*.*$/gim;

export function stabilizeMessages<T extends MessageLike>(messages: readonly T[]): {
	messages: T[];
	prunedThinking: number;
	preservedThinking: number;
} {
	let prunedThinking = 0;
	let preservedThinking = 0;
	const stabilized = messages.map((message) => {
		if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
		const blocks = message.content as ContentBlock[];
		const hasToolCall = blocks.some((block) => block.type === "toolCall");
		if (hasToolCall) {
			preservedThinking += blocks.filter((block) => block.type === "thinking").length;
			return message;
		}
		const content = blocks.filter((block) => {
			if (block.type !== "thinking") return true;
			prunedThinking++;
			return false;
		});
		return { ...message, content };
	});
	return { messages: stabilized, prunedThinking, preservedThinking };
}

export function freezeSessionTimestamps(prompt: string, state: TimestampState): string {
	return prompt.replace(GENERATED_TIME_LINE, (line, label: string) => {
		const key = label.toLowerCase();
		const frozen = state.frozenLines.get(key);
		if (frozen) return frozen;
		state.frozenLines.set(key, line);
		return line;
	});
}
```

- [x] **Step 4: Add failing deterministic-tool and prefix-shape tests**

Append to `tests/stability.test.ts`:

```typescript
import {
	capturePrefixShape,
	classifyPrefixChurn,
	sortProviderTools,
	type PrefixChurnReason,
	type PrefixShape,
} from "../extensions/deeppi/stability.js";

it("sorts OpenAI tool schemas deterministically without changing members", () => {
	const payload: Record<string, unknown> = {
		tools: [
			{ type: "function", function: { name: "write" } },
			{ type: "function", function: { name: "read" } },
		],
	};
	expect(sortProviderTools(payload)).toBe(true);
	expect((payload.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name))
		.toEqual(["read", "write"]);
});

it("treats appended conversation messages as stable growth", () => {
	const previous = capturePrefixShape("deepseek-v4-pro", {
		messages: [
			{ role: "system", content: "stable" },
			{ role: "user", content: "one" },
		],
		tools: [{ type: "function", function: { name: "read" } }],
	});
	const current = capturePrefixShape("deepseek-v4-pro", {
		messages: [
			{ role: "system", content: "stable" },
			{ role: "user", content: "one" },
			{ role: "assistant", content: "answer" },
			{ role: "user", content: "two" },
		],
		tools: [{ type: "function", function: { name: "read" } }],
	});
	expect(classifyPrefixChurn(previous, current)).toEqual([]);
});

const churnCases: Array<[PrefixChurnReason, Partial<PrefixShape>]> = [
	["model", { modelId: "deepseek-v4-flash" }],
	["system-prompt", { systemDigest: "changed" }],
	["tool-schema", { toolsDigest: "changed" }],
	["conversation-history", { messageDigests: ["changed"] }],
];

it.each(churnCases)("classifies %s churn", (reason, change) => {
	const base = capturePrefixShape("deepseek-v4-pro", {
		messages: [{ role: "system", content: "stable" }, { role: "user", content: "one" }],
		tools: [{ type: "function", function: { name: "read" } }],
	});
	expect(classifyPrefixChurn(base, { ...base, ...change })).toContain(reason);
});
```

- [x] **Step 5: Run the prefix tests and verify the missing export failures**

Run:

```bash
npx vitest --run tests/stability.test.ts
```

Expected: FAIL because tool sorting and prefix-shape functions are absent.

- [x] **Step 6: Implement deterministic sorting and prefix classification**

Add to `extensions/deeppi/stability.ts`:

```typescript
import { createHash } from "node:crypto";
import type { DeepPiModelId } from "./eligibility.js";

export type PrefixChurnReason =
	| "model"
	| "system-prompt"
	| "tool-schema"
	| "conversation-history";

export interface PrefixShape {
	modelId: DeepPiModelId;
	systemDigest: string;
	toolsDigest: string;
	messageDigests: string[];
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
}

function toolName(value: unknown): string {
	const tool = value as { name?: unknown; function?: { name?: unknown } } | undefined;
	const name = tool?.function?.name ?? tool?.name;
	return typeof name === "string" ? name : "";
}

export function sortProviderTools(payload: Record<string, unknown>): boolean {
	if (!Array.isArray(payload.tools)) return false;
	const sorted = [...payload.tools].sort((left, right) =>
		toolName(left).localeCompare(toolName(right)),
	);
	payload.tools = sorted;
	return true;
}

export function capturePrefixShape(
	modelId: DeepPiModelId,
	payload: Record<string, unknown>,
): PrefixShape {
	const messages = Array.isArray(payload.messages) ? payload.messages : [];
	const system = messages.find((value) => {
		const role = (value as { role?: unknown })?.role;
		return role === "system" || role === "developer";
	});
	const conversation = messages.filter((value) => {
		const role = (value as { role?: unknown })?.role;
		return role !== "system" && role !== "developer";
	});
	return {
		modelId,
		systemDigest: digest(system ?? null),
		toolsDigest: digest(Array.isArray(payload.tools) ? payload.tools : []),
		messageDigests: conversation.map(digest),
	};
}

export function classifyPrefixChurn(
	previous: PrefixShape,
	current: PrefixShape,
): PrefixChurnReason[] {
	const reasons: PrefixChurnReason[] = [];
	if (previous.modelId !== current.modelId) reasons.push("model");
	if (previous.systemDigest !== current.systemDigest) reasons.push("system-prompt");
	if (previous.toolsDigest !== current.toolsDigest) reasons.push("tool-schema");
	const historyChanged =
		previous.messageDigests.length > current.messageDigests.length ||
		previous.messageDigests.some((value, index) => current.messageDigests[index] !== value);
	if (historyChanged) reasons.push("conversation-history");
	return reasons;
}

export interface StabilityState extends TimestampState {
	previousShape: PrefixShape | null;
	latestChurn: PrefixChurnReason[];
	prunedThinking: number;
	preservedThinking: number;
	transformErrors: number;
}

export function createStabilityState(): StabilityState {
	return {
		frozenLines: new Map(),
		previousShape: null,
		latestChurn: [],
		prunedThinking: 0,
		preservedThinking: 0,
		transformErrors: 0,
	};
}
```

- [x] **Step 7: Run focused and full verification**

Run:

```bash
npx vitest --run tests/stability.test.ts
npm test
npm run typecheck
```

Expected: all commands pass.

- [x] **Step 8: Commit request stability**

```bash
git add extensions/deeppi.ts extensions/deeppi/stability.ts tests/stability.test.ts
git commit -m "feat: stabilize direct DeepSeek request prefixes"
```

---

### Task 3: Add measured cache economics and reporting

**Files:**
- Create: `extensions/deeppi/telemetry.ts`
- Create: `tests/telemetry.test.ts`

**Interfaces:**
- Consumes: `DeepPiModelId` and `PrefixChurnReason`.
- Produces: `TelemetryState`, `recordUsage`, `cacheHitRate`, `footerText`, and `formatDeepPiReport`.
- Task 6 calls `recordUsage` from `message_end` and supplies retry/hashline counters to `formatDeepPiReport`.

- [x] **Step 1: Write failing telemetry formula tests**

Create `tests/telemetry.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
	cacheHitRate,
	createTelemetryState,
	footerText,
	recordUsage,
} from "../extensions/deeppi/telemetry.js";

const pro = {
	provider: "deepseek",
	id: "deepseek-v4-pro" as const,
	cost: { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 },
};

it("records normalized Pi usage and model-aware savings", () => {
	const state = createTelemetryState();
	recordUsage(state, pro, {
		input: 20_000,
		output: 1_000,
		cacheRead: 80_000,
		cacheWrite: 0,
		totalTokens: 101_000,
		cost: { input: 0.0348, output: 0.00348, cacheRead: 0.0116, cacheWrite: 0, total: 0.04988 },
	});
	const totals = state.byModel["deepseek-v4-pro"];
	expect(totals.responses).toBe(1);
	expect(totals.hitTokens).toBe(80_000);
	expect(totals.missTokens).toBe(20_000);
	expect(cacheHitRate(totals)).toBe(0.8);
	expect(totals.actualInputCost).toBeCloseTo(0.0464);
	expect(totals.estimatedSavings).toBeCloseTo(0.1276);
	expect(footerText(state, "deepseek-v4-pro")).toBe("DeepPi · 80% cache");
});

it("omits rates and savings when usage or matching pricing is unavailable", () => {
	const state = createTelemetryState();
	expect(footerText(state, "deepseek-v4-flash")).toBe("DeepPi · warming");
	recordUsage(state, null, {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
	expect(state.usageUnavailable).toBe(true);
});
```

- [x] **Step 2: Run the telemetry test and verify the missing module failure**

Run:

```bash
npx vitest --run tests/telemetry.test.ts
```

Expected: FAIL because `telemetry.ts` does not exist.

- [x] **Step 3: Implement per-model totals and formulas**

Create `extensions/deeppi/telemetry.ts`:

```typescript
import type { DeepPiModelId } from "./eligibility.js";
import type { PrefixChurnReason } from "./stability.js";

export interface PiUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface PricedModel {
	provider: string;
	id: DeepPiModelId;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface ModelTotals {
	responses: number;
	hitTokens: number;
	missTokens: number;
	actualInputCost: number;
	estimatedSavings: number;
}

export interface TelemetryState {
	byModel: Record<DeepPiModelId, ModelTotals>;
	usageUnavailable: boolean;
	latestChurn: PrefixChurnReason[];
}

function emptyTotals(): ModelTotals {
	return { responses: 0, hitTokens: 0, missTokens: 0, actualInputCost: 0, estimatedSavings: 0 };
}

export function createTelemetryState(): TelemetryState {
	return {
		byModel: { "deepseek-v4-flash": emptyTotals(), "deepseek-v4-pro": emptyTotals() },
		usageUnavailable: false,
		latestChurn: [],
	};
}

export function recordUsage(
	state: TelemetryState,
	model: PricedModel | null,
	usage: PiUsage,
): boolean {
	if (!model || usage.input + usage.cacheRead === 0) {
		state.usageUnavailable = true;
		return false;
	}
	const totals = state.byModel[model.id];
	totals.responses++;
	totals.hitTokens += usage.cacheRead;
	totals.missTokens += usage.input;
	totals.actualInputCost += usage.cost.input + usage.cost.cacheRead;
	totals.estimatedSavings +=
		(usage.cacheRead / 1_000_000) * (model.cost.input - model.cost.cacheRead);
	return true;
}

export function cacheHitRate(totals: ModelTotals): number | null {
	const input = totals.hitTokens + totals.missTokens;
	return input === 0 ? null : totals.hitTokens / input;
}

export function footerText(state: TelemetryState, modelId: DeepPiModelId): string {
	const rate = cacheHitRate(state.byModel[modelId]);
	return rate === null ? "DeepPi · warming" : `DeepPi · ${Math.round(rate * 100)}% cache`;
}
```

- [x] **Step 4: Write a failing report-format test**

Append to `tests/telemetry.test.ts`:

```typescript
import { formatDeepPiReport } from "../extensions/deeppi/telemetry.js";

it("renders measured economics and runtime counters", () => {
	const state = createTelemetryState();
	recordUsage(state, pro, {
		input: 20_000,
		output: 1_000,
		cacheRead: 80_000,
		cacheWrite: 0,
		totalTokens: 101_000,
		cost: { input: 0.0348, output: 0.00348, cacheRead: 0.0116, cacheWrite: 0, total: 0.04988 },
	});
	state.latestChurn = ["tool-schema"];
	const report = formatDeepPiReport({
		eligible: true,
		modelId: "deepseek-v4-pro",
		telemetry: state,
		loopsGuarded: 2,
		loopsAborted: 1,
		editAttempts: 5,
		editMismatches: 1,
		editSuccesses: 4,
	});
	expect(report).toContain("Model:              deepseek-v4-pro");
	expect(report).toContain("Cache hit rate:     80.0%");
	expect(report).toContain("Prefix churn:       tool-schema");
	expect(report).toContain("Loops guarded:      2");
});
```

- [x] **Step 5: Run the report test and verify the missing export failure**

Run:

```bash
npx vitest --run tests/telemetry.test.ts
```

Expected: FAIL because `formatDeepPiReport` is absent.

- [x] **Step 6: Implement the report formatter**

Add a `ReportInput` interface and formatter to `telemetry.ts`. Use these exact labels so command output remains testable:

```typescript
export interface ReportInput {
	eligible: boolean;
	modelId: DeepPiModelId | null;
	telemetry: TelemetryState;
	loopsGuarded: number;
	loopsAborted: number;
	editAttempts: number;
	editMismatches: number;
	editSuccesses: number;
}

export function formatDeepPiReport(input: ReportInput): string {
	if (!input.eligible || !input.modelId) return "DeepPi is dormant for the active model.";
	const totals = input.telemetry.byModel[input.modelId];
	const rate = cacheHitRate(totals);
	const churn = input.telemetry.latestChurn.length === 0
		? "none"
		: input.telemetry.latestChurn.join(", ");
	return [
		`Model:              ${input.modelId}`,
		`Responses:          ${totals.responses}`,
		`Cache read:         ${totals.hitTokens.toLocaleString()} tokens`,
		`Uncached input:     ${totals.missTokens.toLocaleString()} tokens`,
		`Cache hit rate:     ${rate === null ? "unavailable" : `${(rate * 100).toFixed(1)}%`}`,
		`Actual input cost:  $${totals.actualInputCost.toFixed(4)}`,
		`Estimated savings:  $${totals.estimatedSavings.toFixed(4)}`,
		`Prefix churn:       ${churn}`,
		`Loops guarded:      ${input.loopsGuarded}`,
		`Loops aborted:      ${input.loopsAborted}`,
		`Edit attempts:      ${input.editAttempts}`,
		`Edit mismatches:    ${input.editMismatches}`,
		`Edit successes:     ${input.editSuccesses}`,
	].join("\n");
}
```

- [x] **Step 7: Run focused and full verification**

Run:

```bash
npx vitest --run tests/telemetry.test.ts
npm test
npm run typecheck
```

Expected: all commands pass.

- [x] **Step 8: Commit telemetry**

```bash
git add extensions/deeppi/telemetry.ts tests/telemetry.test.ts
git commit -m "feat: measure DeepSeek cache economics"
```

---

### Task 4: Replace per-call storm tracking with batch-aware retry economy

**Files:**
- Replace implementation in: `extensions/deeppi/stormbreaker.ts`
- Create: `tests/stormbreaker.test.ts`
- Modify shared error helpers in: `extensions/deeppi/utils.ts`

**Interfaces:**
- Consumes: `isDeepPiModel`.
- Produces: `StormBreakerState`, `startToolBatch`, `recordToolOutcome`, `resetStormBreaker`, and `registerStormBreaker(pi, eligible)`.
- Task 6 reads `guardsInjected` and `loopsAborted` for `/deeppi`.

- [x] **Step 1: Write failing batch reducer tests**

Create `tests/stormbreaker.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
	createStormBreakerState,
	recordToolOutcome,
	startToolBatch,
} from "../extensions/deeppi/stormbreaker.js";

const calls = [
	{ id: "a", name: "read" },
	{ id: "b", name: "grep" },
];

function failBatch(state: ReturnType<typeof createStormBreakerState>, suffix = "") {
	startToolBatch(state, calls);
	expect(recordToolOutcome(state, { id: "b", name: "grep", isError: true, text: `denied ${suffix}` }).kind)
		.toBe("pending");
	return recordToolOutcome(state, { id: "a", name: "read", isError: true, text: `missing ${suffix}` });
}

it("injects a guard on the third equivalent all-failed batch and aborts the fourth", () => {
	const state = createStormBreakerState();
	expect(failBatch(state).kind).toBe("none");
	expect(failBatch(state).kind).toBe("none");
	expect(failBatch(state).kind).toBe("guard");
	expect(failBatch(state).kind).toBe("abort");
});

it("resets both streaks when any tool succeeds", () => {
	const state = createStormBreakerState();
	failBatch(state);
	failBatch(state);
	startToolBatch(state, calls);
	recordToolOutcome(state, { id: "a", name: "read", isError: false, text: "ok" });
	expect(recordToolOutcome(state, { id: "b", name: "grep", isError: true, text: "denied" }).kind)
		.toBe("none");
	expect(state.repeatCount).toBe(0);
	expect(state.blockedTurnStreak).toBe(0);
});

it("guards alternating all-failed batches through the blocked-turn streak", () => {
	const state = createStormBreakerState();
	expect(failBatch(state, "one").kind).toBe("none");
	expect(failBatch(state, "two").kind).toBe("none");
	expect(failBatch(state, "three").kind).toBe("guard");
});
```

- [x] **Step 2: Run the reducer tests and verify missing exports**

Run:

```bash
npx vitest --run tests/stormbreaker.test.ts
```

Expected: FAIL because the batch reducer exports are absent.

- [x] **Step 3: Implement order-stable batch collection and escalation**

Replace the current single-record tracking with these state and reducer shapes:

```typescript
export interface ExpectedToolCall { id: string; name: string }
export interface ToolOutcome extends ExpectedToolCall { isError: boolean; text: string }
export type StormDecision =
	| { kind: "pending" | "none" }
	| { kind: "guard" | "abort"; message: string };

export interface StormBreakerState {
	expected: ExpectedToolCall[];
	outcomes: Map<string, ToolOutcome>;
	lastSignature: string | null;
	repeatCount: number;
	blockedTurnStreak: number;
	guardsInjected: number;
	loopsAborted: number;
	errorsEnhanced: number;
}

export function createStormBreakerState(): StormBreakerState {
	return {
		expected: [], outcomes: new Map(), lastSignature: null, repeatCount: 0,
		blockedTurnStreak: 0, guardsInjected: 0, loopsAborted: 0, errorsEnhanced: 0,
	};
}

export function startToolBatch(state: StormBreakerState, calls: ExpectedToolCall[]): void {
	state.expected = calls;
	state.outcomes = new Map();
}

export function recordToolOutcome(
	state: StormBreakerState,
	outcome: ToolOutcome,
): StormDecision {
	if (!state.expected.some((call) => call.id === outcome.id)) return { kind: "none" };
	state.outcomes.set(outcome.id, outcome);
	if (state.outcomes.size < state.expected.length) return { kind: "pending" };
	const ordered = state.expected.map((call) => state.outcomes.get(call.id)!);
	state.expected = [];
	state.outcomes = new Map();
	if (ordered.some((value) => !value.isError)) {
		state.lastSignature = null;
		state.repeatCount = 0;
		state.blockedTurnStreak = 0;
		return { kind: "none" };
	}
	const signature = batchSignatureFromOutcomes(ordered);
	state.repeatCount = state.lastSignature === signature ? state.repeatCount + 1 : 1;
	state.lastSignature = signature;
	state.blockedTurnStreak++;
	const level = Math.max(state.repeatCount, state.blockedTurnStreak);
	const lastError = ordered.at(-1)!.text.slice(0, 300);
	if (level === 3) {
		state.guardsInjected++;
		return {
			kind: "guard",
			message: `[loop guard] Every tool call in this batch failed repeatedly. Change arguments, use another tool, or report the blocker. Last error: ${lastError}`,
		};
	}
	if (level >= 4) {
		state.loopsAborted++;
		return { kind: "abort", message: `DeepPi stopped a repeated failed tool batch. Last error: ${lastError}` };
	}
	return { kind: "none" };
}

function batchSignatureFromOutcomes(outcomes: ToolOutcome[]): string {
	return outcomes.map((outcome) =>
		`${outcome.name}\0${errorSignature(outcome.name, outcome.text)}`,
	).join("\0\0");
}
```

Delete `FailureRecord`, threshold configuration, pending-abort state, and `tool_execution_end` tracking. Keep `enhanceError`, `errorSignature`, and `extractErrorText` in `utils.ts` with their existing focused tests moved into this suite.

- [x] **Step 4: Add failing hook tests for expected-call discovery and last-result patching**

Extend `tests/stormbreaker.test.ts` with a minimal hook capture—no shared fake is needed yet:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	registerStormBreaker,
	toolCallsFromMessage,
} from "../extensions/deeppi/stormbreaker.js";

const assistant = {
	role: "assistant",
	content: [
		{ type: "toolCall", id: "a", name: "read", arguments: {} },
		{ type: "toolCall", id: "b", name: "grep", arguments: {} },
	],
};

it("discovers Pi toolCall blocks in message order", () => {
	expect(toolCallsFromMessage(assistant)).toEqual(calls);
});

it("adds the batch guard only to the result that completes the third batch", async () => {
	type Hook = (event: any, ctx: any) => Promise<any> | any;
	const hooks = new Map<string, Hook>();
	const pi = {
		on(type: string, hook: Hook) { hooks.set(type, hook); },
	} as unknown as ExtensionAPI;
	const state = createStormBreakerState();
	registerStormBreaker(pi, state, () => true);
	const ctx = {
		model: { provider: "deepseek", id: "deepseek-v4-pro" },
		abort() {},
		ui: { notify() {} },
	};
	let earlyResult: unknown;
	let finalResult: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		await hooks.get("message_end")!({ message: assistant }, ctx);
		earlyResult = await hooks.get("tool_result")!({
			toolCallId: "b", toolName: "grep", isError: true,
			content: [{ type: "text", text: "denied" }],
		}, ctx);
		finalResult = await hooks.get("tool_result")!({
			toolCallId: "a", toolName: "read", isError: true,
			content: [{ type: "text", text: "missing" }],
		}, ctx);
	}
	expect(JSON.stringify(earlyResult)).not.toContain("[loop guard]");
	expect(JSON.stringify(finalResult)).toContain("[loop guard]");
});
```

- [x] **Step 5: Implement message discovery and hook registration**

Register `message_end` to call `startToolBatch` when an eligible assistant message contains tool calls. Register `tool_result` to enhance error text, feed `recordToolOutcome`, append a guard to the last result, or call `ctx.abort()` and notify on abort:

```typescript
export function toolCallsFromMessage(message: unknown): ExpectedToolCall[] {
	const value = message as { role?: unknown; content?: unknown } | undefined;
	if (value?.role !== "assistant" || !Array.isArray(value.content)) return [];
	return value.content.flatMap((block) => {
		const call = block as { type?: unknown; id?: unknown; name?: unknown };
		return call.type === "toolCall" && typeof call.id === "string" && typeof call.name === "string"
			? [{ id: call.id, name: call.name }]
			: [];
	});
}

pi.on("message_end", async (event, ctx) => {
	if (!eligible(ctx.model)) return;
	const calls = toolCallsFromMessage(event.message);
	if (calls.length > 0) startToolBatch(state, calls);
});

pi.on("tool_result", async (event, ctx) => {
	if (!eligible(ctx.model)) return;
	const raw = extractErrorText(event.content);
	const text = event.isError ? enhanceError(event.toolName, raw) : raw;
	if (text !== raw) state.errorsEnhanced++;
	const decision = recordToolOutcome(state, {
		id: event.toolCallId,
		name: event.toolName,
		isError: event.isError,
		text,
	});
	if (decision.kind === "guard") {
		return { content: [{ type: "text" as const, text: `${text}\n\n${decision.message}` }] };
	}
	if (decision.kind === "abort") {
		ctx.abort();
		ctx.ui.notify(decision.message, "warning");
	}
	if (event.isError && text !== raw) {
		return { content: [{ type: "text" as const, text }] };
	}
});
```

- [x] **Step 6: Run focused and full verification**

Run:

```bash
npx vitest --run tests/stormbreaker.test.ts
npm test
npm run typecheck
```

Expected: all commands pass.

- [x] **Step 7: Commit retry economy**

```bash
git add extensions/deeppi/stormbreaker.ts extensions/deeppi/utils.ts tests/stormbreaker.test.ts
git commit -m "feat: guard repeated failed tool batches"
```

---

### Task 5: Make hashline editing eligible-only and atomic

**Files:**
- Modify: `extensions/deeppi/hashlines.ts`
- Modify: `extensions/deeppi/utils.ts`
- Create: `tests/hashlines.test.ts`

**Interfaces:**
- Consumes: `isDeepPiModel` and the entry point's active-tool gate.
- Produces: `HashEdit`, `HashlineStats`, `registerHashlines(pi, eligible)`, `validateEdits`, `applyEditsToLines`, and `atomicWriteFile`.
- Task 6 reads hashline counters for `/deeppi`.

- [x] **Step 1: Move existing pure hashline checks into a focused suite and add atomic-write tests**

Create `tests/hashlines.test.ts`. Move the existing assertions for `lineHash`, annotation, confused edit arguments, schema, validation, application order, and summaries from the temporary `tests/deeppi.test.ts`. Add a real temporary-file test using Node's test-safe temporary directory:

```typescript
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { atomicWriteFile } from "../extensions/deeppi/hashlines.js";

const created: string[] = [];
afterEach(async () => {
	for (const path of created.splice(0)) await rm(path, { recursive: true });
});

it("atomically replaces content and preserves the file mode", async () => {
	const dir = await mkdtemp(join(tmpdir(), "deeppi-hashlines-"));
	created.push(dir);
	const path = join(dir, "sample.ts");
	await writeFile(path, "old\n", { mode: 0o640 });
	await atomicWriteFile(path, "new\n");
	expect(await readFile(path, "utf8")).toBe("new\n");
	expect((await stat(path)).mode & 0o777).toBe(0o640);
});
```

- [x] **Step 2: Run the focused test and verify `atomicWriteFile` is missing**

Run:

```bash
npx vitest --run tests/hashlines.test.ts
```

Expected: FAIL because `atomicWriteFile` is not exported.

- [x] **Step 3: Implement same-directory atomic replacement with cleanup**

Add to `extensions/deeppi/hashlines.ts`:

```typescript
import { chmod, open, rename, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

export async function atomicWriteFile(path: string, content: string): Promise<void> {
	const mode = (await stat(path)).mode & 0o777;
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let created = false;
	try {
		const handle = await open(temporary, "wx", mode);
		created = true;
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await chmod(temporary, mode);
		await rename(temporary, path);
		created = false;
	} finally {
		if (created) await unlink(temporary).catch(() => undefined);
	}
}
```

Replace the direct `writeFile` in the edit tool with `atomicWriteFile` after every edit validates.

- [x] **Step 4: Add failing eligibility and all-or-nothing tool tests**

Extend the focused suite with a local registered-tool capture:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	registerHashlines,
} from "../extensions/deeppi/hashlines.js";
import { lineHash } from "../extensions/deeppi/utils.js";

function captureEditLines() {
	let tool: any;
	const pi = {
		on() {},
		registerTool(value: any) { tool = value; },
	} as unknown as ExtensionAPI;
	const stats = registerHashlines(
		pi,
		(model) => model?.provider === "deepseek" && model.id === "deepseek-v4-pro",
	);
	return { stats, tool };
}

it("rejects unsupported models without touching the file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "deeppi-hashlines-"));
	created.push(dir);
	const path = join(dir, "sample.ts");
	const original = "alpha\nbeta\n";
	await writeFile(path, original);
	const { stats, tool } = captureEditLines();
	const result = await tool.execute("call-1", {
		path: "sample.ts",
		edits: [{ from: 1, from_hash: lineHash("alpha"), to: 1, to_hash: lineHash("alpha"), new_text: "A" }],
	}, new AbortController().signal, undefined, {
		cwd: dir,
		model: { provider: "openrouter", id: "deepseek/deepseek-v4-pro" },
	});
	expect(result.isError).toBe(true);
	expect(result.content[0].text).toContain("dormant");
	expect(await readFile(path, "utf8")).toBe(original);
	expect(stats.editSuccesses).toBe(0);
});

it("validates the entire batch before atomically replacing the file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "deeppi-hashlines-"));
	created.push(dir);
	const path = join(dir, "sample.ts");
	const original = "alpha\nbeta\n";
	await writeFile(path, original);
	const { stats, tool } = captureEditLines();
	const result = await tool.execute("call-2", {
		path: "sample.ts",
		edits: [
			{ from: 1, from_hash: lineHash("alpha"), to: 1, to_hash: lineHash("alpha"), new_text: "A" },
			{ from: 2, from_hash: "stale", to: 2, to_hash: "stale", new_text: "B" },
		],
	}, new AbortController().signal, undefined, {
		cwd: dir,
		model: { provider: "deepseek", id: "deepseek-v4-pro" },
	});
	expect(result.isError).toBe(true);
	expect(await readFile(path, "utf8")).toBe(original);
	expect(stats.editSuccesses).toBe(0);
	expect(stats.hashMismatches).toBe(1);
});
```

- [x] **Step 5: Remove generic config/pattern arguments from hashline registration**

Change the registration signature to:

```typescript
export interface HashEdit {
	from: number;
	from_hash: string;
	to: number;
	to_hash: string;
	new_text: string;
}

export function registerHashlines(
	pi: ExtensionAPI,
	eligible: (model: { provider: string; id: string } | undefined) => boolean,
): HashlineStats
```

Gate both read annotation and tool execution with `eligible(ctx.model)`. Preserve `event.details` unchanged when returning annotated model content so Pi's built-in renderer retains its normal display data.

- [x] **Step 6: Run focused and full verification**

Run:

```bash
npx vitest --run tests/hashlines.test.ts
npm test
npm run typecheck
```

Expected: all commands pass.

- [x] **Step 7: Commit atomic hashline editing**

```bash
git add extensions/deeppi/hashlines.ts extensions/deeppi/utils.ts tests/hashlines.test.ts
git commit -m "feat: make hashline edits eligible and atomic"
```

---

### Task 6: Wire the plugin, current Pi hooks, command, and footer

**Files:**
- Rewrite: `extensions/deeppi.ts`
- Create: `tests/fake-pi.ts`
- Create: `tests/deeppi.integration.test.ts`
- Modify: `extensions/deeppi/stability.ts`
- Modify: `extensions/deeppi/telemetry.ts`
- Modify: `extensions/deeppi/stormbreaker.ts`
- Delete: `extensions/deeppi/config.ts`
- Delete: `extensions/deeppi/planmode.ts`
- Delete: `extensions/deeppi/rewind.ts`
- Delete: `extensions/deeppi/types.ts` after moving `HashEdit` into `hashlines.ts`
- Delete: `tests/deeppi.test.ts`
- Delete: `tests/benchmarks.test.ts`

**Interfaces:**
- Consumes every module interface from Tasks 1-5.
- Produces the default Pi extension factory, `/deeppi`, footer behavior, session reset, exact tool activation, and hook-level proof of dormant byte neutrality.

- [x] **Step 1: Create the reusable fake Pi and context**

Create `tests/fake-pi.ts`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Handler = (event: any, ctx: any) => Promise<any> | any;

export class FakePi {
	handlers = new Map<string, Handler[]>();
	commands = new Map<string, { handler: Handler }>();
	tools = new Map<string, any>();
	activeTools = ["read", "edit", "bash"];

	on(type: string, handler: Handler): void {
		this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
	}
	registerCommand(name: string, command: { handler: Handler }): void {
		this.commands.set(name, command);
	}
	registerTool(tool: { name: string }): void {
		this.tools.set(tool.name, tool);
	}
	getActiveTools(): string[] {
		return [...this.activeTools];
	}
	setActiveTools(names: string[]): void {
		this.activeTools = [...names];
	}
	async emit(type: string, event: any, ctx: any): Promise<any[]> {
		const results: any[] = [];
		for (const handler of this.handlers.get(type) ?? []) results.push(await handler(event, ctx));
		return results;
	}
	asExtensionAPI(): ExtensionAPI {
		return this as unknown as ExtensionAPI;
	}
}

export function fakeContext(model: {
	provider: string;
	id: string;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
} | undefined) {
	const statuses = new Map<string, string | undefined>();
	const notifications: string[] = [];
	return {
		model,
		cwd: process.cwd(),
		hasUI: true,
		aborted: false,
		abort() { this.aborted = true; },
		ui: {
			setStatus(key: string, value: string | undefined) { statuses.set(key, value); },
			notify(message: string) { notifications.push(message); },
		},
		statuses,
		notifications,
	};
}
```

Use `any` only inside this test double; production modules remain strict.

- [x] **Step 2: Write failing end-to-end hook tests**

Create `tests/deeppi.integration.test.ts` that imports the default plugin and proves:

```typescript
import { describe, expect, it } from "vitest";
import deepPi from "../extensions/deeppi.js";
import { FakePi, fakeContext } from "./fake-pi.js";

it("is dormant and removes only edit_lines for unsupported models", async () => {
	const fake = new FakePi();
	fake.activeTools.push("edit_lines");
	deepPi(fake.asExtensionAPI());
	const ctx = fakeContext({ provider: "openrouter", id: "deepseek/deepseek-v4-pro" });
	await fake.emit("session_start", {}, ctx);
	expect(fake.activeTools).toEqual(["read", "edit", "bash"]);
	expect(ctx.statuses.get("deeppi")).toBeUndefined();
});

it("activates edit_lines and reports measured cache usage for Pro", async () => {
	const fake = new FakePi();
	deepPi(fake.asExtensionAPI());
	const ctx = fakeContext({
		provider: "deepseek",
		id: "deepseek-v4-pro",
		cost: { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 },
	});
	await fake.emit("session_start", {}, ctx);
	expect(fake.activeTools).toContain("edit_lines");
	expect(ctx.statuses.get("deeppi")).toBe("DeepPi · warming");
	await fake.emit("message_end", {
		message: {
			role: "assistant",
			provider: "deepseek",
			model: "deepseek-v4-pro",
			content: [{ type: "text", text: "done" }],
			usage: {
				input: 20_000, output: 100, cacheRead: 80_000, cacheWrite: 0, totalTokens: 100_100,
				cost: { input: 0.0348, output: 0.000348, cacheRead: 0.0116, cacheWrite: 0, total: 0.046748 },
			},
		},
	}, ctx);
	expect(ctx.statuses.get("deeppi")).toBe("DeepPi · 80% cache");
	await fake.commands.get("deeppi")!.handler("", ctx);
	expect(ctx.notifications.at(-1)).toContain("Cache hit rate:     80.0%");
});
```

Add the byte-neutrality test to the same file:

```typescript
it("does not transform request bytes for unsupported models", async () => {
	const fake = new FakePi();
	deepPi(fake.asExtensionAPI());
	const ctx = fakeContext({ provider: "deepseek", id: "deepseek-chat" });
	const messages = [{ role: "assistant", content: [
		{ type: "thinking", thinking: "must remain" },
		{ type: "text", text: "answer" },
	] }];
	const payload = {
		model: "deepseek-chat",
		messages: [{ role: "user", content: "hello" }],
		tools: [
			{ type: "function", function: { name: "write" } },
			{ type: "function", function: { name: "read" } },
		],
	};
	const messagesBefore = structuredClone(messages);
	const payloadBefore = structuredClone(payload);
	const contextResults = await fake.emit("context", { messages }, ctx);
	const providerResults = await fake.emit("before_provider_request", { payload }, ctx);
	expect(contextResults.every((value) => value === undefined)).toBe(true);
	expect(providerResults.every((value) => value === undefined)).toBe(true);
	expect(messages).toEqual(messagesBefore);
	expect(payload).toEqual(payloadBefore);
});
```

- [x] **Step 3: Run the integration test and verify the old entry fails the contract**

Run:

```bash
npx vitest --run tests/deeppi.integration.test.ts
```

Expected: FAIL because the current entry still exposes old commands/config and does not wire telemetry or exact tool activation.

- [x] **Step 4: Add hook registration functions to stability and telemetry**

In `stability.ts`, export `registerStabilityHooks(pi, state, eligible)`. Register:

- `context`: compute `stabilizeMessages` first, then replace `event.messages` only after the pure transform succeeds;
- `before_agent_start`: freeze recognized timestamps and return the stable `systemPrompt`;
- `before_provider_request`: clone/sort `payload.tools`, capture the shape, classify it against `state.previousShape`, update state only after all steps succeed, and return the cloned payload directly (Pi chains the returned payload, not `{ payload }`).

Wrap each handler body in `try/catch`; increment `state.transformErrors` and return nothing on failure so Pi retains the original event.

Use this order in the provider hook so no partial mutation leaks on failure:

```typescript
pi.on("before_provider_request", async (event, ctx) => {
	if (!eligible(ctx.model)) return;
	try {
		const payload = structuredClone(event.payload) as Record<string, unknown>;
		sortProviderTools(payload);
		const shape = capturePrefixShape(ctx.model.id, payload);
		const churn = state.previousShape ? classifyPrefixChurn(state.previousShape, shape) : [];
		state.previousShape = shape;
		state.latestChurn = churn;
		return payload;
	} catch {
		state.transformErrors++;
	}
});
```

In `telemetry.ts`, export `resetTelemetry(state)` and `registerTelemetryHooks(pi, state, onUpdate)`. On eligible assistant `message_end`, require `event.message.provider === ctx.model.provider` and `event.message.model === ctx.model.id`, call `recordUsage`, then invoke `onUpdate(ctx)`.

- [x] **Step 5: Rewrite the entry point with only approved wiring**

Replace `extensions/deeppi.ts` with the final wiring shape:

```typescript
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isDeepPiModel, withEditLinesActive } from "./deeppi/eligibility.js";
import { createStabilityState, registerStabilityHooks } from "./deeppi/stability.js";
import { createTelemetryState, footerText, formatDeepPiReport, registerTelemetryHooks, resetTelemetry } from "./deeppi/telemetry.js";
import { createStormBreakerState, registerStormBreaker, resetStormBreaker } from "./deeppi/stormbreaker.js";
import { registerHashlines } from "./deeppi/hashlines.js";

export default function deepPi(pi: ExtensionAPI): void {
	const stability = createStabilityState();
	const telemetry = createTelemetryState();
	const storm = createStormBreakerState();
	const hashlines = registerHashlines(pi, isDeepPiModel);

	function syncModel(ctx: ExtensionContext): void {
		const eligible = isDeepPiModel(ctx.model);
		const current = pi.getActiveTools();
		const active = withEditLinesActive(current, eligible);
		if (active.join("\0") !== current.join("\0")) pi.setActiveTools(active);
		if (ctx.hasUI) {
			ctx.ui.setStatus("deeppi", eligible ? footerText(telemetry, ctx.model.id) : undefined);
		}
	}

	registerStabilityHooks(pi, stability, isDeepPiModel);
	registerStormBreaker(pi, storm, isDeepPiModel);
	registerTelemetryHooks(pi, telemetry, (ctx) => syncModel(ctx));

	pi.on("session_start", async (_event, ctx) => {
		resetTelemetry(telemetry);
		resetStormBreaker(storm);
		stability.previousShape = null;
		stability.latestChurn = [];
		stability.frozenLines.clear();
		syncModel(ctx);
	});
	pi.on("model_select", async (_event, ctx) => syncModel(ctx));

	pi.registerCommand("deeppi", {
		description: "Show direct DeepSeek cache economics and retry statistics",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			telemetry.latestChurn = stability.latestChurn;
			ctx.ui.notify(formatDeepPiReport({
				eligible: isDeepPiModel(ctx.model),
				modelId: isDeepPiModel(ctx.model) ? ctx.model.id : null,
				telemetry,
				loopsGuarded: storm.guardsInjected,
				loopsAborted: storm.loopsAborted,
				editAttempts: hashlines.editCalls,
				editMismatches: hashlines.hashMismatches,
				editSuccesses: hashlines.editSuccesses,
			}), "info");
		},
	});
}
```

Export only pure functions/types required by the focused tests; remove every old config, plan, and rewind export.

- [x] **Step 6: Delete non-goal modules and legacy duplicated suites**

Run:

```bash
git rm extensions/deeppi/config.ts extensions/deeppi/planmode.ts extensions/deeppi/rewind.ts extensions/deeppi/types.ts
git rm tests/deeppi.test.ts tests/benchmarks.test.ts
```

Move `HashEdit` into `hashlines.ts`. Ensure every still-useful pure utility assertion now lives in `stability.test.ts`, `stormbreaker.test.ts`, or `hashlines.test.ts` before deletion.

- [x] **Step 7: Run integration and full verification**

Run:

```bash
npx vitest --run tests/deeppi.integration.test.ts
npm test
npm run typecheck
```

Expected: all commands pass; no test references `HarnessConfig`, plan mode, rewind, fuzzy matching, or `PI_HARNESS_*`.

- [x] **Step 8: Commit the final plugin core**

```bash
git add extensions tests/fake-pi.ts tests/deeppi.integration.test.ts
git commit -m "feat: wire the DeepPi performance core"
```

---

### Task 7: Finish package identity, attribution, docs, and paid smoke benchmark

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Rewrite: `README.md`
- Modify: `LICENSE`
- Create: `tests/package.test.ts`
- Create: `scripts/live-benchmark.mjs`
- Delete: `PLAN.md`
- Delete: `assets/deepseek-optimized-screenshot.png`

**Interfaces:**
- Consumes the completed plugin and `/deeppi` output.
- Produces the installable Git package, retained attribution, stale-brand regression test, and explicit live cache smoke test.

- [x] **Step 1: Write failing package identity and attribution tests**

Create `tests/package.test.ts`:

```typescript
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const extensionsDir = fileURLToPath(new URL("../extensions", import.meta.url));

describe("DeepPi package identity", () => {
	it("uses the final package and extension names", async () => {
		const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
		expect(pkg.name).toBe("deep-pi");
		expect(pkg.version).toBe("1.0.0");
		expect(pkg.pi.extensions).toEqual(["./extensions/deeppi.ts"]);
		expect(pkg.scripts["benchmark:live"]).toBe("node scripts/live-benchmark.mjs");
	});

	it("retains upstream and DeepPi copyright notices", async () => {
		const license = await readFile(new URL("../LICENSE", import.meta.url), "utf8");
		expect(license).toContain("Copyright (c) 2026, Jason Rimmer");
		expect(license).toContain("Copyright (c) 2026, Christopher Arter");
	});

	it("contains no stale runtime branding", async () => {
		const files = await readdir(new URL("../extensions", import.meta.url), { recursive: true });
		const sources = await Promise.all(files.filter((file) => file.endsWith(".ts"))
			.map((file) => readFile(join(extensionsDir, file), "utf8")));
		expect(sources.join("\n")).not.toMatch(/PI_HARNESS|deepseek-optimized|harnessPlugin/);
	});
});
```

- [x] **Step 2: Run the package test and verify current identity failures**

Run:

```bash
npx vitest --run tests/package.test.ts
```

Expected: FAIL on the old package name, version, missing DeepPi copyright, and missing benchmark script.

- [x] **Step 3: Update package metadata and the existing lockfile in place**

Set these exact `package.json` fields:

```json
{
  "name": "deep-pi",
  "version": "1.0.0",
  "description": "Direct DeepSeek cache economics, prefix stability, and retry reduction for the Pi coding agent.",
  "license": "BSD-3-Clause",
  "author": "Christopher Arter",
  "contributors": ["Jason Rimmer"],
  "repository": {
    "type": "git",
    "url": "git+https://github.com/christopherarter/deep-pi.git"
  },
  "homepage": "https://github.com/christopherarter/deep-pi#readme",
  "bugs": {
    "url": "https://github.com/christopherarter/deep-pi/issues"
  },
  "keywords": [
    "pi-package",
    "pi",
    "deepseek",
    "prompt-cache",
    "cache-telemetry",
    "hashline-editing"
  ]
}
```

Keep the current engine, peers, dev dependencies, file allowlist, and verification scripts. Add:

```json
"benchmark:live": "node scripts/live-benchmark.mjs"
```

In `package-lock.json`, change only the root `name`/`version` and `packages[""]` `name`/`version` to `deep-pi` and `1.0.0`. Do not regenerate dependencies or discard the user's current lockfile changes.

- [x] **Step 4: Update the BSD notices and replace the README with focused copy**

Keep the full BSD text and use these first two notice lines in `LICENSE`:

```text
Copyright (c) 2026, Jason Rimmer
Copyright (c) 2026, Christopher Arter
```

Rewrite `README.md` around this exact structure and claims:

````markdown
# DeepPi

Reasonix-style DeepSeek price/performance for the Pi coding agent.

DeepPi targets the direct DeepSeek API only. It stabilizes cacheable request
prefixes, reports measured cache economics from Pi's real usage records, and
reduces paid retries with loop guards and hash-verified edits.

## Supported models

- `deepseek-v4-flash`
- `deepseek-v4-pro`

DeepPi is dormant for every other provider and model.

## Install

```bash
pi install git:github.com/christopherarter/deep-pi
```

Reload Pi, select a supported direct DeepSeek model, and run `/deeppi`.

## What `/deeppi` measures

- cache-read and uncached input tokens;
- cache-hit rate;
- actual input cost from Pi;
- estimated savings against fully uncached input;
- detected local prefix churn;
- guarded retry loops and hashline edit outcomes.

DeepPi does not promise a fixed hit rate. Provider cache expiry and backend
state can produce misses even when the local request prefix is stable.

## Development

```bash
npm install --ignore-scripts
npm run verify
```

Default verification never calls an external API. The paid smoke benchmark is
explicitly opt-in:

```bash
DEEPPI_LIVE=1 npm run benchmark:live
```

## Attribution

DeepPi is derived from
[`jrimmer/pi-deepseek-optimized`](https://github.com/jrimmer/pi-deepseek-optimized)
under the BSD-3-Clause license. The original project implements techniques
described by Howard Chen and Can Akay; their credits and the original Jason
Rimmer copyright notice are retained.

DeepPi's additions are its exact direct-V4 boundary, measured Pi cache/cost
telemetry, prefix-churn diagnostics, batch-aware retry guards, atomic hashline
edits, removal of destructive rewind behavior, and tests against current Pi
event shapes.
````

Delete `PLAN.md` and the stale branded screenshot rather than shipping an inaccurate image:

```bash
git rm PLAN.md assets/deepseek-optimized-screenshot.png
```

- [x] **Step 5: Create the guarded direct-API benchmark**

Create `scripts/live-benchmark.mjs` with no imports beyond Node's standard library. Use two repeated-prefix requests per model, disabled thinking, and a 32-token output ceiling:

```javascript
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const models = ["deepseek-v4-flash", "deepseek-v4-pro"];
const prices = {
  "deepseek-v4-flash": { input: 0.14, output: 0.28 },
  "deepseek-v4-pro": { input: 1.74, output: 3.48 },
};
const maxTokens = 32;
const prefix = "DeepPi direct-cache verification prefix. ".repeat(256);

if (process.env.DEEPPI_LIVE !== "1") throw new Error("Set DEEPPI_LIVE=1 to enable paid API calls.");
const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required.");

const estimatedInputTokens = Math.ceil(prefix.length / 3);
const maximumSpend = models.reduce((sum, model) =>
  sum + (2 * estimatedInputTokens * prices[model].input + 2 * maxTokens * prices[model].output) / 1_000_000,
0);
console.log(`Models: ${models.join(", ")}`);
console.log("Requests: 4");
console.log(`Output ceiling: ${maxTokens} tokens/request`);
console.log(`Estimated maximum spend at current documented prices: $${maximumSpend.toFixed(4)}`);

if (process.env.DEEPPI_LIVE_CONFIRM !== "I_ACCEPT_COST") {
  const terminal = createInterface({ input, output });
  const answer = await terminal.question("Type YES to send paid requests: ");
  terminal.close();
  if (answer !== "YES") throw new Error("Cancelled before sending requests.");
}

async function complete(model, messages) {
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, thinking: { type: "disabled" } }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${model} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

let failed = false;
for (const model of models) {
  const messages = [
    { role: "system", content: prefix },
    { role: "user", content: "Reply with exactly OK." },
  ];
  const first = await complete(model, messages);
  const second = await complete(model, [
    ...messages,
    first.choices[0].message,
    { role: "user", content: "Reply with exactly OK again." },
  ]);
  const hit = second.usage?.prompt_cache_hit_tokens ?? 0;
  const miss = second.usage?.prompt_cache_miss_tokens ?? 0;
  console.log(`${model}: hit=${hit} miss=${miss}`);
  if (hit === 0) failed = true;
}
if (failed) throw new Error("At least one model reported zero cache-hit tokens on its repeated-prefix request.");
```

The script may contain only this direct API host and must never print the API key or authorization header.

- [x] **Step 6: Run package and default release verification**

Run:

```bash
npx vitest --run tests/package.test.ts
npm run verify
npm pack --dry-run
git diff --check
rg -n 'PI_HARNESS|deepseek-optimized|harnessPlugin|PlanMode|RewindState' extensions tests package.json package-lock.json
```

Expected:

- package test and `npm run verify` pass;
- `git diff --check` prints nothing;
- stale runtime-brand scan returns no matches;
- `npm pack --dry-run` lists `extensions/deeppi.ts`, `extensions/deeppi/`, `README.md`, `LICENSE`, and `tsconfig.json`, with no `PLAN.md`, stale screenshot, test, or benchmark script.

Confirm the one intentional upstream name remains in attribution:

```bash
rg -n 'jrimmer/pi-deepseek-optimized' README.md
```

Expected: exactly one attribution match.

- [x] **Step 7: Commit package completion**

```bash
git add package.json package-lock.json README.md LICENSE tests/package.test.ts scripts/live-benchmark.mjs
git add -u PLAN.md assets/deepseek-optimized-screenshot.png
git commit -m "feat: publish the DeepPi package identity"
```

- [x] **Step 8: Record final handoff evidence**

Run:

```bash
git status --short --branch
git log -8 --oneline
npm run verify
```

Expected: only the pre-existing `.pi-subagents/` remains untracked; the recent history contains the approved design plus the seven task commits; verification passes without network access.
