import type { GithubTransport, Repo } from "./github.js";
import { wroteCommits } from "./rules.js";

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
	/** Repo ids from the pull payload; `head` is null for a deleted fork. */
	baseRepoId: number | null;
	headRepoId: number | null;
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
	/** Check runs on the head SHA, not only required ones; every run is kept. */
	checks: {
		id?: number;
		name: string;
		conclusion: string;
		/** Epoch ms of `started_at`; null when missing (the API has no creation time). */
		startedAt?: number | null;
	}[];
	/**
	 * State, commit and whether the reviewer can write to the repo; review bodies
	 * are human text and are left out.
	 */
	reviews: {
		login: string;
		state: string;
		commitId: string;
		canWrite: boolean;
	}[];
	/**
	 * Every commit on the PR, newest last, as the logins GitHub maps and the full
	 * message. Castellan's own fix commits are recognised by either.
	 */
	commits: { logins: string[]; message: string }[];
	/**
	 * True when the API listed fewer commits than the PR reports: it returns at most
	 * 250, oldest first, so the newest (which are castellan's) can be missing.
	 */
	commitsTruncated: boolean;
	/** State of the latest non-COMMENTED CodeRabbit review, if any. */
	codeRabbit: string | null;
}

/** Permissions that can approve a merge, as `collaborators/{login}/permission` reports them. */
const CAN_WRITE = new Set(["admin", "maintain", "write"]);

/**
 * The repo permission behind each login, keyed by login. A login that cannot be
 * read, or does not resolve, is not a writer: the approval then does not clear a
 * commit castellan wrote, which is the safe direction.
 */
async function writePermissions(
	transport: GithubTransport,
	{ owner, repo }: Repo,
	logins: string[],
): Promise<Map<string, boolean>> {
	const out = new Map<string, boolean>();
	await Promise.all(
		[...new Set(logins)].map(async (username) => {
			try {
				const { data } = await transport.request(
					"GET /repos/{owner}/{repo}/collaborators/{username}/permission",
					{ owner, repo, username },
				);
				out.set(username, CAN_WRITE.has(data.permission));
			} catch (err) {
				// No trace would leave every castellan-written head escalated with
				// nothing saying why, so the status is logged.
				console.warn("permission lookup failed", {
					username,
					status: (err as { status?: number }).status,
				});
				out.set(username, false);
			}
		}),
	);
	return out;
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

/** GitHub answers 406 `too_large` when a PR diff exceeds 20000 lines. */
function isDiffTooLarge(err: unknown): boolean {
	const e = err as {
		status?: number;
		response?: { data?: { errors?: { code?: string }[] } };
	};
	return (
		e.status === 406 &&
		!!e.response?.data?.errors?.some((x) => x.code === "too_large")
	);
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
	{
		allowClosed = false,
		login,
	}: {
		/** Eval replay reviews a merged PR. */
		allowClosed?: boolean;
		/** Castellan's own login, so a commit it wrote is recognised. */
		login?: string;
	} = {},
): Promise<Snapshot> {
	const pull = { owner, repo, pull_number: pullNumber };
	const getPull = () =>
		transport.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", pull);
	const { data: pr } = await getPull();
	if (!allowClosed && (pr.state !== "open" || pr.merged)) {
		throw new Error(`PR #${pullNumber} is not open`);
	}
	const headSha = pr.head.sha;
	const [{ data: diff }, files, reviews, checks, commits] = await Promise.all([
		transport
			.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
				...pull,
				mediaType: { format: "diff" },
			})
			.catch((err: unknown) => {
				if (isDiffTooLarge(err)) return { data: undefined };
				throw err;
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
		transport.paginate(
			"GET /repos/{owner}/{repo}/pulls/{pull_number}/commits",
			{
				...pull,
				per_page: 100,
			},
		),
	]);
	const { data: after } = await getPull();
	if (after.head.sha !== headSha) {
		throw new Error(`PR #${pullNumber} head moved during snapshot`);
	}

	const commitList = commits.map((c) => ({
		logins: [c.author?.login, c.committer?.login].filter(
			(l): l is string => !!l,
		),
		message: c.commit.message,
	}));
	const commitsTruncated = commits.length < (pr.commits ?? 0);
	// Only an approval that would clear a commit castellan wrote needs the
	// permission behind it, so the extra read happens only on such a PR. The
	// rule's own predicate is reused so the two cannot drift apart.
	const wrote = wroteCommits(commitList, commitsTruncated, login);
	const writable = wrote
		? await writePermissions(
				transport,
				{ owner, repo },
				reviews
					.filter(
						(r) =>
							r.state === "APPROVED" &&
							r.commit_id === headSha &&
							!/\[bot\]$/.test(r.user?.login ?? ""),
					)
					.map((r) => r.user?.login ?? "")
					.filter(Boolean),
			)
		: new Map<string, boolean>();
	const reviewList = reviews.map((r) => ({
		login: r.user?.login ?? "",
		state: r.state,
		commitId: r.commit_id ?? "",
		canWrite: writable.get(r.user?.login ?? "") ?? false,
	}));
	const fullBody = pr.body ?? "";
	const body = cap(fullBody, BODY_CAP);
	// the diff media type makes `data` a string, which the typings do not know;
	// undefined means GitHub refused to render the diff, so treat it as truncated
	const diffText =
		diff === undefined
			? { text: "", truncated: true }
			: cap(diff as unknown as string, DIFF_CAP);
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
		baseRepoId: Number(pr.base.repo?.id ?? 0) || null,
		headRepoId: Number(pr.head.repo?.id ?? 0) || null,
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
			startedAt: c.started_at ? Date.parse(c.started_at) : null,
		})),
		reviews: reviewList,
		commitsTruncated,
		commits: commitList,
		codeRabbit:
			reviewList.findLast(
				(r) => r.login === CODERABBIT && r.state !== "COMMENTED",
			)?.state ?? null,
	};
}
