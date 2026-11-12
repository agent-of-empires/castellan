import { MARKER } from "./cache.js";
import type { Config } from "./config.js";
import type { GithubTransport, Repo } from "./github.js";
import type { Outcome } from "./verdict.js";

export const STATUS_CONTEXT = "castellan";

/** GitHub rejects status descriptions longer than 140 characters. */
const DESCRIPTION_LIMIT = 140;

/**
 * Never `failure`: an escalation waits for a human instead of blocking. Shadow is
 * `success` for a verdict, because `pending` reads as "waiting for status to be reported".
 */
export function statusFor(
	verdict: Outcome["verdict"],
	mode: Config["mode"],
	reason?: string,
) {
	if (mode === "shadow") {
		const text =
			verdict === "merge"
				? "shadow: would merge"
				: `shadow: would escalate${reason ? ` (${reason.replace(/\s+/g, " ")})` : ""}`;
		return {
			state: "success" as const,
			description: Array.from(text).slice(0, DESCRIPTION_LIMIT).join(""),
		};
	}
	return verdict === "merge"
		? { state: "success" as const, description: "castellan: merge" }
		: {
				state: "pending" as const,
				description: "castellan: escalated to a human",
			};
}

/** CI has not settled; always `pending`, also in shadow, so a stale verdict cannot stay. */
export const waitingStatus = (mode: Config["mode"]) => ({
	state: "pending" as const,
	description: `${mode === "shadow" ? "shadow" : "castellan"}: waiting for CI`,
});

/** Posts a `castellan` status unless the current one has the same state and description (and target_url, when given). Best effort: any read error posts. */
export async function postStatus(
	transport: GithubTransport,
	{ owner, repo }: Repo,
	sha: string,
	status: {
		state: "success" | "pending";
		description: string;
		target_url?: string;
	},
) {
	const current = await transport
		.request("GET /repos/{owner}/{repo}/commits/{ref}/status", {
			owner,
			repo,
			ref: sha,
			per_page: 100,
		})
		.then((r) => r.data.statuses.find((s) => s.context === STATUS_CONTEXT))
		.catch(() => undefined);
	if (
		current?.state === status.state &&
		current.description === status.description &&
		(status.target_url === undefined ||
			current.target_url === status.target_url)
	) {
		return;
	}
	await transport.request("POST /repos/{owner}/{repo}/statuses/{sha}", {
		owner,
		repo,
		sha,
		context: STATUS_CONTEXT,
		...status,
	});
}

export async function setStatus(
	transport: GithubTransport,
	{ owner, repo }: Repo,
	sha: string,
	outcome: Outcome,
	mode: Config["mode"],
	targetUrl: string,
) {
	await postStatus(transport, { owner, repo }, sha, {
		target_url: targetUrl,
		...statusFor(outcome.verdict, mode, outcome.reasons[0]?.text),
	});
}

/** Castellan's own identity: the App login (`<slug>[bot]`) or the App id. Other bots never match. */
export interface Author {
	login?: string;
	appId?: number;
}

/** Castellan's own comment carrying the state block, if any. */
export async function findStickyComment(
	transport: GithubTransport,
	{ owner, repo }: Repo,
	pullNumber: number,
	author: Author,
) {
	const comments = await transport.paginate(
		"GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
		{ owner, repo, issue_number: pullNumber, per_page: 100 },
	);
	const hit = comments.find(
		(c) =>
			c.body?.includes(MARKER) &&
			((author.appId !== undefined &&
				c.performed_via_github_app?.id === author.appId) ||
				(author.login !== undefined && c.user?.login === author.login)),
	);
	return hit ? { id: Number(hit.id), body: hit.body ?? "" } : null;
}

/** Edits the sticky comment in place, or creates it once. */
export async function upsertComment(
	transport: GithubTransport,
	repoRef: Repo,
	pullNumber: number,
	body: string,
	author: Author,
): Promise<{ id: number; html_url: string }> {
	const { owner, repo } = repoRef;
	const existing = await findStickyComment(
		transport,
		repoRef,
		pullNumber,
		author,
	);
	if (existing) {
		const { data } = await transport.request(
			"PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
			{ owner, repo, comment_id: existing.id, body },
		);
		return { id: Number(data.id), html_url: data.html_url };
	}
	const { data } = await transport.request(
		"POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
		{ owner, repo, issue_number: pullNumber, body },
	);
	return { id: Number(data.id), html_url: data.html_url };
}
