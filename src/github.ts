import { App, Octokit } from "octokit";

/** The slice of Octokit the client uses, so tests can pass a fake. */
export type GithubTransport = Pick<Octokit, "request" | "graphql" | "paginate">;

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

function newApp(
	{ appId, privateKey }: AppCredentials,
	fetchImpl?: typeof fetch,
) {
	return new App({
		appId,
		privateKey,
		...(fetchImpl && {
			Octokit: Octokit.defaults({ request: { fetch: fetchImpl } }),
		}),
	});
}

/** Octokit authenticated as an App installation. The App caches installation tokens until they near expiry. */
export function installationTransport(
	creds: AppCredentials,
	fetchImpl?: typeof fetch,
): Promise<GithubTransport> {
	return newApp(creds, fetchImpl).getInstallationOctokit(creds.installationId);
}

/** The App's own `<slug>[bot]` login, from `GET /app` (App JWT, not an installation token). */
export async function appLogin(
	creds: AppCredentials,
	fetchImpl?: typeof fetch,
): Promise<string> {
	const { data } = await newApp(creds, fetchImpl).octokit.request("GET /app");
	if (!data?.slug) throw new Error("GET /app returned no slug");
	return `${data.slug}[bot]`;
}

export function createGithubClient(
	transport: GithubTransport,
	{ owner, repo }: Repo,
): GithubClient {
	return {
		async requiredChecks(branch) {
			const rules = await transport.paginate(
				"GET /repos/{owner}/{repo}/rules/branches/{branch}",
				{ owner, repo, branch, per_page: 100 },
			);
			const contexts = rules.flatMap((rule) =>
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
				if ((err as { status?: number }).status !== 404) throw err;
				// 404 is ambiguous: non-member, or the team is missing / unreadable.
				try {
					await transport.request("GET /orgs/{org}/teams/{team_slug}", {
						org,
						team_slug: teamSlug,
					});
				} catch (teamErr) {
					if ((teamErr as { status?: number }).status === 404) {
						throw new Error(
							`team ${org}/${teamSlug} not found or not readable by the App (needs members:read)`,
						);
					}
					throw teamErr;
				}
				return false;
			}
		},

		graphql<T>(query: string, variables?: Record<string, unknown>) {
			return transport.graphql<T>(query, variables);
		},
	};
}
