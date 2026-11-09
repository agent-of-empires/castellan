import { type CacheKey, serializeBlock } from "./cache.js";
import type { OkReviewResult } from "./llm.js";
import type { Snapshot } from "./snapshot.js";
import type { Outcome } from "./verdict.js";

export const MAX_REASONS = 3;

// Built from a string so the source itself holds no dash characters.
const DASHES = /[\u2013\u2014]/g;

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
		.replace(DASHES, "-")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/(?:https?:\/\/|www\.)\S+/gi, "[url removed]")
		.replace(/@/g, "")
		.replace(/</g, "&lt;")
		.replace(/\s+/g, " ")
		.trim();
}

const cell = (text: string) => escapeText(text).replace(/\|/g, "\\|");
const at = (path?: string) =>
	path ? ` (\`${escapeText(path).replace(/`/g, "")}\`)` : "";
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
		...checks.map((c) => `| ${cell(c.name)} | ${cell(c.conclusion)} |`),
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

/** The hidden state block is always the last thing in the body. */
export function renderComment(brief: Brief): string {
	const { outcome, key, review, ownerTeam } = brief;
	const shown = outcome.reasons.slice(0, MAX_REASONS);
	const more = outcome.reasons.length - shown.length;
	const lines = [
		"## Castellan brief",
		"",
		`**Verdict: ${outcome.verdict}**${ownerTeam ? ` | Owner team: ${escapeText(ownerTeam)}` : ""}`,
		"",
		...(shown.length
			? [
					...shown.map(
						(r, i) => `${i + 1}. ${escapeText(r.text)}${at(r.path)}`,
					),
					...(more > 0 ? [`(+${more} more)`] : []),
					"",
				]
			: []),
		"### Conformance",
		...conformance(brief),
		"",
		"### Correctness",
		...correctness(brief),
		"",
		"### Evidence",
		...evidence(brief),
		"",
		"### Provenance",
		...provenance(brief),
		"",
	];
	const { promptHash: _h, ...llm } = review ?? {};
	return `${lines.join("\n")}\n${serializeBlock({
		verdict: outcome.verdict,
		...key,
		...(review && { llm: llm as Omit<OkReviewResult, "promptHash"> }),
	})}`;
}
