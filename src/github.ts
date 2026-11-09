import { App, Octokit } from "octokit";

/** The slice of Octokit the client uses, so tests can pass a fake. */
export type GithubTransport = Pick<Octokit, "request" | "graphql">;

export interface Repo {
	owner: string;
	repo: string;
}

export interface GithubClient {
	/** Check contexts required by the active rulesets for a branch. */
	requiredChecks(branch: string): Promise<string[]>;
	/** True only for an active member of the org team. */
	isTeamMember(org: string, teamSlug: string, login: string): Promise<boolean>;
	/** Run a GraphQL query, e.g. for project fields. */
	graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

export interface AppCredentials {
	appId: number;
	privateKey: string;
	installationId: number;
}

/** Octokit authenticated as an App installation. The App caches installation tokens until they near expiry. */
export function installationTransport(
	{ appId, privateKey, installationId }: AppCredentials,
	fetchImpl?: typeof fetch,
): Promise<GithubTransport> {
	const app = new App({
		appId,
		privateKey,
		...(fetchImpl && {
			Octokit: Octokit.defaults({ request: { fetch: fetchImpl } }),
		}),
	});
	return app.getInstallationOctokit(installationId);
}

export function createGithubClient(
	transport: GithubTransport,
	{ owner, repo }: Repo,
): GithubClient {
	return {
		async requiredChecks(branch) {
			const { data } = await transport.request(
				"GET /repos/{owner}/{repo}/rules/branches/{branch}",
				{ owner, repo, branch, per_page: 100 },
			);
			const contexts = data.flatMap((rule) =>
				rule.type === "required_status_checks"
					? (rule.parameters?.required_status_checks.map((c) => c.context) ??
						[])
					: [],
			);
			return [...new Set(contexts)];
		},

		async isTeamMember(org, teamSlug, login) {
			try {
				const { data } = await transport.request(
					"GET /orgs/{org}/teams/{team_slug}/memberships/{username}",
					{ org, team_slug: teamSlug, username: login },
				);
				return data.state === "active";
			} catch (err) {
				if ((err as { status?: number }).status === 404) return false;
				throw err;
			}
		},

		graphql<T>(query: string, variables?: Record<string, unknown>) {
			return transport.graphql<T>(query, variables);
		},
	};
}
