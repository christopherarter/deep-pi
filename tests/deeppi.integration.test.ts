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
