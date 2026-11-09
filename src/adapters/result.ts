import type { PullResult } from "../pipeline.js";
import type { TriageResult } from "../triage.js";

export interface Item {
	kind: "pr" | "issue";
	number: number;
	result?: PullResult | TriageResult | "closed";
	error?: string;
}

/** True when the run should exit non-zero: an item threw, or triage reported a failure. */
export const failed = (i: Item) =>
	i.error !== undefined ||
	(typeof i.result === "object" && "ok" in i.result && !i.result.ok);
