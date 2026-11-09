import { type Brief, renderComment } from "./comment.js";
import type { Config } from "./config.js";
import type { GithubTransport, Repo } from "./github.js";
import { type Context, touchesProtected } from "./rules.js";
import type { Snapshot } from "./snapshot.js";
import { type Author, setStatus, upsertComment } from "./status.js";

export interface ActInput {
	pullNumber: number;
	snapshot: Snapshot;
	/** Loaded from the base SHA only. */
	config: Config;
	ctx: Context;
	brief: Brief;
	/** The App's `<slug>[bot]` login, used to find its own approval. */
	author: Author & { login: string };
}

export interface ActResult {
	approved: boolean;
	queued: boolean;
	skipped?: "mode_off" | "not_merge" | "stale_head";
}

const ENABLE_AUTO_MERGE = `mutation($id: ID!, $oid: GitObjectID!) {
  enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: SQUASH, expectedHeadOid: $oid}) {
    clientMutationId
  }
}`;

/**
 * off: nothing. shadow: comment and status only. enforce: also approve and queue
 * a squash auto-merge, only for a `merge` verdict on a head that has not moved.
 * Safe to re-run on the same head.
 */
export async function act(
	transport: GithubTransport,
	repoRef: Repo,
	{ pullNumber, snapshot, config, ctx, brief, author }: ActInput,
): Promise<ActResult> {
	if (config.mode === "off") {
		return { approved: false, queued: false, skipped: "mode_off" };
	}
	const { owner, repo } = repoRef;
	const { headSha } = snapshot;

	// Refuse in code even if the rules let a protected change through.
	const final: Brief =
		brief.outcome.verdict === "merge" && touchesProtected(snapshot, config, ctx)
			? {
					...brief,
					outcome: {
						verdict: "escalate",
						reasons: [
							{
								rule: "protected_guard",
								text: "touches a protected path or protected team",
							},
						],
					},
				}
			: brief;

	const { html_url } = await upsertComment(
		transport,
		repoRef,
		pullNumber,
		renderComment(final),
		author,
	);
	await setStatus(transport, repoRef, headSha, final.outcome.verdict, html_url);

	if (config.mode === "shadow") return { approved: false, queued: false };
	if (final.outcome.verdict !== "merge") {
		return { approved: false, queued: false, skipped: "not_merge" };
	}

	const { data: pr } = await transport.request(
		"GET /repos/{owner}/{repo}/pulls/{pull_number}",
		{ owner, repo, pull_number: pullNumber },
	);
	if (pr.state !== "open" || pr.merged || pr.head.sha !== headSha) {
		return { approved: false, queued: false, skipped: "stale_head" };
	}

	const reviews = await transport.paginate(
		"GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
		{ owner, repo, pull_number: pullNumber, per_page: 100 },
	);
	const approved = reviews.some(
		(r) =>
			r.user?.login === author.login &&
			r.state === "APPROVED" &&
			r.commit_id === headSha,
	);
	if (!approved) {
		await transport.request(
			"POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
			{
				owner,
				repo,
				pull_number: pullNumber,
				commit_id: headSha,
				event: "APPROVE",
			},
		);
	}

	if (!pr.auto_merge) {
		await transport.graphql(ENABLE_AUTO_MERGE, {
			id: pr.node_id,
			oid: headSha,
		});
	}
	return { approved: true, queued: true };
}
