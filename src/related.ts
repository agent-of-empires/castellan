import type { GithubTransport, Repo } from "./github.js";

/** Open PRs named in a brief at most; more than this stops reading like a warning. */
export const RELATED_LIMIT = 5;
/** Open PRs looked at per review, most recently updated first. One GraphQL call however many there are. */
export const SCAN_LIMIT = 20;

export interface RelatedPr {
	number: number;
	title: string;
	/** The paths this PR and the reviewed one both change. */
	overlap: string[];
}

const QUERY = `query($owner: String!, $repo: String!, $first: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: $first, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number
        title
        baseRefName
        files(first: 100) { nodes { path } }
      }
    }
  }
}`;

/**
 * Open PRs that change a file this PR changes, sorted by how much they overlap.
 *
 * Same file is not the same hunk, so this is advisory: it goes in the brief, not
 * in the verdict. Best effort, and never throws: an empty list is a valid answer.
 */
export async function relatedOpenPrs(
	transport: GithubTransport,
	{ owner, repo }: Repo,
	pullNumber: number,
	/** Only a PR targeting the same base can conflict: a stacked child contains this PR by construction. */
	baseRef: string,
	paths: string[],
): Promise<RelatedPr[]> {
	if (!paths.length) return [];
	const mine = new Set(paths);
	try {
		const data = await transport.graphql<{
			repository?: {
				pullRequests?: {
					nodes?: {
						number: number;
						title: string;
						baseRefName?: string;
						files?: { nodes?: { path: string }[] };
					}[];
				};
			};
		}>(QUERY, { owner, repo, first: SCAN_LIMIT });
		const nodes = data.repository?.pullRequests?.nodes ?? [];
		return (
			nodes
				.filter((n) => n.number !== pullNumber)
				.filter((n) => n.baseRefName === baseRef)
				.map((n) => ({
					number: n.number,
					title: n.title,
					overlap: (n.files?.nodes ?? [])
						.map((f) => f.path)
						.filter((p) => mine.has(p)),
				}))
				.filter((n) => n.overlap.length)
				// A stable tiebreak keeps the line from changing when another PR is touched.
				.sort(
					(a, b) => b.overlap.length - a.overlap.length || a.number - b.number,
				)
				.slice(0, RELATED_LIMIT)
		);
	} catch (err) {
		console.warn("could not list open pull requests", {
			error: String(err).slice(0, 200),
		});
		return [];
	}
}
