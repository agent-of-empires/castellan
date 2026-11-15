import type { GithubTransport, Repo } from "./github.js";
import { hashOf } from "./llm.js";

/** Most reviewed PRs on a busy repo stay under this; the rest are old and usually stale. */
export const MAX_THREADS = 25;
export const THREAD_BODY_CAP = 900;
const MAX_PAGES = 3;

export interface ReviewThread {
	/** GitHub's node id; only the cache key uses it. */
	id: string;
	author: string;
	/** `author` ends with `[bot]`. */
	bot: boolean;
	/** The anchored lines moved since the comment, so the quote may not match. */
	outdated: boolean;
	path?: string;
	line?: number;
	body: string;
}

/** REST has no resolution state, so this is the one place the pipeline needs GraphQL. */
const QUERY = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          comments(first: 1) {
            nodes { author { login } path line body }
          }
        }
      }
    }
  }
}`;

interface Node {
	id?: string;
	isResolved?: boolean;
	isOutdated?: boolean;
	comments?: {
		nodes?: {
			author?: { login?: string } | null;
			path?: string | null;
			line?: number | null;
			body?: string;
		}[];
	};
}

type Connection = {
	pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
	nodes?: Node[];
};

type Page = {
	repository?: { pullRequest?: { reviewThreads?: Connection } };
};

/**
 * Unresolved review threads on a PR, oldest first. Best effort: any failure is an
 * empty list, because a missing thread must never fail an evaluation. Resolved
 * threads and castellan's own comments are dropped, so the model sees the review
 * state it is expected to answer rather than its own previous output.
 */
export async function readThreads(
	transport: GithubTransport,
	{ owner, repo }: Repo,
	pullNumber: number,
	self?: string,
): Promise<ReviewThread[]> {
	const found: ReviewThread[] = [];
	try {
		let cursor: string | null = null;
		for (let page = 0; page < MAX_PAGES; page++) {
			const data: Page = await transport.graphql<Page>(QUERY, {
				owner,
				repo,
				number: pullNumber,
				cursor,
			});
			const threads: Connection | undefined =
				data.repository?.pullRequest?.reviewThreads;
			for (const node of threads?.nodes ?? []) {
				if (node.isResolved) continue;
				const first = node.comments?.nodes?.[0];
				const body = (first?.body ?? "").trim();
				const author = first?.author?.login ?? "";
				if (!body || (self && author === self)) continue;
				found.push({
					id:
						node.id ??
						`${author}:${first?.path ?? ""}:${first?.line ?? ""}:${body.slice(0, 64)}`,
					author,
					bot: author.endsWith("[bot]"),
					outdated: node.isOutdated ?? false,
					path: first?.path ?? undefined,
					line: first?.line ?? undefined,
					body:
						body.length > THREAD_BODY_CAP
							? `${body.slice(0, THREAD_BODY_CAP)}...`
							: body,
				});
			}
			if (!threads?.pageInfo?.hasNextPage || !threads.pageInfo.endCursor) break;
			cursor = threads.pageInfo.endCursor;
		}
	} catch (err) {
		console.warn("review threads unavailable", { error: String(err) });
		return [];
	}
	return found.slice(0, MAX_THREADS);
}

/** Part of the verdict cache key: a new or resolved thread must re-run the model. */
export const threadsKey = (threads: ReviewThread[]) =>
	hashOf(threads.map((t) => `${t.id}:${t.outdated}`)).slice(0, 16);

/** The `reviewThreads` prompt field, or undefined when there is nothing to verify. */
export function renderThreads(threads: ReviewThread[]): string | undefined {
	if (!threads.length) return undefined;
	const intro = `${threads.length} unresolved review thread(s), oldest first. Each is a prior finding: decide whether it still applies at this head, and add your own reason only where it does not cover the problem.`;
	const rows = threads.map((t, i) => {
		const where = t.path ? ` at ${t.path}${t.line ? `:${t.line}` : ""}` : "";
		const state = t.outdated ? ", outdated anchor" : "";
		return `${i + 1}. ${t.bot ? "bot" : "human"} ${t.author || "unknown"}${where}${state}:\n${t.body}`;
	});
	return [intro, ...rows].join("\n\n");
}
