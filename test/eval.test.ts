import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
	collectCases,
	type EvalCase,
	mistakes,
	type OutcomeKind,
	recordReviews,
	renderReport,
	replay,
	revertedNumbers,
} from "../src/eval.js";
import type { GithubClient, GithubTransport } from "../src/github.js";
import type { ReviewResult } from "../src/llm.js";

const DIR = "eval/fixtures";
const fixtures: EvalCase[] = readdirSync(DIR)
	.filter((f) => f.endsWith(".json"))
	.sort()
	.map((f) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")));

describe("fixtures", () => {
	it("has no merge verdict that humans did not merge as-is", async () => {
		const results = await replay(fixtures);
		expect(mistakes(results)).toEqual([]);
	});

	it("replays each fixture to its expected verdict", async () => {
		const results = await replay(fixtures);
		expect(
			Object.fromEntries(results.map((r) => [r.case.name, r.verdict])),
		).toEqual({
			"fixture/escalate-external-feat": "escalate",
			"fixture/escalate-failing-check": "escalate",
			"fixture/escalate-protected-path": "escalate",
			"fixture/merge-clean": "merge",
			"fixture/skip-draft": "skip",
			"fixture/veto-unrelated-change": "escalate",
		});
	});
});

const base = fixtures.find((c) => c.name === "fixture/merge-clean") as EvalCase;
const merged = (
	kind: OutcomeKind,
	over: Partial<EvalCase["outcome"]> = {},
): EvalCase => ({
	...base,
	name: `case-${kind}`,
	outcome: { ...base.outcome, kind, ...over },
});

describe("renderReport", () => {
	it("reports precision, coverage and the zero-review split", async () => {
		const cases = [
			merged("merged_clean", {
				ciGreenAt: "2026-01-01T00:00:00Z",
				mergedAt: "2026-01-01T02:00:00Z",
			}),
			merged("merged_clean", {
				ciGreenAt: "2026-01-01T00:00:00Z",
				mergedAt: "2026-01-01T04:00:00Z",
				humanReviews: 0,
			}),
			merged("reverted"),
			merged("closed", { mergedAt: null }),
			{ ...base, name: "draft", snapshot: { ...base.snapshot, draft: true } },
			{
				...base,
				name: "unreviewed-escalate",
				snapshot: {
					...base.snapshot,
					title: "feat!: x",
					authorClass: "external" as const,
				},
				outcome: { ...base.outcome, humanReviews: 0 },
			},
		];
		const report = renderReport(await replay(cases), "T");
		expect(report).toContain("5 judged");
		expect(report).toContain("Precision of `merge`: 50.0% (2/4)");
		expect(report).toContain("| reverted | 1 |");
		expect(report).toContain("| closed | 1 |");
		expect(report).toContain("in the merge class: 80.0% (4/5)");
		expect(report).toContain("merge class: 2.0 h (3 PRs)");
		expect(report).toContain("Merged with zero human review: 2 of 5");
		expect(report).toContain("castellan `merge`: 1");
		expect(report).toContain("nobody reviewed (not a `merge` verdict): 1");
		expect(report).toContain("agent-of-empires#5485");
		expect(report).toContain("case-reverted: `merge` but reverted");
	});

	it("does not divide by zero with no merge verdicts", () => {
		expect(renderReport([], "T")).toContain("Precision of `merge`: n/a");
	});
});

describe("recordReviews", () => {
	it("reviews only rule candidates", async () => {
		const reviewFn = vi.fn(async () => base.review as ReviewResult);
		const stripped = fixtures.map(({ review: _r, ...c }) => c);
		const out = await recordReviews(stripped, reviewFn);
		expect(reviewFn).toHaveBeenCalledTimes(2);
		expect(
			out
				.filter((c) => c.review)
				.map((c) => c.name)
				.sort(),
		).toEqual(["fixture/merge-clean", "fixture/veto-unrelated-change"]);
	});
});

describe("revertedNumbers", () => {
	it("reads Reverts #n from merged PR bodies only", () => {
		expect([
			...revertedNumbers([
				{ body: "Reverts agent-of-empires/castellan#12", merged_at: "t" },
				{ body: "Reverts #13", merged_at: "t" },
				{ body: "Reverts #14", merged_at: null },
				{ body: null, merged_at: "t" },
			]),
		]).toEqual([12, 13]);
	});
});

describe("collectCases", () => {
	const now = new Date("2026-02-01T00:00:00Z");
	const pull = (n: number, over: object = {}) => ({
		number: n,
		title: "fix: thing",
		body: "Closes #1",
		merged_at: "2026-01-20T12:00:00Z",
		closed_at: "2026-01-20T12:00:00Z",
		author_association: "MEMBER",
		user: { login: "alice", type: "User" },
		head: { sha: `sha${n}` },
		...over,
	});
	const pulls = [
		pull(1),
		pull(2, { merged_at: null }),
		pull(3, { body: "Reverts #1" }),
		pull(4, { closed_at: "2025-01-01T00:00:00Z" }),
	];
	const review = (login: string, state: string) => ({
		user: { login },
		state,
		commit_id: "x",
	});
	const request = vi.fn(async (route: string, p: Record<string, unknown>) => {
		if (route === "GET /repos/{owner}/{repo}")
			return { data: { default_branch: "main" } };
		if (route.endsWith("/contents/{path}"))
			return Promise.reject({ status: 404 });
		const n = Number(String(p.pull_number));
		return {
			data: p.mediaType
				? "diff"
				: {
						...pull(n),
						state: "closed",
						merged: true,
						draft: false,
						base: { ref: "main", sha: "b" },
						head: { ref: "fix/x", sha: `sha${n}` },
					},
		};
	});
	const paginate = vi.fn(async (route: string, p: Record<string, unknown>) => {
		if (route === "GET /repos/{owner}/{repo}/pulls") return pulls;
		if (route.endsWith("/files"))
			return [
				{ filename: "a.ts", status: "modified", additions: 1, deletions: 0 },
			];
		if (route.endsWith("/reviews"))
			return p.pull_number === 3
				? [
						review("bob", "CHANGES_REQUESTED"),
						review("coderabbitai[bot]", "APPROVED"),
					]
				: [review("bob", "APPROVED")];
		return [
			{
				name: "a",
				conclusion: "success",
				completed_at: "2026-01-20T10:00:00Z",
			},
			{
				name: "b",
				conclusion: "success",
				completed_at: "2026-01-20T11:00:00Z",
			},
		];
	});
	const transport = { request, paginate } as unknown as GithubTransport;
	const client = {
		requiredChecks: async () => ["a"],
	} as unknown as GithubClient;

	it("snapshots closed PRs in the window with outcomes hidden from the snapshot", async () => {
		const cases = await collectCases(
			transport,
			client,
			{ owner: "o", repo: "r" },
			90,
			now,
		);
		expect(cases.map((c) => [c.name, c.outcome.kind])).toEqual([
			["o/r#1", "reverted"],
			["o/r#2", "closed"],
			["o/r#3", "changes_requested"],
		]);
		const [first, , third] = cases;
		expect(first?.snapshot).toMatchObject({
			authorClass: "maintainer",
			headSha: "sha1",
			reviews: [],
		});
		expect(first?.outcome).toMatchObject({
			ciGreenAt: "2026-01-20T11:00:00Z",
			humanReviews: 1,
		});
		expect(third?.snapshot.reviews).toEqual([
			{ login: "coderabbitai[bot]", state: "APPROVED", commitId: "x" },
		]);
		expect(first?.requiredChecks).toEqual(["a"]);
	});
});
