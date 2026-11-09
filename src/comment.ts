/**
 * The sticky comment is a decision record: the verdict line stays at the top, the
 * hidden state block is always last, and the whole body stays under BODY_LIMIT.
 */
import { type CacheKey, serializeBlock } from "./cache.js";
import type { OkReviewResult } from "./llm.js";
import type { Snapshot } from "./snapshot.js";
import type { Outcome } from "./verdict.js";

export const MAX_REASONS = 3;
export const MAX_CHECKS = 50;
export const MAX_REASON_CHARS = 500;
/** GitHub rejects comment bodies of 65536 characters or more. */
export const BODY_LIMIT = 65_000;

// Escapes, not literal characters, so the source itself holds no dashes (U+2012 to U+2015, U+2212).
const DASHES = /[\u2012-\u2015\u2212]/g;

export interface Brief {
	outcome: Outcome;
	key: CacheKey;
	checks: Snapshot["checks"];
	/** Absent when the model did not run or failed. */
	review?: OkReviewResult;
	/** `cache` means `review.costUsd` was paid by an earlier run. */
	source: "cache" | "llm" | "skipped";
	/** Plain team slug; never rendered as a mention. */
	ownerTeam?: string;
}

/** Makes untrusted text inert in a GitHub comment: no mentions, links, URLs, HTML or dashes. */
export function escapeText(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(DASHES, "-")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/(?:https?:\/\/|www\.)\S+/gi, "[url removed]")
		.replace(/@/g, "")
		.replace(/</g, "&lt;")
		.replace(/\s+/g, " ")
		.trim();
}

const reason = (text: string) => escapeText(text.slice(0, MAX_REASON_CHARS));
const cell = (text: string) => escapeText(text).replace(/[\\|]/g, "\\$&");
const at = (path?: string) =>
	path ? ` (\`${reason(path).replace(/`/g, "")}\`)` : "";
const yesNo = (b: boolean) => (b ? "yes" : "no");

function conformance({ review }: Brief): string[] {
	if (!review) return ["- Not evaluated by the model."];
	const { intent_match, new_behavior } = review.verdict;
	return [
		`- Matches the linked issue and description: ${yesNo(intent_match)}`,
		`- Adds behavior beyond the request: ${yesNo(new_behavior)}`,
	];
}

function correctness({ review }: Brief): string[] {
	if (!review) return ["- Not evaluated by the model."];
	const items = review.verdict.reasons.map(
		(r) => `- [ ] **${r.severity}** ${escapeText(r.text)}${at(r.path)}`,
	);
	return items.length ? items : ["- No findings."];
}

function evidence({ checks }: Brief): string[] {
	if (!checks.length) return ["No check runs on the head commit."];
	return [
		"| Check | Conclusion |",
		"| --- | --- |",
		...checks
			.slice(0, MAX_CHECKS)
			.map((c) => `| ${cell(c.name)} | ${cell(c.conclusion)} |`),
		...(checks.length > MAX_CHECKS
			? ["", `+${checks.length - MAX_CHECKS} more checks`]
			: []),
	];
}

function provenance({ key, review, source }: Brief): string[] {
	const cost =
		source === "llm" && review ? `, cost ${review.costUsd.toFixed(4)} USD` : "";
	return [
		`- Head: \`${key.headSha.slice(0, 7)}\``,
		`- Model: \`${escapeText(key.model)}\`, prompt \`${key.promptHash.slice(0, 12)}\``,
		`- Source: ${source}${cost}`,
	];
}

export function renderComment(brief: Brief): string {
	const { outcome, key, review, ownerTeam } = brief;
	const shown = outcome.reasons.slice(0, MAX_REASONS);
	const more = outcome.reasons.length - shown.length;
	const head = [
		"## Castellan brief",
		"",
		`**Verdict: ${outcome.verdict}**${ownerTeam ? ` | Owner team: ${escapeText(ownerTeam)}` : ""}`,
		"",
		...(shown.length
			? [
					...shown.map((r, i) => `${i + 1}. ${reason(r.text)}${at(r.path)}`),
					...(more > 0 ? [`(+${more} more)`] : []),
					"",
				]
			: []),
		"### Conformance",
		...conformance(brief),
		"",
		"### Correctness",
	];
	const tail = [
		"",
		"### Evidence",
		...evidence(brief),
		"",
		"### Provenance",
		...provenance(brief),
		"",
	];
	const { promptHash: _h, ...llm } = review ?? {};
	const block = serializeBlock({
		verdict: outcome.verdict,
		...key,
		...(review && { llm: llm as Omit<OkReviewResult, "promptHash"> }),
	});

	// Last resort: drop findings so the block always survives intact and last.
	const findings = correctness(brief);
	const fixed = [...head, ...tail].join("\n").length + block.length + 2;
	const kept: string[] = [];
	let used = fixed + 80;
	for (const line of findings) {
		if (used + line.length + 1 > BODY_LIMIT) break;
		kept.push(line);
		used += line.length + 1;
	}
	if (kept.length < findings.length) {
		kept.push(`(+${findings.length - kept.length} more findings omitted)`);
	}
	return `${[...head, ...kept, ...tail].join("\n")}\n${block}`;
}
