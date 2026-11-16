import type { Config } from "./config.js";
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
 * A failed review fails closed. Returns null for `skip` and `wait`: nothing is posted.
 */
export function decide(
	decision: Decision,
	review?: ReviewResult,
	size: Config["size"] = "fixed",
): Outcome | null {
	if (decision.outcome === "skip" || decision.outcome === "wait") return null;
	if (decision.outcome === "escalate") {
		return { verdict: "escalate", reasons: decision.reasons };
	}
	if (!review?.ok) {
		return {
			verdict: "escalate",
			reasons: [model("llm_unavailable", "model review unavailable")],
		};
	}
	const { intent_match, new_behavior, escalate, escalation, reasons } =
		review.verdict;
	// `size: off` means the repo asked for no size judgement at all, so the model's
	// answer is not read. `fixed` and `model` both honour it: it can only withhold
	// a merge.
	const vetoes = [
		...(escalate && size !== "off"
			? [model("llm_escalate", escalation ?? "change needs a human review")]
			: []),
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
			.map((r) => ({
				...model("llm_blocker", r.text),
				path: r.path,
				line: r.line,
			})),
	];
	return vetoes.length
		? { verdict: "escalate", reasons: vetoes }
		: { verdict: "merge", reasons: [] };
}
