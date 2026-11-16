/**
 * The sticky comment is a decision record: the verdict line stays at the top, the
 * hidden state block is always last, and the whole body stays under BODY_LIMIT.
 */
import { type CacheKey, serializeBlock } from "./cache.js";
import type { PushedFixes } from "./fix.js";
import type { FailureReason, OkReviewResult } from "./llm.js";
import type { RelatedPr } from "./related.js";
import type { InlineFinding } from "./review.js";
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
	/** Why the model call failed, when it did. */
	reviewError?: FailureReason;
	/** Unresolved review threads that reached the model. */
	threads?: number;
	/** Unresolved threads read but left out of the model field by the caps. */
	threadsDropped?: number;
	/** Threads changed after this head spent its re-run budget, so the stored verdict stands. */
	threadsCapped?: boolean;
	/** `cache` means `review.costUsd` was paid by an earlier run. */
	source: "cache" | "llm" | "skipped";
	/** Model findings posted as inline review comments, by index into `review.verdict.reasons`. */
	inline?: InlineFinding[];
	/** Marks the verdict line as shadow. */
	shadow?: boolean;
	/** Plain team slug; never rendered as a mention. */
	ownerTeam?: string;
	/** Open PRs changing the same files; advisory only, never part of the verdict. */
	related?: RelatedPr[];
	/** Fixes this run pushed to the branch, when writing is enabled. */
	fixes?: PushedFixes;
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
	const { review, source, reviewError } = brief;
	if (!review) {
		return [
			source === "llm"
				? `Model: unavailable${reviewError ? ` (${reviewError})` : ""}`
				: "Model: not run (rules decided)",
		];
	}
	const { intent_match, new_behavior, escalation } = review.verdict;
	// Only when the answer changed the verdict: in `size: off` the model may still
	// answer, and a merge it did not withhold must not read as blocked here.
	const escalate = brief.outcome.reasons.some((r) => r.rule === "llm_escalate");
	return [
		`### Model review${rulesDecided(brief) ? " (advisory, rules decided the verdict)" : ""}`,
		`- Matches the linked issue and description: ${yesNo(intent_match)}`,
		`- Adds behavior beyond the request: ${yesNo(new_behavior)}`,
		...(escalate
			? [
					`- Needs a human: ${escapeText(escalation ?? "yes, for a reason the model did not name")}`,
				]
			: []),
	];
}

/** Findings that stayed in the brief, so an inline finding is not repeated here. */
function findings({ review, inline }: Brief): string[] {
	const sent = new Set(inline?.map((i) => i.index) ?? []);
	return (
		review?.verdict.reasons.flatMap((r, i) =>
			sent.has(i)
				? []
				: [`- **${r.severity}** ${escapeText(r.text)}${at(r.path)}`],
		) ?? []
	);
}

/** Texts already posted inline, so a model veto is not numbered twice. */
const inlineTexts = (brief: Brief) =>
	new Set(
		(brief.inline ?? []).map(
			(i) => brief.review?.verdict.reasons[i.index]?.text ?? "",
		),
	);

const RANK: Record<string, number> = { pending: 1, skipped: 2 };
const PASSED = new Set(["success", "neutral"]);
// Failed first, then pending, skipped, passed.
const rank = (conclusion: string) =>
	PASSED.has(conclusion) ? 3 : (RANK[conclusion] ?? 0);

function checksSection({ checks }: Brief): string[] {
	if (!checks.length) return ["Checks: none on the head commit."];
	// The newest run (highest id) of a check replaces older ones.
	const byName = new Map<string, Snapshot["checks"][number]>();
	for (const c of checks) {
		const prev = byName.get(c.name);
		if (!prev || (c.id ?? 0) >= (prev.id ?? 0)) byName.set(c.name, c);
	}
	const latest = [...byName.values()];
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
	const sent = inlineTexts(brief);
	const listed = outcome.reasons.filter(
		(r) => !(r.rule.startsWith("llm_") && sent.has(r.text)),
	);
	const shown = listed.slice(0, MAX_REASONS);
	const more = listed.length - shown.length;
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
		// Only a run that reached the model checked anything.
		...(brief.threads && brief.review
			? [`- Unresolved review threads checked: ${brief.threads}`]
			: []),
		...(brief.threadsDropped && brief.review
			? [`- Unresolved review threads not sent: ${brief.threadsDropped}`]
			: []),
		...(brief.threadsCapped
			? [
					"- Review threads changed after this head used up its re-run budget: the earlier verdict stands.",
				]
			: []),
		// The number only: another author's title is third party text that would be
		// rendered here, and GitHub shows the title on hover anyway.
		...(brief.related?.length
			? [
					`- Open PRs that share files with this PR: ${brief.related
						.map((r) => `#${r.number}`)
						.join(", ")}`,
				]
			: []),
		...(brief.fixes
			? [
					`- ${brief.fixes.count} fix${brief.fixes.count === 1 ? "" : "es"} applied and pushed to \`${brief.fixes.sha.slice(0, 7)}\``,
				]
			: []),
		...(brief.inline?.length
			? [
					`- Inline findings: ${brief.inline.length} (on the diff, not repeated here)`,
				]
			: []),
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

/**
 * The body of the review that carries the inline findings. The pinned brief keeps
 * the rules, checks and provenance, so this stays short on purpose.
 */
export function renderReviewBody(brief: Brief): string {
	const { outcome, key, shadow, inline } = brief;
	// `inline` indexes the model's reasons while `outcome.reasons` is a different
	// list, so the filter matches on text, as `renderComment` does.
	const sent = inlineTexts(brief);
	const rest = outcome.reasons
		.filter((r) => !sent.has(r.text))
		.slice(0, MAX_REASONS);
	const count = inline?.length ?? 0;
	return [
		`**Castellan: ${outcome.verdict}** at \`${key.headSha.slice(0, 7)}\`${shadow ? " (shadow)" : ""}`,
		"",
		...rest.map((r, i) => `${i + 1}. ${reason(r.text)}${at(r.path)}`),
		...(rest.length ? [""] : []),
		...(count
			? [`${count} finding${count === 1 ? "" : "s"} inline on the diff.`]
			: []),
		"The pinned brief on this pull request holds the rules, checks and provenance.",
	].join("\n");
}
