# DeepPi Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove orphanable lock files and wall-clock waits, make writer tests deterministic, and reduce line-anchor prompt overhead without restoring the known collision bug.

**Architecture:** Use a module-local keyed promise queue for cooperating writes. Prepare temporary content before queueing, validate the current snapshot immediately before replacement, and retain post-replacement verification. Use eight hexadecimal SHA-256 characters for exact-line anchors.

**Tech Stack:** TypeScript, Node.js `fs/promises`, Vitest.

## Global Constraints

- Prefix every shell command with `rtk`.
- Use test-driven development: add or amend a regression, run it red, implement the minimum fix, then run it green.
- Add no runtime dependency and no filesystem lock artifact.
- Serialize calls to `atomicWriteFile` for the same absolute path within one process; different paths may proceed independently.
- Do not claim atomic compare-and-swap safety against writers outside the process.
- Use exactly eight lowercase hexadecimal characters for line hashes and every annotation/schema/prompt example.
- Preserve symlink rejection, file modes, temporary-file cleanup, snapshot rejection, and post-rename verification.

---

### Task 1: Replace sidecar locking with deterministic process-local serialization

**Files:**

- Modify: `extensions/deeppi/hashlines.ts`
- Modify: `tests/review2.test.ts`

**Interfaces:**

- Preserve: `atomicWriteFile(path: string, content: string, expectedContent?: string): Promise<void>`
- Produce: same-path calls execute their validation-and-rename sections in invocation order without creating `<path>.lock`.

- [ ] **Step 1: Make the concurrency regression deterministic and red**

Replace the 50 ms sleep with a promise resolved by the mocked first rename.
Assert the second write remains unsettled until the first is released, then
rejects because its `expectedContent` is stale. Also assert no `.lock` path is
created. The core shape is:

```ts
let entered!: () => void;
const renameEntered = new Promise<void>((resolve) => { entered = resolve; });
renameMock.mockImplementationOnce(async (from, to) => {
	entered();
	await gate;
	await testState.realRename(from, to);
});
const first = atomicWriteFile(path, "first writer\n", "snapshot\n");
await renameEntered;
let secondSettled = false;
const second = atomicWriteFile(path, "second writer\n", "snapshot\n")
	.finally(() => { secondSettled = true; });
await Promise.resolve();
expect(secondSettled).toBe(false);
release();
await first;
await expect(second).rejects.toThrow(/changed/i);
```

Add a second regression which creates `<path>.lock` with sentinel content,
runs `atomicWriteFile`, then proves the write succeeded and the sentinel was
untouched.

Run:

```bash
rtk npx vitest --run tests/review2.test.ts
```

Expected before implementation: the concurrency assertion receives a lock
timeout, or the sentinel test times out and rejects.

- [ ] **Step 2: Implement the minimum queue-based writer**

Remove `LOCK_RETRY_MS`, `LOCK_TIMEOUT_MS`, and `acquireLock`. Add a module-local
`Map<string, Promise<void>>` and a helper with this behavior:

```ts
const writeQueues = new Map<string, Promise<void>>();

async function withWriteQueue<T>(path: string, work: () => Promise<T>): Promise<T> {
	const previous = writeQueues.get(path) ?? Promise.resolve();
	let release!: () => void;
	const turn = new Promise<void>((resolve) => { release = resolve; });
	const tail = previous.catch(() => undefined).then(() => turn);
	writeQueues.set(path, tail);
	await previous.catch(() => undefined);
	try {
		return await work();
	} finally {
		release();
		if (writeQueues.get(path) === tail) writeQueues.delete(path);
	}
}
```

In `atomicWriteFile`, create/write/fsync/close the unique temporary file with
mode `0o600` before `withWriteQueue`. Inside the queued callback, `lstat` and
reject symlinks, read and compare `expectedContent`, apply the current target
mode to the temporary file, rename, and perform the existing landed-content
check. Always unlink a still-created temporary file in the outer `finally`.

Run the focused test until green, then:

```bash
rtk npx vitest --run tests/hashlines.test.ts tests/review2.test.ts
rtk npm run typecheck
```

- [ ] **Step 3: Self-review and commit**

Confirm no `.lock` creation, `Date.now`, lock timeout, or arbitrary sleep
remains in the changed writer path and tests. Run `rtk git diff --check`, then
commit only this task's production and test files.

---

### Task 2: Use price-conscious 32-bit line anchors

**Files:**

- Modify: `extensions/deeppi/utils.ts`
- Modify: `extensions/deeppi/hashlines.ts`
- Modify: `tests/review2.test.ts`

**Interfaces:**

- Preserve: `lineHash(line: string): string`
- Produce: exactly eight lowercase hexadecimal characters derived from SHA-256.

- [ ] **Step 1: Change the width regression and run it red**

Change the annotation test to require eight characters and reject both the old
four-character and current sixteen-character forms:

```ts
expect(annotateLine(1, "alpha")).toMatch(/^\s*1:[0-9a-f]{8}\u2192alpha$/);
expect(isAnnotated("    1:a1b2c3d4\u2192x")).toBe(true);
expect(isAnnotated("    1:a1b2\u2192x")).toBe(false);
expect(isAnnotated("    1:a1b2c3d4e5f60718\u2192x")).toBe(false);
```

Keep the known-collision assertions. Run:

```bash
rtk npx vitest --run tests/review2.test.ts
```

Expected before implementation: the new eight-character assertions fail.

- [ ] **Step 2: Implement the width change**

Change `lineHash` to `.slice(0, 8)`, change `ANNOTATED_RE` to exactly eight
lowercase hexadecimal characters, and update every changed comment, schema
description, prompt format, error-help format, and example hash from sixteen to
eight characters. Do not change the SHA-256 input normalization.

Run:

```bash
rtk npx vitest --run tests/hashlines.test.ts tests/review2.test.ts
rtk npm run typecheck
```

- [ ] **Step 3: Verify and commit**

Search the production files and test for stale `16-char`, sixteen-`H` formats,
and sixteen-character example hashes. Run `rtk git diff --check`, then commit
only this task's files.

---

### Task 3: Integrated verification and adversarial review

**Files:** No intended production changes; fix only confirmed regressions found by this task.

- [ ] **Step 1: Run the full verification gate**

```bash
rtk npm run typecheck
rtk npm test
rtk npm pack --dry-run --cache /tmp/deeppi-review-fixes-npm-cache
rtk git diff --check a37103b..HEAD
rtk git status --short
```

- [ ] **Step 2: Re-run direct writer scenarios**

Verify a stale `.lock` sentinel is ignored, same-path writers serialize, and
different-path writers do not share a queue. Confirm temporary files are
removed after both success and failure.

- [ ] **Step 3: Review the integrated diff**

Review `a37103b..HEAD` for spec compliance, concurrency/error-path regressions,
unnecessary abstraction, and stale 16-character documentation. Fix only
confirmed issues, rerun the full gate, and commit any review fixes separately.
