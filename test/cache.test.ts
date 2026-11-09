import { describe, expect, it, vi } from "vitest";
import {
	type CacheBlock,
	getOrRun,
	parseBlock,
	serializeBlock,
} from "../src/cache.js";
import type { ReviewResult } from "../src/llm.js";

const ok: Extract<ReviewResult, { ok: true }> = {
	ok: true,
	verdict: {
		intent_match: true,
		new_behavior: false,
		reasons: [{ severity: "nit", text: "a --> b <!-- c", path: "src/a.ts" }],
	},
	usage: { inputTokens: 10, outputTokens: 5 },
	costUsd: 0.01,
	promptHash: "p1",
};
const key = { headSha: "abc", promptHash: "p1", model: "m1" };
const block: CacheBlock = { verdict: "merge", ...key, llm: ok };

describe("block format", () => {
	it("round-trips inside a comment body", () => {
		const body = `## Castellan\n\nbrief\n\n${serializeBlock(block)}`;
		expect(parseBlock(body)).toEqual(block);
	});

	it("keeps model text from closing the comment early", () => {
		expect(serializeBlock(block).match(/-->/g)).toHaveLength(1);
	});

	it("round-trips a block without an llm result", () => {
		const b: CacheBlock = { verdict: "escalate", ...key };
		expect(parseBlock(serializeBlock(b))).toEqual(b);
	});

	it.each([
		["no block", "just text"],
		["bad json", "<!-- castellan {nope} -->"],
		["wrong shape", '<!-- castellan {"verdict":"merge"} -->'],
		[
			"failed llm result",
			`<!-- castellan ${JSON.stringify({ ...block, llm: { ok: false, error: "timeout", promptHash: "p1" } })} -->`,
		],
	])("returns null for %s", (_n, body) => {
		expect(parseBlock(body)).toBeNull();
	});
});

describe("getOrRun", () => {
	const run = () => vi.fn(async (): Promise<ReviewResult> => ok);

	it("hits the cache on matching key and skips the call", async () => {
		const fn = run();
		const r = await getOrRun({
			cached: block,
			key,
			ruleEscalated: false,
			run: fn,
		});
		expect(r).toEqual({ source: "cache", result: ok });
		expect(fn).not.toHaveBeenCalled();
	});

	it.each([
		["headSha", { headSha: "def" }],
		["promptHash", { promptHash: "p2" }],
		["model", { model: "m2" }],
	])("runs fresh when %s changes", async (_n, change) => {
		const fn = run();
		const r = await getOrRun({
			cached: block,
			key: { ...key, ...change },
			ruleEscalated: false,
			run: fn,
		});
		expect(r.source).toBe("llm");
		expect(fn).toHaveBeenCalledOnce();
	});

	it("runs when there is no cached block or no cached llm result", async () => {
		const fn = run();
		const none = { cached: null, key, ruleEscalated: false, run: fn };
		await getOrRun(none);
		await getOrRun({ ...none, cached: { verdict: "escalate", ...key } });
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("passes a failed result through for the caller to escalate", async () => {
		const failed: ReviewResult = {
			ok: false,
			error: "timeout",
			promptHash: "p1",
		};
		const r = await getOrRun({
			cached: null,
			key,
			ruleEscalated: false,
			run: async () => failed,
		});
		expect(r).toEqual({ source: "llm", result: failed });
	});

	it("never calls the LLM for rule-escalated PRs, even with no cache", async () => {
		const fn = run();
		const r = await getOrRun({
			cached: null,
			key,
			ruleEscalated: true,
			run: fn,
		});
		expect(r).toEqual({ source: "skipped" });
		expect(fn).not.toHaveBeenCalled();
	});
});
