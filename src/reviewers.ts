import type { Config } from "./config.js";
import type { GithubTransport, Repo } from "./github.js";
import { type CodeownersRule, matchesPath, slug } from "./rules.js";

const TEAM = /^@([^/]+)\/(.+)$/;

/**
 * The team that owns the change, from CODEOWNERS: for each changed file, the
 * last rule that matches, and that rule's first team owner. A plain `@user`
 * owner is not a team, and a team of another org cannot be requested on this
 * repo, so both are skipped: an escalation is asked of a team that owns the code
 * here rather than of the whole maintainer group.
 */
export function ownedTeam(
	files: string[],
	codeowners: CodeownersRule[],
	owner?: string,
): string | undefined {
	for (const path of files) {
		const rule = codeowners.findLast((r) => matchesPath(r.pattern, path));
		for (const o of rule?.owners ?? []) {
			const team = TEAM.exec(o);
			if (!team?.[1] || !team[2]) continue;
			if (owner && team[1].toLowerCase() !== owner.toLowerCase()) continue;
			return slug(team[2]);
		}
	}
	return undefined;
}

/**
 * Asks the configured reviewers for a review. Best effort: a PR that cannot be
 * assigned still gets its escalation comment, so the run is never failed by
 * this. The PR author is dropped because GitHub rejects a review request for
 * them. The team travels in its own call, so one invalid user login cannot
 * reject the request that names the owning team.
 */
export async function requestReviewers(
	transport: GithubTransport,
	{ owner, repo }: Repo,
	pullNumber: number,
	{ team, users, author }: { team?: string; users: string[]; author: string },
): Promise<boolean> {
	const reviewers = users.filter(
		(u) => u && u.toLowerCase() !== author.toLowerCase(),
	);
	const ask = async (body: {
		reviewers?: string[];
		team_reviewers?: string[];
	}) => {
		try {
			await transport.request(
				"POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
				{ owner, repo, pull_number: pullNumber, ...body },
			);
			return true;
		} catch (err) {
			// A request that failed must be retried on the next event, so the caller
			// records the head only when this returns true.
			console.warn("requesting a review failed", { error: String(err) });
			return false;
		}
	};
	const asked = [
		...(team ? [await ask({ team_reviewers: [slug(team)] })] : []),
		...(reviewers.length ? [await ask({ reviewers })] : []),
	];
	return asked.length > 0 && asked.every(Boolean);
}

/** The CODEOWNERS team if there is one, then `reviewers.team`, plus every `reviewers.users`. */
export const escalationReviewers = (
	brief: { ownerTeam?: string },
	config: Config,
) => ({
	team: brief.ownerTeam ?? config.reviewers.team,
	users: config.reviewers.users,
});
