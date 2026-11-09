import type { ReviewResult } from "./llm.js";
import type { Decision, Reason } from "./rules.js";

/** `send_back` is reserved and never emitted in v1. */
export type Verdict = "merge" | "escalate" | "send_back";

export interface Outcome {
	verdict: Exclude<Verdict, "send_back">;
	reasons: Reason[];
}

const model = (rule: string, text: string): Reason => ({ rule, text });

/**
 * Rules decide; the model can only turn a `candidate` into `escalate`.
 * A failed review fails closed. Returns null for `skip`: nothing is posted.
 */
export function decide(
	decision: Decision,
	review?: ReviewResult,
): Outcome | null {
	if (decision.outcome === "skip") return null;
	if (decision.outcome === "escalate") {
		return { verdict: "escalate", reasons: decision.reasons };
	}
	if (!review?.ok) {
		return {
			verdict: "escalate",
			reasons: [model("llm_unavailable", "model review unavailable")],
		};
	}
	const { intent_match, new_behavior, reasons } = review.verdict;
	const vetoes = [
		...(intent_match
			? []
			: [
					model(
						"llm_intent",
						"change does not match the linked issue or description",
					),
				]),
		...(new_behavior
			? [
					model(
						"llm_new_behavior",
						"change adds behavior beyond what was asked",
					),
				]
			: []),
		...reasons
			.filter((r) => r.severity === "blocker")
			.map((r) => ({ ...model("llm_blocker", r.text), path: r.path })),
	];
	return vetoes.length
		? { verdict: "escalate", reasons: vetoes }
		: { verdict: "merge", reasons: [] };
}
