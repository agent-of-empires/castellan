import {
	CONFIG_PATH,
	type Config,
	githubReader,
	loadConfig,
} from "./config.js";
import type { GithubClient, GithubTransport, Repo } from "./github.js";
import type { ReviewInput, ReviewResult } from "./llm.js";
import { type Context, evaluate } from "./rules.js";
import { type AuthorClass, buildSnapshot, type Snapshot } from "./snapshot.js";
import { decide } from "./verdict.js";

export type OutcomeKind =
	| "merged_clean"
	| "changes_requested"
	| "changed_by_human"
	| "reverted"
	| "closed";

/** What humans did with the PR. Never shown to the rules or the model. */
export interface Outcome {
	kind: OutcomeKind;
	mergedAt: string | null;
	/** When the last check on the head SHA completed, if all were green. */
	ciGreenAt: string | null;
	/** Reviews on the PR by someone other than the author or a bot. */
	humanReviews: number;
}

/** A recorded PR as of its last head SHA. Fixtures are these, as JSON. */
export interface EvalCase {
	name: string;
	snapshot: Snapshot;
	context: Context;
	requiredChecks: string[];
	/** `.castellan.yml` text at the base commit; omitted means defaults. */
	config?: string;
	/** Recorded model verdict, used when the rules leave a candidate. */
	review?: ReviewResult;
	outcome: Outcome;
}

export type VerdictClass = "skip" | "escalate" | "merge";

export interface Result {
	case: EvalCase;
	verdict: VerdictClass;
}

const ZERO_REVIEW_BASELINE =
	"3 of 65 merged PRs had no independent review; 6 of the last 25 merges had none; reviewers per merge: 0 for 3, 1 for 45, 2 for 12, 3 for 5.";

export async function replay(cases: EvalCase[]): Promise<Result[]> {
	return Promise.all(
		cases.map(async (c) => {
			const loaded = await loadConfig("replay", async () => c.config ?? null);
			if (!loaded.ok) throw new Error(`${c.name}: ${loaded.error}`);
			const decision = evaluate(
				c.snapshot,
				loaded.config,
				c.requiredChecks,
				c.context,
			);
			const outcome = decide(decision, c.review);
			return { case: c, verdict: outcome?.verdict ?? "skip" };
		}),
	);
}

/** Runs `reviewFn` on cases the rules leave as candidates and records the result, so replay is deterministic afterwards. */
export async function recordReviews(
	cases: EvalCase[],
	reviewFn: (input: ReviewInput, config: Config) => Promise<ReviewResult>,
): Promise<EvalCase[]> {
	return Promise.all(
		cases.map(async (c) => {
			const loaded = await loadConfig("replay", async () => c.config ?? null);
			if (!loaded.ok) throw new Error(`${c.name}: ${loaded.error}`);
			const { outcome } = evaluate(
				c.snapshot,
				loaded.config,
				c.requiredChecks,
				c.context,
			);
			if (outcome !== "candidate") return c;
			const { title, body, diff } = c.snapshot;
			return {
				...c,
				review: await reviewFn({ title, body, diff }, loaded.config),
			};
		}),
	);
}

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
};

const pct = (n: number, d: number) =>
	d ? `${((100 * n) / d).toFixed(1)}% (${n}/${d})` : "n/a (0 cases)";

/** A `merge` verdict that humans did not merge as-is. */
export const mistakes = (results: Result[]) =>
	results.filter(
		(r) => r.verdict === "merge" && r.case.outcome.kind !== "merged_clean",
	);

/**
 * Precision: share of `merge` verdicts that humans merged with no changes
 * requested, no revert and no commit pushed by someone other than the author
 * or a bot. Coverage: share of all PRs considered that reached `merge`; the
 * share among judged (not skipped) PRs is reported separately. Recall is not reported; it is irrelevant for
 * safety (RFC agent-of-empires#5502, Rollout).
 */
export function renderReport(results: Result[], title: string): string {
	const merges = results.filter((r) => r.verdict === "merge");
	const judged = results.filter((r) => r.verdict !== "skip");
	const clean = merges.filter((r) => r.case.outcome.kind === "merged_clean");
	const kinds: OutcomeKind[] = [
		"merged_clean",
		"changes_requested",
		"changed_by_human",
		"reverted",
		"closed",
	];
	const hours = merges.flatMap(({ case: { outcome: o } }) =>
		o.mergedAt && o.ciGreenAt
			? [(Date.parse(o.mergedAt) - Date.parse(o.ciGreenAt)) / 3_600_000]
			: [],
	);
	const merged = results.filter((r) => r.case.outcome.kind !== "closed");
	const unreviewed = merged.filter((r) => r.case.outcome.humanReviews === 0);
	const bad = mistakes(results);

	return [
		`# ${title}`,
		"",
		`${results.length} PRs replayed, ${results.length - judged.length} skipped, ${judged.length} judged.`,
		"",
		"## Precision",
		"",
		`Precision of \`merge\`: ${pct(clean.length, merges.length)}`,
		"",
		"| Human outcome | `merge` verdicts |",
		"| --- | --- |",
		...kinds.map(
			(k) =>
				`| ${k} | ${merges.filter((r) => r.case.outcome.kind === k).length} |`,
		),
		"",
		"## Coverage",
		"",
		`- Share of all PRs in the merge class: ${pct(merges.length, results.length)}`,
		`- Share of judged PRs (skips excluded) in the merge class: ${pct(merges.length, judged.length)}`,
		`- Median CI green to merge, merge class: ${hours.length ? `${median(hours).toFixed(1)} h (${hours.length} PRs)` : "n/a"}`,
		`- Merged with zero human review: ${unreviewed.length} of ${merged.length}`,
		`  - castellan \`merge\`: ${unreviewed.filter((r) => r.verdict === "merge").length}`,
		`  - nobody reviewed (not a \`merge\` verdict): ${unreviewed.filter((r) => r.verdict !== "merge").length}`,
		`- Baseline (agent-of-empires#5485): ${ZERO_REVIEW_BASELINE}`,
		"",
		"## Mistakes",
		"",
		...(bad.length
			? bad.map((r) => `- ${r.case.name}: \`merge\` but ${r.case.outcome.kind}`)
			: ["None."]),
		"",
	].join("\n");
}

type Pull = {
	number: number;
	title: string;
	body: string | null;
	merged_at: string | null;
	closed_at: string | null;
	author_association: string;
	user: { login: string; type: string } | null;
	head: { sha: string };
};

const MEMBER = ["OWNER", "MEMBER"];
const REVERTS = /\breverts\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/gi;

/** Numbers of merged PRs that a later merged PR reverts, from "Reverts #n" bodies. */
export function revertedNumbers(pulls: Pick<Pull, "body" | "merged_at">[]) {
	return new Set(
		pulls
			.filter((p) => p.merged_at)
			.flatMap((p) =>
				[...(p.body ?? "").matchAll(REVERTS)].map((m) => Number(m[1])),
			),
	);
}

async function authorClass(
	pull: Pull,
	config: Config,
	org: string,
	client: GithubClient,
): Promise<AuthorClass> {
	const login = pull.user?.login ?? "";
	if (pull.user?.type === "Bot") return "bot";
	if (config.trustedAuthors.includes(login)) return "trusted";
	if (config.teams.maintainers) {
		const isMaintainer = await client.isTeamMember(
			org,
			config.teams.maintainers,
			login,
		);
		return isMaintainer ? "maintainer" : "external";
	}
	return MEMBER.includes(pull.author_association) ? "maintainer" : "external";
}

/**
 * Closed PRs from the last `sinceDays` days, each snapshotted at its last head
 * SHA with human reviews hidden. The model is not called; run it on the
 * candidates and store the result in `review`. Config is read at the PR base.
 */
export async function collectCases(
	transport: GithubTransport,
	client: GithubClient,
	{ owner, repo }: Repo,
	sinceDays: number,
	now = new Date(),
): Promise<EvalCase[]> {
	const since = now.getTime() - sinceDays * 86_400_000;
	const pulls: Pull[] = (
		await transport.paginate("GET /repos/{owner}/{repo}/pulls", {
			owner,
			repo,
			state: "closed",
			sort: "updated",
			direction: "desc",
			per_page: 100,
		})
	).filter((p) => Date.parse(p.closed_at ?? "") >= since);
	const reverted = revertedNumbers(pulls);
	const readFile = githubReader(transport, { owner, repo });
	const { data: info } = await transport.request("GET /repos/{owner}/{repo}", {
		owner,
		repo,
	});

	return Promise.all(
		pulls.map(async (pull): Promise<EvalCase> => {
			const draft = await buildSnapshot(
				transport,
				{ owner, repo },
				pull.number,
				"external",
				{ allowClosed: true },
			);
			const configText = await readFile(draft.baseSha, CONFIG_PATH);
			const loaded = await loadConfig(draft.baseSha, async () => configText);
			if (!loaded.ok) throw new Error(`#${pull.number}: ${loaded.error}`);
			const cls = await authorClass(pull, loaded.config, owner, client);

			const human = draft.reviews.filter(
				(r) => !r.login.endsWith("[bot]") && r.login !== draft.author,
			);
			const commits = await transport.paginate(
				"GET /repos/{owner}/{repo}/pulls/{pull_number}/commits",
				{ owner, repo, pull_number: pull.number, per_page: 100 },
			);
			// offline metric, not a trust decision: Bot type is enough
			const changedByHuman = commits.some(
				(c) =>
					c.author &&
					c.author.login !== draft.author &&
					c.author.type !== "Bot",
			);
			const merged = pull.merged_at !== null;
			const kind: OutcomeKind = !merged
				? "closed"
				: reverted.has(pull.number)
					? "reverted"
					: human.some((r) => r.state === "CHANGES_REQUESTED")
						? "changes_requested"
						: changedByHuman
							? "changed_by_human"
							: "merged_clean";
			const runs = await transport.paginate(
				"GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
				{ owner, repo, ref: draft.headSha, per_page: 100 },
			);
			const done = runs.map((r) => r.completed_at ?? "");
			const green =
				runs.length > 0 &&
				runs.every((r) =>
					["success", "neutral", "skipped"].includes(r.conclusion ?? ""),
				);

			return {
				name: `${owner}/${repo}#${pull.number}`,
				snapshot: {
					...draft,
					authorClass: cls,
					reviews: draft.reviews.filter((r) => r.login.endsWith("[bot]")),
				},
				context: {
					now: now.getTime(),
					defaultBranch: info.default_branch,
					codeowners: [],
					bugIssues: [],
				},
				requiredChecks: await client.requiredChecks(draft.baseRef),
				...(configText !== null && { config: configText }),
				outcome: {
					kind,
					mergedAt: pull.merged_at,
					ciGreenAt: green ? (done.sort().at(-1) ?? null) : null,
					humanReviews: human.length,
				},
			};
		}),
	);
}
