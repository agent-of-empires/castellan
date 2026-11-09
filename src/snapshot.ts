import type { GithubTransport, Repo } from "./github.js";

export const BODY_CAP = 3_000;
export const DIFF_CAP = 30_000;

const CODERABBIT = "coderabbitai[bot]";

export interface Snapshot {
	title: string;
	body: string;
	author: string;
	authorClass: string;
	headSha: string;
	files: {
		path: string;
		status: string;
		additions: number;
		deletions: number;
	}[];
	diff: string;
	/** Every check run on the head SHA, not only required ones. */
	checks: { name: string; conclusion: string | null }[];
	/** State and commit only; review bodies are human text and are left out. */
	reviews: { login: string; state: string; commitId: string }[];
	/** State of the latest CodeRabbit review, if any. */
	codeRabbit: string | null;
}

function cap(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
}

/**
 * Text-only view of a PR for the rules and the model. Nothing is checked out.
 * Labels and comments are never fetched, so castellan-set labels and human
 * comment bodies cannot leak in.
 */
export async function buildSnapshot(
	transport: GithubTransport,
	{ owner, repo }: Repo,
	pullNumber: number,
	authorClass: string,
): Promise<Snapshot> {
	const pull = { owner, repo, pull_number: pullNumber };
	const [{ data: pr }, { data: diff }, files, reviews] = await Promise.all([
		transport.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", pull),
		transport.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
			...pull,
			mediaType: { format: "diff" },
		}),
		transport.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
			...pull,
			per_page: 100,
		}),
		transport.paginate(
			"GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
			{ ...pull, per_page: 100 },
		),
	]);
	const headSha = pr.head.sha;
	const checks = await transport.paginate(
		"GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
		{ owner, repo, ref: headSha, per_page: 100 },
	);
	const reviewList = reviews.map((r) => ({
		login: r.user?.login ?? "",
		state: r.state,
		commitId: r.commit_id ?? "",
	}));
	return {
		title: pr.title,
		body: cap(pr.body ?? "", BODY_CAP),
		author: pr.user.login,
		authorClass,
		headSha,
		files: files.map((f) => ({
			path: f.filename,
			status: f.status,
			additions: f.additions,
			deletions: f.deletions,
		})),
		diff: cap(diff as unknown as string, DIFF_CAP),
		checks: checks.map((c) => ({ name: c.name, conclusion: c.conclusion })),
		reviews: reviewList,
		codeRabbit:
			reviewList.findLast((r) => r.login === CODERABBIT)?.state ?? null,
	};
}
