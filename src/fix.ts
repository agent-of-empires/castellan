import type { DiffAdditions } from "./diff.js";
import type { GithubTransport, Repo } from "./github.js";
import type { OkReviewResult } from "./llm.js";
import { suggestionText } from "./review.js";

/** The trailer castellan puts on a fix commit, so the commit says who wrote it. */
export const FIX_TRAILER = /^castellan-fix:/m;

/** Suggestions applied per commit. A review that needs more is a rewrite, not a fix. */
export const MAX_FIXES = 5;

/**
 * Castellan commits allowed on one PR, counted from its commit list. The bound
 * does not depend on GitHub mapping the App's email to a login, which can be
 * null and would otherwise leave the loop guard open.
 */
export const MAX_COMMITS = 3;

const HEADLINE = "fix: apply castellan review suggestions";

/**
 * Paths a fix may write: prose only. A suggestion is written from text the
 * model read, including issue and thread bodies anyone can write, and a commit
 * runs whatever CI executes before a human reads it, which is a denylist no one
 * can keep complete (`src/`, `test/`, `scripts/` and every config they read). So
 * only files no build reads are writable, and a code suggestion stays a comment
 * the author can apply themselves. `.mdx` is excluded for the same reason as
 * `.ts`: it compiles to JavaScript in Astro, Docusaurus and Next.js builds.
 */
const NON_EXECUTED = /\.md$/i;

export interface Fix {
	path: string;
	/** New-file line number, the same one an inline comment would use. */
	line: number;
	/** What the diff says that line reads now, so a stale edit is refused. */
	expected: string;
	suggestion: string;
}

export interface PushedFixes {
	sha: string;
	count: number;
}

export interface PlanScope {
	/** Paths the PR itself changes and does not delete, so a fix cannot invent a file. */
	changed: Set<string>;
	/** True for a path a fix must not write: config, CODEOWNERS, `.github/`, protected. */
	protectedPath: (path: string) => boolean;
	limit?: number;
}

/**
 * The suggestions worth applying: one line, anchored to an added line of the
 * diff, in a prose file this PR changes that no rule protects, and different
 * from what is there now. Everything else stays a comment the author can take
 * or leave.
 */
export function planFixes(
	review: OkReviewResult,
	added: DiffAdditions,
	{ changed, protectedPath, limit = MAX_FIXES }: PlanScope,
): Fix[] {
	const out: Fix[] = [];
	const used = new Set<string>();
	for (const r of review.verdict.reasons) {
		if (out.length >= limit) break;
		// Issue #124 scopes pushed fixes to `nit` and `concern`: a blocker is a
		// finding for a person to weigh, not something to rewrite in place.
		if (r.severity === "blocker") continue;
		if (!r.path || r.line === undefined) continue;
		if (!NON_EXECUTED.test(r.path)) continue;
		if (!changed.has(r.path) || protectedPath(r.path)) continue;
		const expected = added.get(r.path)?.get(r.line);
		if (expected === undefined) continue;
		const suggestion = suggestionText(r.suggestion);
		if (suggestion === undefined || suggestion === expected) continue;
		const key = `${r.path}:${r.line}`;
		if (used.has(key)) continue;
		used.add(key);
		out.push({ path: r.path, line: r.line, expected, suggestion });
	}
	return out;
}

/**
 * The file with each line replaced, or undefined when a line no longer reads as
 * the diff showed it: a suggestion is only ever applied to the code it was
 * written about.
 */
export function replaceLines(text: string, fixes: Fix[]): string | undefined {
	const lines = text.split("\n");
	for (const fix of fixes) {
		const at = fix.line - 1;
		const current = lines[at];
		if (current === undefined) return undefined;
		const cr = current.endsWith("\r");
		if ((cr ? current.slice(0, -1) : current) !== fix.expected)
			return undefined;
		lines[at] = fix.suggestion + (cr ? "\r" : "");
	}
	return lines.join("\n");
}

/** The trailer marks the commit as castellan's, even if its email maps to nobody. */
const message = (count: number, head: string) => ({
	headline: HEADLINE,
	body: `${count} one line ${
		count === 1 ? "fix" : "fixes"
	} from the review of ${head.slice(0, 7)}.\n\ncastellan-fix: ${count}\n`,
});

export interface PushScope {
	head: string;
	headRef: string;
	headRepoId: number | null;
	baseRepoId: number | null;
	baseRef: string;
	defaultBranch: string;
	/** Castellan commits already on the PR, from `snapshot.commits`. */
	castellanCommits: number;
	fixes: Fix[];
}

/**
 * Applies the fixes as one commit on the pull request's own branch. Best effort:
 * a failed push leaves the suggestion as a comment, which is where it started.
 *
 * Every guard runs before the first request. The commit is written with
 * `createCommitOnBranch` and `expectedHeadOid`, so it lands only if the branch
 * is still at the head this review read, and it never reaches a fork or a
 * default branch.
 */
export async function pushFixes(
	transport: GithubTransport,
	{ owner, repo }: Repo,
	{
		head,
		headRef,
		headRepoId,
		baseRepoId,
		baseRef,
		defaultBranch,
		castellanCommits,
		fixes,
	}: PushScope,
): Promise<PushedFixes | undefined> {
	if (!fixes.length || !headRef) return undefined;
	// A fork's head lives in another repository; writing to the base repo under
	// the same branch name would move code nobody asked castellan to touch.
	if (headRepoId === null || baseRepoId === null || headRepoId !== baseRepoId)
		return undefined;
	// Never write the branch the PR merges into, under either name for it.
	if (headRef === baseRef || headRef === defaultBranch) return undefined;
	if (castellanCommits >= MAX_COMMITS) return undefined;
	try {
		const commit = await transport.request(
			"GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
			{ owner, repo, commit_sha: head },
		);
		const tree = await transport.request(
			"GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
			{ owner, repo, tree_sha: commit.data.tree.sha, recursive: "1" },
		);
		// A truncated tree means a path's mode cannot be checked, so nothing is written.
		if (tree.data.truncated) return undefined;
		const entries = new Map(
			tree.data.tree.filter((e) => e.type === "blob").map((e) => [e.path, e]),
		);
		const additions: { path: string; contents: string }[] = [];
		let count = 0;
		for (const path of new Set(fixes.map((f) => f.path))) {
			const entry = entries.get(path);
			// A symlink or a submodule is not a file of lines; only a regular file
			// is edited, and its mode comes from the tree so the exec bit survives.
			if (!entry || (entry.mode !== "100644" && entry.mode !== "100755"))
				continue;
			const blob = await transport.request(
				"GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
				{ owner, repo, file_sha: entry.sha },
			);
			const bytes = Buffer.from(blob.data.content, "base64");
			const raw = bytes.toString("utf8");
			// Rewriting a file that is not UTF-8 would change every byte of it, not
			// the one line a fix names.
			if (!Buffer.from(raw, "utf8").equals(bytes)) continue;
			const mine = fixes.filter((f) => f.path === path);
			const text = replaceLines(raw, mine);
			if (text === undefined || text === raw) continue;
			additions.push({
				path,
				contents: Buffer.from(text, "utf8").toString("base64"),
			});
			count += mine.length;
		}
		if (!additions.length) return undefined;
		const made = await transport.graphql<{
			createCommitOnBranch: { commit: { oid: string } };
		}>(
			`mutation($input: CreateCommitOnBranchInput!) {
				createCommitOnBranch(input: $input) { commit { oid } }
			}`,
			{
				input: {
					branch: {
						repositoryNameWithOwner: `${owner}/${repo}`,
						branchName: headRef,
					},
					message: message(count, head),
					fileChanges: { additions },
					// Atomic: a branch that moved is refused, not overwritten.
					expectedHeadOid: head,
				},
			},
		);
		const sha = made.createCommitOnBranch.commit.oid;
		return { sha, count };
	} catch (err) {
		console.warn("could not push fixes", {
			error: String(err).slice(0, 200),
		});
		return undefined;
	}
}
