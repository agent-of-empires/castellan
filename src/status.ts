import { MARKER } from "./cache.js";
import type { GithubTransport, Repo } from "./github.js";
import type { Outcome } from "./verdict.js";

export const STATUS_CONTEXT = "castellan";

/** v1 never fails the status: an escalation waits for a human instead of blocking. */
export function statusFor(verdict: Outcome["verdict"]) {
	return verdict === "merge"
		? { state: "success" as const, description: "castellan: merge" }
		: {
				state: "pending" as const,
				description: "castellan: escalated to a human",
			};
}

export async function setStatus(
	transport: GithubTransport,
	{ owner, repo }: Repo,
	sha: string,
	verdict: Outcome["verdict"],
) {
	await transport.request("POST /repos/{owner}/{repo}/statuses/{sha}", {
		owner,
		repo,
		sha,
		context: STATUS_CONTEXT,
		...statusFor(verdict),
	});
}

/** The bot's own comment carrying the state block, if any. */
export async function findStickyComment(
	transport: GithubTransport,
	{ owner, repo }: Repo,
	pullNumber: number,
) {
	const comments = await transport.paginate(
		"GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
		{ owner, repo, issue_number: pullNumber, per_page: 100 },
	);
	const hit = comments.find(
		(c) => c.user?.type === "Bot" && c.body?.includes(MARKER),
	);
	return hit ? { id: hit.id, body: hit.body ?? "" } : null;
}

/** Edits the sticky comment in place, or creates it once. */
export async function upsertComment(
	transport: GithubTransport,
	repoRef: Repo,
	pullNumber: number,
	body: string,
) {
	const { owner, repo } = repoRef;
	const existing = await findStickyComment(transport, repoRef, pullNumber);
	if (existing) {
		await transport.request(
			"PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
			{ owner, repo, comment_id: existing.id, body },
		);
		return;
	}
	await transport.request(
		"POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
		{ owner, repo, issue_number: pullNumber, body },
	);
}
