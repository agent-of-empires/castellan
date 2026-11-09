import { describe, expect, it } from "vitest";
import type { OkReviewResult, ReviewResult } from "../src/llm.js";
import type { Decision } from "../src/rules.js";
import { decide } from "../src/verdict.js";

const candidate: Decision = { outcome: "candidate", reasons: [] };
const review = (
	over: Partial<OkReviewResult["verdict"]> = {},
): OkReviewResult => ({
	ok: true,
	verdict: { intent_match: true, new_behavior: false, reasons: [], ...over },
	usage: { inputTokens: 1, outputTokens: 1 },
	costUsd: 0,
	promptHash: "p",
});

describe("decide", () => {
	it("posts nothing for skip", () => {
		expect(decide({ outcome: "skip", reasons: [] }, review())).toBeNull();
	});

	it("keeps rule escalations whatever the model says", () => {
		const d: Decision = {
			outcome: "escalate",
			reasons: [{ rule: "max_lines", text: "too big" }],
		};
		expect(decide(d, review())).toEqual({
			verdict: "escalate",
			reasons: d.reasons,
		});
	});

	it("merges a clean candidate", () => {
		expect(decide(candidate, review())).toEqual({
			verdict: "merge",
			reasons: [],
		});
	});

	it("merges despite concerns and nits", () => {
		const r = review({
			reasons: [
				{ severity: "concern", text: "c" },
				{ severity: "nit", text: "n" },
			],
		});
		expect(decide(candidate, r)?.verdict).toBe("merge");
	});

	it.each([
		["intent mismatch", { intent_match: false }],
		["new behavior", { new_behavior: true }],
		["blocker", { reasons: [{ severity: "blocker" as const, text: "b" }] }],
	])("downgrades a candidate on %s", (_n, over) => {
		const o = decide(candidate, review(over));
		expect(o?.verdict).toBe("escalate");
		expect(o?.reasons.length).toBeGreaterThan(0);
	});

	it("fails closed when the model failed or did not run", () => {
		const failed: ReviewResult = {
			ok: false,
			error: "timeout",
			detail: "raw secret",
			promptHash: "p",
		};
		for (const r of [failed, undefined]) {
			const o = decide(candidate, r);
			expect(o?.verdict).toBe("escalate");
			expect(JSON.stringify(o)).not.toContain("raw secret");
		}
	});

	it("never emits send_back", () => {
		const outcomes: Decision["outcome"][] = ["skip", "escalate", "candidate"];
		for (const outcome of outcomes) {
			for (const r of [review(), review({ new_behavior: true }), undefined]) {
				expect(decide({ outcome, reasons: [] }, r)?.verdict).not.toBe(
					"send_back",
				);
			}
		}
	});
});
