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
