import type { Verdict } from "./llm.js";

/** Findings carried from the previous head; more than this is noise, not review. */
export const MAX_PREVIOUS = 6;
/** One carried finding, so a long one cannot use the whole field. */
export const PREVIOUS_ITEM_CAP = 900;

const RANK: Record<string, number> = { blocker: 0, concern: 1, nit: 2 };

/**
 * The `previousFindings` prompt field: what an earlier review of this pull
 * request reported, at this head or an older one, or undefined when there is
 * nothing to carry.
 *
 * The carried findings are the block's own field, so a head whose model run
 * failed does not drop what an earlier head found. They are written by the
 * model and can be wrong, which is why the prompt says so.
 */
export function renderPrevious(
	reasons: Verdict["reasons"],
	sha: string,
): string | undefined {
	// A blocker in seventh place matters more than six nits, so severity decides
	// before the cap does.
	const kept = [...reasons]
		.sort((a, b) => (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3))
		.slice(0, MAX_PREVIOUS);
	if (!kept.length) return undefined;
	const where = sha.slice(0, 7);
	return [
		`An earlier automated review of this pull request, at ${where}, reported these findings. They can be wrong:`,
		...kept.map((r, i) => {
			const at = [r.path, r.line].filter((v) => v !== undefined).join(":");
			// A newline in model text would otherwise look like another finding.
			const text = r.text
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, PREVIOUS_ITEM_CAP);
			return `${i + 1}. [${r.severity}]${at ? ` ${at}` : ""} ${text}`;
		}),
	].join("\n");
}
