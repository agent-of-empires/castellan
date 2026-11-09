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
	/** Marks the verdict line as shadow. */
	shadow?: boolean;
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

/** Rules decided when the verdict is an escalation that is not purely a model veto. */
const rulesDecided = ({ outcome }: Brief) =>
	outcome.verdict === "escalate" &&
	!outcome.reasons.every((r) => r.rule.startsWith("llm_"));

function modelIntro(brief: Brief): string[] {
	const { review, source } = brief;
	if (!review) {
		return [
			source === "llm"
				? "Model: unavailable"
				: "Model: not run (rules decided)",
		];
	}
	const { intent_match, new_behavior } = review.verdict;
	return [
		`### Model review${rulesDecided(brief) ? " (advisory, rules decided the verdict)" : ""}`,
		`- Matches the linked issue and description: ${yesNo(intent_match)}`,
		`- Adds behavior beyond the request: ${yesNo(new_behavior)}`,
	];
}

function findings({ review }: Brief): string[] {
	return (
		review?.verdict.reasons.map(
			(r) => `- **${r.severity}** ${escapeText(r.text)}${at(r.path)}`,
		) ?? []
	);
}

const RANK: Record<string, number> = { pending: 1, skipped: 2 };
const PASSED = new Set(["success", "neutral"]);
// Failed first, then pending, skipped, passed.
const rank = (conclusion: string) =>
	PASSED.has(conclusion) ? 3 : (RANK[conclusion] ?? 0);

function checksSection({ checks }: Brief): string[] {
	if (!checks.length) return ["Checks: none on the head commit."];
	// A later run of the same check replaces the earlier one.
	const latest = [...new Map(checks.map((c) => [c.name, c])).values()];
	const count = (r: number) =>
		latest.filter((c) => rank(c.conclusion) === r).length;
	const pending = count(1);
	const summary = `Checks (${count(3)} passed, ${count(2)} skipped, ${count(0)} failed${pending ? `, ${pending} pending` : ""})`;
	const rows = latest
		.map((c, i) => ({ c, i }))
		.sort((x, y) => rank(x.c.conclusion) - rank(y.c.conclusion) || x.i - y.i)
		.map(({ c }) => c);
	return [
		`<details><summary>${summary}</summary>`,
		"",
		"| Check | Conclusion |",
		"| --- | --- |",
		...rows
			.slice(0, MAX_CHECKS)
			.map((c) => `| ${cell(c.name)} | ${cell(c.conclusion)} |`),
		...(rows.length > MAX_CHECKS
			? ["", `+${rows.length - MAX_CHECKS} more checks`]
			: []),
		"",
		"</details>",
	];
}

function provenance({ key, review, source }: Brief): string[] {
	const run =
		source === "cache"
			? `cached from \`${key.headSha.slice(0, 7)}\``
			: source === "llm"
				? `fresh${review ? `, cost ${review.costUsd.toFixed(4)} USD` : ", failed"}`
				: "not run";
	return [
		"<details><summary>Provenance</summary>",
		"",
		`- Head: \`${key.headSha.slice(0, 7)}\``,
		`- Model: \`${escapeText(key.model)}\`, prompt \`${key.promptHash.slice(0, 12)}\``,
		`- Model run: ${run}`,
		"",
		"</details>",
	];
}

export function renderComment(brief: Brief): string {
	const { outcome, key, review, ownerTeam, shadow } = brief;
	const shown = outcome.reasons.slice(0, MAX_REASONS);
	const more = outcome.reasons.length - shown.length;
	const head = [
		"## Castellan brief",
		"",
		`**Verdict: ${outcome.verdict}**${shadow ? " (shadow)" : ""}${ownerTeam ? ` | Owner team: ${escapeText(ownerTeam)}` : ""}`,
		"",
		...(shown.length
			? [
					...shown.map((r, i) => `${i + 1}. ${reason(r.text)}${at(r.path)}`),
					...(more > 0 ? [`(+${more} more)`] : []),
					"",
				]
			: []),
		...modelIntro(brief),
	];
	const tail = ["", ...checksSection(brief), "", ...provenance(brief), ""];
	const { promptHash: _h, ...llm } = review ?? {};
	const block = serializeBlock({
		verdict: outcome.verdict,
		...key,
		...(review && { llm: llm as Omit<OkReviewResult, "promptHash"> }),
	});

	// Last resort: drop findings so the block always survives intact and last.
	const lines = findings(brief);
	const fixed = [...head, ...tail].join("\n").length + block.length + 2;
	const kept: string[] = [];
	let used = fixed + 80;
	for (const line of lines) {
		if (used + line.length + 1 > BODY_LIMIT) break;
		kept.push(line);
		used += line.length + 1;
	}
	if (kept.length < lines.length) {
		kept.push(`(+${lines.length - kept.length} more findings omitted)`);
	}
	return `${[...head, ...kept, ...tail].join("\n")}\n${block}`;
}
