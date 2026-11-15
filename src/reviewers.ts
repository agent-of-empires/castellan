import type { Config } from "./config.js";
import type { GithubTransport, Repo } from "./github.js";
import { type CodeownersRule, matchesPath } from "./rules.js";

const TEAM = /^@[^/]+\/.+$/;

/**
 * The team that owns the change, from CODEOWNERS: for each changed file, the
 * last rule that matches, and that rule's first team owner. A plain `@user`
 * owner is not a team and is skipped, so an escalation is asked of the team
 * that owns the code rather than of the whole maintainer group.
 */
export function ownedTeam(
	files: string[],
	codeowners: CodeownersRule[],
): string | undefined {
	for (const path of files) {
		const rule = codeowners.findLast((r) => matchesPath(r.pattern, path));
		const owner = rule?.owners.find((o) => TEAM.test(o));
		if (owner) return owner.slice(owner.indexOf("/") + 1);
	}
	return undefined;
}

/**
 * Asks the configured reviewers for a review. Best effort: a PR that cannot be
 * assigned still gets its escalation comment, so the run is never failed by
 * this. The author is dropped because GitHub rejects a review request for the
 * PR's own author.
 */
export async function requestReviewers(
	transport: GithubTransport,
	{ owner, repo }: Repo,
	pullNumber: number,
	{ team, users, author }: { team?: string; users: string[]; author: string },
): Promise<void> {
	const reviewers = users.filter(
		(u) => u && u.toLowerCase() !== author.toLowerCase(),
	);
	if (!team && !reviewers.length) return;
	try {
		await transport.request(
			"POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
			{
				owner,
				repo,
				pull_number: pullNumber,
				reviewers,
				team_reviewers: team ? [team] : [],
			},
		);
	} catch (err) {
		console.warn("requesting a review failed", { error: String(err) });
	}
}

/** The CODEOWNERS team if there is one, then `reviewers.team`, plus every `reviewers.users`. */
export const escalationReviewers = (
	brief: { ownerTeam?: string },
	config: Config,
) => ({
	team: brief.ownerTeam ?? config.reviewers.team,
	users: config.reviewers.users,
});
