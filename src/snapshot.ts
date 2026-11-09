import type { GithubTransport, Repo } from "./github.js";

export const BODY_CAP = 3_000;
export const DIFF_CAP = 30_000;
export const FILES_CAP = 200;

const CODERABBIT = "coderabbitai[bot]";

export type AuthorClass = "maintainer" | "trusted" | "external" | "bot";

export interface Snapshot {
	title: string;
	body: string;
	bodyTruncated: boolean;
	author: string;
	authorClass: AuthorClass;
	draft: boolean;
	/** From the pull payload; null while GitHub is still computing it. */
	mergeable: boolean | null;
	baseRef: string;
	baseSha: string;
	headRef: string;
	headSha: string;
	/** Issue numbers from Closes/Fixes/Resolves in the full, uncapped body. */
	linkedIssues: number[];
	files: {
		path: string;
		status: string;
		additions: number;
		deletions: number;
	}[];
	filesTruncated: boolean;
	diff: string;
	diffTruncated: boolean;
	/** Every check run on the head SHA, not only required ones. */
	/** `id` orders runs of one check; the API returns newest first. */
	checks: { id?: number; name: string; conclusion: string }[];
	/** State and commit only; review bodies are human text and are left out. */
	reviews: { login: string; state: string; commitId: string }[];
	/** State of the latest non-COMMENTED CodeRabbit review, if any. */
	codeRabbit: string | null;
}

function cap(text: string, max: number) {
	return { text: text.slice(0, max), truncated: text.length > max };
}

function linkedIssues(body: string): number[] {
	const nums = [...body.matchAll(/\b(?:closes|fixes|resolves)\s+#(\d+)/gi)].map(
		(m) => Number(m[1]),
	);
	return [...new Set(nums)];
}

/**
 * Text-only view of a PR for the rules and the model. Nothing is checked out.
 * Labels and comments are never fetched, so castellan-set labels and human
 * comment bodies cannot leak in. Throws if the PR is not open (unless
 * `allowClosed`, used by eval replay) or its head moves while the snapshot is built.
 */
export async function buildSnapshot(
	transport: GithubTransport,
	{ owner, repo }: Repo,
	pullNumber: number,
	authorClass: AuthorClass,
	{ allowClosed = false } = {},
): Promise<Snapshot> {
	const pull = { owner, repo, pull_number: pullNumber };
	const getPull = () =>
		transport.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", pull);
	const { data: pr } = await getPull();
	if (!allowClosed && (pr.state !== "open" || pr.merged)) {
		throw new Error(`PR #${pullNumber} is not open`);
	}
	const headSha = pr.head.sha;
	const [{ data: diff }, files, reviews, checks] = await Promise.all([
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
		transport.paginate("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
			owner,
			repo,
			ref: headSha,
			per_page: 100,
		}),
	]);
	const { data: after } = await getPull();
	if (after.head.sha !== headSha) {
		throw new Error(`PR #${pullNumber} head moved during snapshot`);
	}

	const reviewList = reviews.map((r) => ({
		login: r.user?.login ?? "",
		state: r.state,
		commitId: r.commit_id ?? "",
	}));
	const fullBody = pr.body ?? "";
	const body = cap(fullBody, BODY_CAP);
	// the diff media type makes `data` a string, which the typings do not know
	const diffText = cap(diff as unknown as string, DIFF_CAP);
	return {
		title: pr.title,
		body: body.text,
		bodyTruncated: body.truncated,
		author: pr.user.login,
		authorClass,
		draft: pr.draft ?? false,
		mergeable: pr.mergeable,
		baseRef: pr.base.ref,
		baseSha: pr.base.sha,
		headRef: pr.head.ref,
		headSha,
		linkedIssues: linkedIssues(fullBody),
		files: files.slice(0, FILES_CAP).map((f) => ({
			path: f.filename,
			status: f.status,
			additions: f.additions,
			deletions: f.deletions,
		})),
		filesTruncated: files.length > FILES_CAP,
		diff: diffText.text,
		diffTruncated: diffText.truncated,
		checks: checks.map((c) => ({
			id: c.id,
			name: c.name,
			conclusion: c.conclusion ?? "pending",
		})),
		reviews: reviewList,
		codeRabbit:
			reviewList.findLast(
				(r) => r.login === CODERABBIT && r.state !== "COMMENTED",
			)?.state ?? null,
	};
}
