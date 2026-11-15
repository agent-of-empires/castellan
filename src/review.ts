import { escapeText, MAX_REASON_CHARS } from "./comment.js";
import type { DiffLines } from "./diff.js";
import type { GithubTransport, Repo } from "./github.js";

/** A wall of inline comments is worse than a list, so the tail stays in the brief. */
export const MAX_INLINE = 10;

/** A model finding that lands on a line the diff shows. `index` is into the verdict's reasons. */
export interface InlineFinding {
	index: number;
	path: string;
	line: number;
}

export interface InlineComment {
	path: string;
	line: number;
	body: string;
}

type Finding = { severity: string; text: string; path?: string; line?: number };

/**
 * Keeps only the findings GitHub will accept: a path in the diff, a line on the
 * new side, and one comment per line. Everything else stays in the brief, which
 * is why the caller reports both lists.
 */
export function planInline(
	reasons: Finding[],
	lines: DiffLines,
	cap = MAX_INLINE,
): InlineFinding[] {
	const out: InlineFinding[] = [];
	const used = new Set<string>();
	for (const [index, r] of reasons.entries()) {
		if (!r.path || r.line === undefined) continue;
		if (!lines.get(r.path)?.has(r.line)) continue;
		const key = `${r.path}:${r.line}`;
		if (used.has(key)) continue;
		used.add(key);
		out.push({ index, path: r.path, line: r.line });
		if (out.length === cap) break;
	}
	return out;
}

/** The repo convention: no severity label, and nits say `nit:`. */
export function inlineComments(
	findings: InlineFinding[],
	reasons: Finding[],
): InlineComment[] {
	return findings.flatMap(({ index, path, line }) => {
		const r = reasons[index];
		if (!r) return [];
		const prefix = r.severity === "nit" ? "nit: " : "";
		const text = escapeText(r.text.slice(0, MAX_REASON_CHARS));
		return [{ path, line, body: `${prefix}${text}` }];
	});
}

export type ReviewEvent = "APPROVE" | "COMMENT";

export interface ReviewOutcome {
	approved: boolean;
	url?: string;
}

/**
 * One review per head. A review that already exists at this head has its body
 * edited in place, because an edit cannot carry comments and re-posting would
 * duplicate them; the previous head's comments are left to go stale, as every
 * force push does. `APPROVE` still needs its own review when the existing one is
 * only a `COMMENT`, since a submitted review's state cannot be changed.
 */
export async function submitReview(
	transport: GithubTransport,
	{ owner, repo }: Repo,
	opts: {
		pullNumber: number;
		headSha: string;
		event: ReviewEvent;
		body: string;
		comments: InlineComment[];
		login: string;
	},
): Promise<ReviewOutcome> {
	const { pullNumber, headSha, event, body, comments, login } = opts;
	const reviews = await transport.paginate(
		"GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
		{ owner, repo, pull_number: pullNumber, per_page: 100 },
	);
	const existing = reviews.findLast(
		(r) => r.user?.login === login && r.commit_id === headSha,
	);
	if (existing) {
		const { data } = await transport.request(
			"PUT /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}",
			{ owner, repo, pull_number: pullNumber, review_id: existing.id, body },
		);
		if (event === "APPROVE" && existing.state !== "APPROVED") {
			const approval = await transport.request(
				"POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
				{
					owner,
					repo,
					pull_number: pullNumber,
					commit_id: headSha,
					event: "APPROVE",
				},
			);
			return { approved: true, url: approval.data.html_url };
		}
		return {
			approved: existing.state === "APPROVED",
			url: data.html_url,
		};
	}
	const { data } = await transport.request(
		"POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
		{
			owner,
			repo,
			pull_number: pullNumber,
			commit_id: headSha,
			event,
			body,
			...(comments.length ? { comments } : {}),
		},
	);
	return { approved: event === "APPROVE", url: data.html_url };
}
