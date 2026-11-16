import { type Brief, renderComment, renderReviewBody } from "./comment.js";
import type { Config } from "./config.js";
import type { GithubTransport, Repo } from "./github.js";
import {
	dismissStaleBlocker,
	inlineComments,
	postedAnchors,
	type ReviewEvent,
	type ReviewOutcome,
	submitReview,
} from "./review.js";
import { escalationReviewers, requestReviewers } from "./reviewers.js";
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
 * off: nothing. shadow: one review with the anchored findings (`COMMENT` only) plus
 * the comment and status. enforce: also approves, and queues a squash auto-merge,
 * only for a `merge` verdict on a head that has not moved; a posted blocker there is
 * `REQUEST_CHANGES`, which the approval on a later head supersedes. Inline findings
 * need `review.inline: true` and are never posted on a merge verdict. Findings that
 * could not be anchored, were already posted, or could not be posted stay in the
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
	// A merge verdict never carries inline comments: each one opens a thread that a
	// ruleset requiring conversation resolution would hold the auto-merge on. Those
	// findings stay in the brief instead, and the approval travels alone.
	const planned =
		config.review.inline && !isMerge
			? inlineComments(final.inline ?? [], final.review?.verdict.reasons ?? [])
			: [];
	const already = planned.length
		? await postedAnchors(transport, repoRef, pullNumber, author.login)
		: new Set<string>();
	const comments = planned.filter((c) => !already.has(`${c.path}:${c.line}`));
	const reasons = final.review?.verdict.reasons ?? [];
	const blocking = comments.some(
		(c) => reasons[c.index]?.severity === "blocker",
	);
	const event: ReviewEvent =
		config.mode === "enforce" && isMerge
			? "APPROVE"
			: config.mode === "enforce" && blocking
				? "REQUEST_CHANGES"
				: "COMMENT";
	const postedInline = final.inline?.filter((i) =>
		comments.some((c) => c.index === i.index),
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

	// An escalation has nobody watching it until a reviewer is asked, and shadow
	// must not write, so enforce is the only place this sends. The head is recorded
	// in the state block so a sweep or a later event does not ask again, including
	// after a human removed the request.
	const askReviewers = async (b: Brief) => {
		if (config.mode !== "enforce" || b.outcome.verdict !== "escalate") return;
		if (b.key.requested === headSha) return;
		await requestReviewers(transport, repoRef, pullNumber, {
			...escalationReviewers(b, config),
			author: snapshot.author,
		});
		b.key.requested = headSha;
	};
	await askReviewers(final);

	// An approving review waits for the guards below; a findings review cannot approve anything.
	const drafted = event === "APPROVE" ? null : await post();
	// The brief is the record that must not be lost, so a review that did not post
	// leaves every finding in the brief rather than claiming they are on the diff.
	await publish({
		...final,
		inline: drafted && postedInline?.length ? postedInline : undefined,
	});
	let review = drafted;

	// No anchored blocker at this head, so an earlier one must not keep the PR
	// blocked: GitHub would hold the old `REQUEST_CHANGES` until a later review.
	if (event !== "REQUEST_CHANGES") {
		await dismissStaleBlocker(transport, repoRef, {
			pullNumber,
			headSha,
			login: author.login,
		});
	}

	if (config.mode === "shadow") return { approved: false, queued: false };
	if (!isMerge) return { approved: false, queued: false, skipped: "not_merge" };

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
		const failed = escalate(
			"review_failed",
			"could not post the approving review",
		);
		// A merge was expected and a human is needed most here, so ask there too.
		await askReviewers(failed);
		await publish(failed);
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
		const failed = escalate("auto_merge_failed", message(err));
		await askReviewers(failed);
		await publish(failed);
		return { approved, queued: false, skipped: "queue_failed" };
	}
}
