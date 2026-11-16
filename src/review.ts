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
	index: number;
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
		return [{ index, path, line, body: `${prefix}${text}` }];
	});
}

/**
 * Anchors castellan already commented on, at any head of this PR. A force push
 * re-anchors a finding, so the same defect must not be posted twice; the caller
 * drops the planned comments whose anchor is in this set.
 */
export async function postedAnchors(
	transport: GithubTransport,
	{ owner, repo }: Repo,
	pullNumber: number,
	login: string,
): Promise<Set<string>> {
	const comments = await transport.paginate(
		"GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
		{ owner, repo, pull_number: pullNumber, per_page: 100 },
	);
	const out = new Set<string>();
	for (const c of comments) {
		if (c.user?.login !== login) continue;
		if (c.path && typeof c.line === "number") out.add(`${c.path}:${c.line}`);
	}
	return out;
}

export type ReviewEvent = "APPROVE" | "COMMENT" | "REQUEST_CHANGES";

export interface ReviewOutcome {
	approved: boolean;
	url?: string;
}

/**
 * An approval never carries comments: one rejected anchor would fail the whole
 * call, and its comments would open threads that hold the merge queue. Findings
 * are posted as their own review, and a re-run on the same head posts only the
 * comments that are new, since `PUT` cannot add comments to an existing review.
 * A submitted review's state cannot be changed, so an approval that follows a
 * `COMMENT` or `REQUEST_CHANGES` at the same head is posted as its own review.
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
	const edit = async () => {
		if (!existing) return null;
		const { data } = await transport.request(
			"PUT /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}",
			{ owner, repo, pull_number: pullNumber, review_id: existing.id, body },
		);
		return {
			approved: existing.state === "APPROVED",
			url: data.html_url,
		};
	};

	if (event === "APPROVE") {
		const edited = await edit();
		if (edited?.approved) return edited;
		const { data } = await transport.request(
			"POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
			{
				owner,
				repo,
				pull_number: pullNumber,
				commit_id: headSha,
				event: "APPROVE",
				body,
			},
		);
		return { approved: true, url: data.html_url };
	}

	if (comments.length) {
		const { data } = await transport.request(
			"POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
			{
				owner,
				repo,
				pull_number: pullNumber,
				commit_id: headSha,
				event,
				body,
				comments,
			},
		);
		return { approved: false, url: data.html_url };
	}

	const edited = await edit();
	if (edited) return edited;
	const { data } = await transport.request(
		"POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
		{
			owner,
			repo,
			pull_number: pullNumber,
			commit_id: headSha,
			event,
			body,
		},
	);
	return { approved: false, url: data.html_url };
}
