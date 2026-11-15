import { type Brief, renderComment, renderReviewBody } from "./comment.js";
import type { Config } from "./config.js";
import type { GithubTransport, Repo } from "./github.js";
import { inlineComments, type ReviewOutcome, submitReview } from "./review.js";
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
		| "queue_failed"
		| "review_failed";
}

const ENABLE_AUTO_MERGE = `mutation($id: ID!, $oid: GitObjectID!) {
  enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: SQUASH, expectedHeadOid: $oid}) {
    clientMutationId
  }
}`;

const message = (err: unknown) =>
	err instanceof Error ? err.message : String(err);

/**
 * off: nothing. shadow: one review with the anchored findings (`COMMENT`) plus the
 * comment and status. enforce: also approves, and queues a squash auto-merge, only
 * for a `merge` verdict on a head that has not moved. An escalation never posts
 * `REQUEST_CHANGES`: it waits for a human instead of blocking. Findings that could
 * not be anchored, and every finding when the review cannot be posted, stay in the
 * brief. Safe to re-run sequentially on the same head; concurrent runs can both approve.
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
		await setStatus(
			transport,
			repoRef,
			headSha,
			b.outcome,
			config.mode,
			html_url,
		);
	};

	// Refuse in code even if the rules let a protected change through.
	const final =
		brief.outcome.verdict === "merge" && touchesProtected(snapshot, config, ctx)
			? escalate(
					"protected_guard",
					"touches a protected path, protected team or governance file",
				)
			: brief;
	const isMerge = final.outcome.verdict === "merge";
	const event = config.mode === "enforce" && isMerge ? "APPROVE" : "COMMENT";
	const comments = inlineComments(
		final.inline ?? [],
		final.review?.verdict.reasons ?? [],
	);
	const post = async (): Promise<ReviewOutcome | null> => {
		if (!comments.length && event !== "APPROVE") return null;
		try {
			return await submitReview(transport, repoRef, {
				pullNumber,
				headSha,
				event,
				body: renderReviewBody(final),
				comments,
				login: author.login,
			});
		} catch (err) {
			console.error("review post failed", { error: message(err) });
			return null;
		}
	};

	// An approving review waits for the guards below; a comment review cannot approve anything.
	let review: ReviewOutcome | null = event === "COMMENT" ? await post() : null;
	// The brief is the record that must not be lost, so a failed review keeps its findings.
	await publish(
		review || !final.inline?.length ? final : { ...final, inline: undefined },
	);

	if (config.mode === "shadow") return { approved: false, queued: false };
	if (!isMerge) {
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

	review = await post();
	const approved = review?.approved ?? false;
	if (!approved) {
		await publish(
			escalate("review_failed", "could not post the approving review"),
		);
		return { approved: false, queued: false, skipped: "review_failed" };
	}
	try {
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
