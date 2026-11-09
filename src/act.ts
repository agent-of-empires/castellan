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
	skipped?:
		| "mode_off"
		| "not_merge"
		| "not_open"
		| "stale_head"
		| "queue_failed";
}

const ENABLE_AUTO_MERGE = `mutation($id: ID!, $oid: GitObjectID!) {
  enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: SQUASH, expectedHeadOid: $oid}) {
    clientMutationId
  }
}`;

const message = (err: unknown) =>
	err instanceof Error ? err.message : String(err);

/**
 * off: nothing. shadow: comment and status only. enforce: also approve and queue
 * a squash auto-merge, only for a `merge` verdict on a head that has not moved.
 * Safe to re-run sequentially on the same head; concurrent runs can both approve.
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
	if (brief.key.headSha !== headSha) {
		return { approved: false, queued: false, skipped: "stale_head" };
	}

	const escalate = (rule: string, text: string): Brief => ({
		...brief,
		outcome: { verdict: "escalate", reasons: [{ rule, text }] },
	});
	const publish = async (b: Brief) => {
		const { html_url } = await upsertComment(
			transport,
			repoRef,
			pullNumber,
			renderComment(b),
			author,
		);
		await setStatus(transport, repoRef, headSha, b.outcome.verdict, html_url);
	};

	// Refuse in code even if the rules let a protected change through.
	const final =
		brief.outcome.verdict === "merge" && touchesProtected(snapshot, config, ctx)
			? escalate(
					"protected_guard",
					"touches a protected path, protected team or governance file",
				)
			: brief;
	await publish(final);

	if (config.mode === "shadow") return { approved: false, queued: false };
	if (final.outcome.verdict !== "merge") {
		return { approved: false, queued: false, skipped: "not_merge" };
	}

	const { data: pr } = await transport.request(
		"GET /repos/{owner}/{repo}/pulls/{pull_number}",
		{ owner, repo, pull_number: pullNumber },
	);
	if (pr.state !== "open" || pr.merged) {
		return { approved: false, queued: false, skipped: "not_open" };
	}
	if (pr.head.sha !== headSha) {
		return { approved: false, queued: false, skipped: "stale_head" };
	}

	const reviews = await transport.paginate(
		"GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
		{ owner, repo, pull_number: pullNumber, per_page: 100 },
	);
	let approved = reviews.some(
		(r) =>
			r.user?.login === author.login &&
			r.state === "APPROVED" &&
			r.commit_id === headSha,
	);
	try {
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
			approved = true;
		}
		if (!pr.auto_merge) {
			try {
				await transport.graphql(ENABLE_AUTO_MERGE, {
					id: pr.node_id,
					oid: headSha,
				});
			} catch (err) {
				if (!message(err).includes("clean status")) throw err;
				// Already mergeable, so there is nothing to wait for: merge now.
				await transport.request(
					"PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
					{
						owner,
						repo,
						pull_number: pullNumber,
						merge_method: "squash",
						sha: headSha,
					},
				);
			}
		}
		return { approved: true, queued: true };
	} catch (err) {
		await publish(escalate("auto_merge_failed", message(err)));
		return { approved, queued: false, skipped: "queue_failed" };
	}
}
