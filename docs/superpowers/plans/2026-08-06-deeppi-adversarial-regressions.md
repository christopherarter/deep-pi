# DeepPi Adversarial Regression Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add nine deterministic tests that expose the reviewed DeepPi correctness bugs and remain red until production code fixes them.

**Architecture:** Extend the four existing module test files. Exercise exported functions directly where that is the real boundary, and capture Pi hooks where the bug depends on Pi's event contract. Make no production-code changes.

**Tech Stack:** TypeScript, Vitest, Node.js `fs/promises`, Pi `ExtensionAPI` types.

## Global Constraints

- Add tests only; do not modify `extensions/`, dependencies, package metadata, or existing assertions.
- Add exactly nine regression cases: two stability, one telemetry, two stormbreaker, and four hashlines.
- A correct handoff is intentionally red: `npm run typecheck` passes, 34 existing tests pass, and the nine new assertions fail for their stated reason.
- Use only local deterministic inputs and temporary files. No network, timers, sleeps, or race-dependent scheduling.
- Preserve `.pi-subagents/` untouched and untracked.
- Prefix shell commands with `rtk` per the repository instructions.

---

### Task 1: Add the nine red regression tests

**Files:**

- Modify: `tests/stability.test.ts`
- Modify: `tests/telemetry.test.ts`
- Modify: `tests/stormbreaker.test.ts`
- Modify: `tests/hashlines.test.ts`

- [ ] **Step 1: Add the two stability regressions**

Add the Pi API type and hook exports to `tests/stability.test.ts`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createStabilityState,
	freezeSessionTimestamps,
	registerStabilityHooks,
	stabilizeMessages,
	type TimestampState,
} from "../extensions/deeppi/stability.js";
```

Append these tests:

```ts
it("returns pruned messages through Pi's context result contract", async () => {
	type Hook = (event: any, ctx: any) => Promise<any> | any;
	const hooks = new Map<string, Hook>();
	const pi = {
		on(type: string, hook: Hook) { hooks.set(type, hook); },
	} as unknown as ExtensionAPI;
	const state = createStabilityState();
	registerStabilityHooks(pi, state, () => true);
	const messages = [{
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "private" },
			{ type: "text", text: "answer" },
		],
	}];
	const result = await hooks.get("context")!({ messages }, {
		model: { provider: "deepseek", id: "deepseek-v4-pro" },
	});
	const nextMessages = result?.messages ?? messages;
	expect(nextMessages[0].content).toEqual([{ type: "text", text: "answer" }]);
});

it("does not freeze generic user-authored Date lines", () => {
	const state: TimestampState = { frozenLines: new Map() };
	freezeSessionTimestamps("Date: release-candidate-1", state);
	expect(freezeSessionTimestamps("Date: release-candidate-2", state))
		.toBe("Date: release-candidate-2");
});
```

The first test must reproduce Pi's actual chaining rule: only a returned `{ messages }` value changes the next context. Do not inspect the mutated event object.

Run:

```bash
rtk npx vitest --run tests/stability.test.ts
```

Expected: the two new tests fail. The existing stability tests pass. The first failure retains the thinking block; the second returns `Date: release-candidate-1`.

- [ ] **Step 2: Add the provider-scoping telemetry regression**

Add the Pi API type and `registerTelemetryHooks` import to `tests/telemetry.test.ts`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	cacheHitRate,
	createTelemetryState,
	footerText,
	recordUsage,
	registerTelemetryHooks,
} from "../extensions/deeppi/telemetry.js";
```

Append this test:

```ts
it("ignores supported-looking model IDs from unsupported providers", async () => {
	type Hook = (event: any, ctx: any) => Promise<any> | any;
	const hooks = new Map<string, Hook>();
	const pi = {
		on(type: string, hook: Hook) { hooks.set(type, hook); },
	} as unknown as ExtensionAPI;
	const state = createTelemetryState();
	registerTelemetryHooks(pi, state, () => {});
	await hooks.get("message_end")!({
		message: {
			role: "assistant",
			provider: "openrouter",
			model: "deepseek-v4-pro",
			usage: {
				input: 10,
				output: 1,
				cacheRead: 20,
				cacheWrite: 0,
				totalTokens: 31,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	}, {
		model: { provider: "openrouter", id: "deepseek-v4-pro" },
	});
	expect(state.byModel["deepseek-v4-pro"].responses).toBe(0);
});
```

Run:

```bash
rtk npx vitest --run tests/telemetry.test.ts
```

Expected: the new test fails with one response recorded. Existing telemetry tests pass.

- [ ] **Step 3: Add the two stormbreaker regressions**

Append this small capture helper and the tests to `tests/stormbreaker.test.ts`:

```ts
function captureStormBreakerHooks() {
	type Hook = (event: any, ctx: any) => Promise<any> | any;
	const hooks = new Map<string, Hook>();
	const pi = {
		on(type: string, hook: Hook) { hooks.set(type, hook); },
	} as unknown as ExtensionAPI;
	registerStormBreaker(pi, createStormBreakerState(), () => true);
	return hooks;
}

it("ends a blocked streak when an assistant turn makes no tool calls", async () => {
	const hooks = captureStormBreakerHooks();
	let aborted = false;
	const ctx = {
		model: { provider: "deepseek", id: "deepseek-v4-pro" },
		abort() { aborted = true; },
		ui: { notify() {} },
	};
	const failedTool = async () => {
		await hooks.get("message_end")!({
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }],
			},
		}, ctx);
		return hooks.get("tool_result")!({
			toolCallId: "a",
			toolName: "read",
			isError: true,
			content: [{ type: "text", text: "missing" }],
		}, ctx);
	};
	await failedTool();
	await failedTool();
	await hooks.get("message_end")!({
		message: { role: "assistant", content: [{ type: "text", text: "new task" }] },
	}, ctx);
	const unrelatedResult = await failedTool();
	expect(JSON.stringify(unrelatedResult)).not.toContain("[loop guard]");
	expect(aborted).toBe(false);
});

it("preserves actionable error text beyond 500 characters", async () => {
	const hooks = captureStormBreakerHooks();
	const ctx = {
		model: { provider: "deepseek", id: "deepseek-v4-pro" },
		abort() {},
		ui: { notify() {} },
	};
	await hooks.get("message_end")!({
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }],
		},
	}, ctx);
	const originalContent = [{
		type: "text",
		text: `${"x".repeat(600)}ACTIONABLE_TAIL`,
	}];
	const result = await hooks.get("tool_result")!({
		toolCallId: "a",
		toolName: "read",
		isError: true,
		content: originalContent,
	}, ctx);
	const visibleContent = result?.content ?? originalContent;
	expect(JSON.stringify(visibleContent)).toContain("ACTIONABLE_TAIL");
});
```

Run:

```bash
rtk npx vitest --run tests/stormbreaker.test.ts
```

Expected: both new tests fail. The unrelated third failure receives `[loop guard]`, and the returned error content omits `ACTIONABLE_TAIL`. Existing stormbreaker tests pass.

- [ ] **Step 4: Add the four hashline regressions**

Extend the imports in `tests/hashlines.test.ts`:

```ts
import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import {
	atomicWriteFile,
	registerHashlines,
	validateEdits,
} from "../extensions/deeppi/hashlines.js";
```

Append these tests:

```ts
it("rejects overlapping edit ranges", () => {
	const lines = ["A", "B", "C"];
	const error = validateEdits(lines, [
		{ from: 1, from_hash: lineHash("A"), to: 2, to_hash: lineHash("B"), new_text: "X" },
		{ from: 2, from_hash: lineHash("B"), to: 3, to_hash: lineHash("C"), new_text: "Y" },
	]);
	expect(error).toMatch(/overlap/i);
});

it("does not replace a symlink while leaving its target stale", async () => {
	const dir = await mkdtemp(join(tmpdir(), "deeppi-hashlines-"));
	created.push(dir);
	const target = join(dir, "target.ts");
	const link = join(dir, "link.ts");
	await writeFile(target, "old\n");
	await symlink(target, link);
	let rejected = false;
	try {
		await atomicWriteFile(link, "new\n");
	} catch {
		rejected = true;
	}
	expect((await lstat(link)).isSymbolicLink()).toBe(true);
	expect(await readFile(target, "utf8")).toBe(rejected ? "old\n" : "new\n");
});

it("rejects an atomic replacement when the source changed since validation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "deeppi-hashlines-"));
	created.push(dir);
	const path = join(dir, "sample.ts");
	await writeFile(path, "snapshot\n");
	const snapshot = await readFile(path, "utf8");
	await writeFile(path, "newer external content\n");
	type GuardedAtomicWrite = (path: string, content: string, expectedContent: string) => Promise<void>;
	let rejected = false;
	try {
		await (atomicWriteFile as GuardedAtomicWrite)(path, "agent edit\n", snapshot);
	} catch {
		rejected = true;
	}
	expect(rejected).toBe(true);
	expect(await readFile(path, "utf8")).toBe("newer external content\n");
});

it("does not give known distinct line content the same hash", () => {
	expect(lineHash("critical setting = false"))
		.not.toBe(lineHash("critical setting = true # 7571"));
});
```

The symlink assertion permits either safe behavior: follow and update the target while preserving the link, or reject without changing either object. It forbids replacing the link itself. The guarded-write cast intentionally describes the smallest required API extension; the current two-argument function ignores the third argument and fails the test without a type error.

Run:

```bash
rtk npx vitest --run tests/hashlines.test.ts
```

Expected: all four new tests fail. Existing hashline tests pass.

- [ ] **Step 5: Verify the intentional red handoff**

Run type checking:

```bash
rtk npm run typecheck
```

Expected: exit 0.

Run the focused suites:

```bash
rtk npx vitest --run tests/stability.test.ts tests/telemetry.test.ts tests/stormbreaker.test.ts tests/hashlines.test.ts
```

Expected: exactly nine failed tests, all matching the assertions above. No uncaught exceptions, type failures, missing hooks, or cleanup failures.

Run the full suite:

```bash
rtk npm test
```

Expected: exit nonzero with exactly 34 passed and nine failed tests. Record this as the desired handoff state; do not weaken assertions or change production code to make it green.

- [ ] **Step 6: Commit the red regression suite**

Inspect scope:

```bash
rtk git status --short
rtk git diff --check
rtk git diff -- tests/stability.test.ts tests/telemetry.test.ts tests/stormbreaker.test.ts tests/hashlines.test.ts docs/superpowers/plans/2026-08-06-deeppi-adversarial-regressions.md
```

Stage only the plan and four test files, leaving `.pi-subagents/` untouched:

```bash
rtk git add docs/superpowers/plans/2026-08-06-deeppi-adversarial-regressions.md tests/stability.test.ts tests/telemetry.test.ts tests/stormbreaker.test.ts tests/hashlines.test.ts
rtk git commit -m "test: expose DeepPi correctness regressions"
```

Handoff with the commit hash, the nine failing test names, and the two loop commands:

```bash
rtk npm run typecheck
rtk npm test
```

The fixing agent's completion condition is both commands exiting 0 without modifying or deleting these regression assertions.
