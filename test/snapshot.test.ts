import { describe, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import { BODY_CAP, buildSnapshot, DIFF_CAP } from "../src/snapshot.js";

const repo = { owner: "agent-of-empires", repo: "castellan" };

function fixture(over: { body?: string | null; diff?: string } = {}) {
	const pr = {
		title: "fix: thing",
		body: "body" in over ? over.body : "Closes #1",
		user: { login: "alice" },
		head: { sha: "abc" },
		labels: [{ name: "castellan:merge" }],
	};
	const request = vi.fn(
		async (_route: string, params: { mediaType?: unknown }) => ({
			data: params.mediaType ? (over.diff ?? "diff --git a b") : pr,
		}),
	);
	const paginate = vi.fn(async (route: string) => {
		if (route.endsWith("/files"))
			return [
				{ filename: "a.ts", status: "modified", additions: 2, deletions: 1 },
			];
		if (route.endsWith("/reviews"))
			return [
				{
					user: { login: "coderabbitai[bot]" },
					state: "CHANGES_REQUESTED",
					commit_id: "old",
					body: "SECRET",
				},
				{
					user: { login: "bob" },
					state: "APPROVED",
					commit_id: "abc",
					body: "SECRET",
				},
				{
					user: { login: "coderabbitai[bot]" },
					state: "APPROVED",
					commit_id: "abc",
					body: "SECRET",
				},
			];
		return [
			{ name: "lint", conclusion: "success" },
			{ name: "pr-title-check", conclusion: "skipped" },
			{ name: "slow", conclusion: null },
		];
	});
	const transport = {
		request,
		paginate,
		graphql: vi.fn(),
	} as unknown as GithubTransport;
	return { transport, paginate };
}

describe("buildSnapshot", () => {
	it("collects pr fields, every check run by name and conclusion, and the latest CodeRabbit state", async () => {
		const { transport, paginate } = fixture();
		const s = await buildSnapshot(transport, repo, 7, "maintainer");
		expect(s).toMatchObject({
			title: "fix: thing",
			body: "Closes #1",
			author: "alice",
			authorClass: "maintainer",
			headSha: "abc",
			codeRabbit: "APPROVED",
			files: [{ path: "a.ts", status: "modified", additions: 2, deletions: 1 }],
		});
		expect(s.checks).toEqual([
			{ name: "lint", conclusion: "success" },
			{ name: "pr-title-check", conclusion: "skipped" },
			{ name: "slow", conclusion: null },
		]);
		expect(paginate).toHaveBeenCalledWith(
			"GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
			expect.objectContaining({ ref: "abc" }),
		);
	});

	it("caps body and diff and leaves short text alone", async () => {
		const { transport } = fixture({
			body: "b".repeat(BODY_CAP + 50),
			diff: "d".repeat(DIFF_CAP + 50),
		});
		const s = await buildSnapshot(transport, repo, 7, "external");
		expect(s.body).toBe(`${"b".repeat(BODY_CAP)}\n[truncated]`);
		expect(s.diff).toBe(`${"d".repeat(DIFF_CAP)}\n[truncated]`);
		const short = await buildSnapshot(
			fixture({ body: "b".repeat(BODY_CAP) }).transport,
			repo,
			7,
			"x",
		);
		expect(short.body).toBe("b".repeat(BODY_CAP));
	});

	it("handles a null body and codeRabbit absent", async () => {
		const { transport } = fixture({ body: null });
		const s = await buildSnapshot(transport, repo, 7, "bot");
		expect(s.body).toBe("");
	});

	it("excludes labels and review/comment bodies", async () => {
		const { transport, paginate } = fixture();
		const s = await buildSnapshot(transport, repo, 7, "maintainer");
		const json = JSON.stringify(s);
		expect(json).not.toContain("castellan:merge");
		expect(json).not.toContain("SECRET");
		expect(paginate.mock.calls.map((c) => c[0]).join()).not.toMatch(
			/comments|labels/,
		);
	});
});
