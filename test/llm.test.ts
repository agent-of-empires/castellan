import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import type { LlmDeps, MessagesClient } from "../src/llm.js";
import { buildSystemPrompt, review } from "../src/llm.js";

const input = { title: "fix: x", body: "Closes #1", diff: "+a" };

async function cfg(yaml = "") {
	const r = await loadConfig("main", async () => yaml);
	if (!r.ok) throw new Error(r.error);
	return r.config;
}

const good = {
	intent_match: true,
	new_behavior: false,
	reasons: [{ severity: "nit", text: "typo", path: "a.ts" }],
};

function fake(text: string | Error) {
	const create = vi.fn(async (_p: unknown, _o?: unknown) => {
		if (text instanceof Error) throw text;
		return { content: [{ type: "text", text }] };
	});
	return {
		create,
		client: { messages: { create } } as unknown as MessagesClient,
	};
}

describe("buildSystemPrompt", () => {
	it("renders base then numbered guidance", async () => {
		const p = buildSystemPrompt(
			await cfg("prompt: { base: be strict, guidance: [a, b] }"),
		);
		expect(p.startsWith("be strict\n\n1. a\n2. b\n\n")).toBe(true);
	});
});

describe("review", () => {
	it("returns a validated verdict and uses the review model", async () => {
		const { create, client } = fake(JSON.stringify(good));
		const r = await review(input, await cfg(), { client });
		expect(r).toEqual({ ok: true, verdict: good });
		expect(create.mock.calls[0]?.[0]).toMatchObject({
			model: "claude-sonnet-5-5",
		});
	});

	it("accepts JSON wrapped in a code fence", async () => {
		const { client } = fake(`\`\`\`json\n${JSON.stringify(good)}\n\`\`\``);
		expect(await review(input, await cfg(), { client })).toMatchObject({
			ok: true,
		});
	});

	it.each([
		["prose", "no json here"],
		["bad json", "{nope}"],
		["missing key", JSON.stringify({ intent_match: true, reasons: [] })],
		[
			"bad severity",
			JSON.stringify({ ...good, reasons: [{ severity: "x", text: "t" }] }),
		],
	])("fails closed on %s", async (_n, text) => {
		const { client } = fake(text);
		expect(await review(input, await cfg(), { client })).toMatchObject({
			ok: false,
		});
	});

	it("fails closed on timeout or SDK error", async () => {
		const { client } = fake(new Error("Request timed out."));
		expect(await review(input, await cfg(), { client })).toMatchObject({
			ok: false,
			error: expect.stringContaining("timed out"),
		});
	});

	it("skips the call when the budget is exhausted", async () => {
		const { create, client } = fake(JSON.stringify(good));
		const deps: LlmDeps = { client, budgetExhausted: async () => true };
		expect(await review(input, await cfg(), deps)).toEqual({
			ok: false,
			error: "monthly budget exhausted",
		});
		expect(create).not.toHaveBeenCalled();
	});

	it("fails closed when the anthropic provider has no key", async () => {
		const config = await cfg("llm: { provider: anthropic }");
		expect(await review(input, config)).toEqual({
			ok: false,
			error: "missing Anthropic API key",
		});
	});
});
