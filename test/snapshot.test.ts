import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import type { GithubTransport } from "../src/github.js";
import { evaluate } from "../src/rules.js";
import {
	BODY_CAP,
	buildSnapshot,
	DIFF_CAP,
	FILES_CAP,
} from "../src/snapshot.js";

const repo = { owner: "agent-of-empires", repo: "castellan" };

interface Over {
	body?: string | null;
	diff?: string;
	state?: string;
	merged?: boolean;
	heads?: string[];
	files?: unknown[];
	reviews?: unknown[];
	checks?: unknown[];
}

const review = (login: string, state: string, commit_id = "abc") => ({
	user: { login },
	state,
	commit_id,
	body: "SECRET",
});

function fixture(over: Over = {}) {
	const heads = [...(over.heads ?? ["abc"])];
	const pr = () => ({
		title: "fix: thing",
		body: "body" in over ? over.body : "Closes #1",
		user: { login: "alice" },
		state: over.state ?? "open",
		merged: over.merged ?? false,
		draft: false,
		base: { ref: "main", sha: "base1" },
		head: {
			ref: "fix/thing",
			sha: heads.length > 1 ? heads.shift() : heads[0],
		},
		labels: [{ name: "castellan:merge" }],
	});
	const request = vi.fn(
		async (_route: string, params: { mediaType?: unknown }) => ({
			data: params.mediaType ? (over.diff ?? "diff --git a b") : pr(),
		}),
	);
	const paginate = vi.fn(async (route: string, _params?: unknown) => {
		if (route.endsWith("/files"))
			return (
				over.files ?? [
					{ filename: "a.ts", status: "modified", additions: 2, deletions: 1 },
				]
			);
		if (route.endsWith("/reviews"))
			return (
				over.reviews ?? [
					review("coderabbitai[bot]", "CHANGES_REQUESTED", "old"),
					review("bob", "APPROVED"),
					review("coderabbitai[bot]", "APPROVED"),
				]
			);
		return (
			over.checks ?? [
				{ name: "lint", conclusion: "success" },
				{ name: "pr-title-check", conclusion: "skipped" },
				{ name: "slow", conclusion: null },
			]
		);
	});
	const transport = {
		request,
		paginate,
		graphql: vi.fn(),
	} as unknown as GithubTransport;
	return { transport, request, paginate };
}

const snap = (over: Over = {}) =>
	buildSnapshot(fixture(over).transport, repo, 7, "maintainer");

describe("buildSnapshot", () => {
	it("snapshots a merged PR only when allowClosed is set", async () => {
		const over = { state: "closed", merged: true };
		await expect(snap(over)).rejects.toThrow("not open");
		const s = await buildSnapshot(
			fixture(over).transport,
			repo,
			7,
			"maintainer",
			{ allowClosed: true },
		);
		expect(s.headSha).toBe("abc");
	});

	it("collects pr fields and every check run, mapping a null conclusion to pending", async () => {
		const { transport, paginate } = fixture();
		const s = await buildSnapshot(transport, repo, 7, "maintainer");
		expect(s).toMatchObject({
			title: "fix: thing",
			body: "Closes #1",
			author: "alice",
			authorClass: "maintainer",
			draft: false,
			baseRef: "main",
			baseSha: "base1",
			headRef: "fix/thing",
			headSha: "abc",
			linkedIssues: [1],
			codeRabbit: "APPROVED",
			files: [{ path: "a.ts", status: "modified", additions: 2, deletions: 1 }],
		});
		expect(s.checks).toEqual([
			{ name: "lint", conclusion: "success", startedAt: null },
			{ name: "pr-title-check", conclusion: "skipped", startedAt: null },
			{ name: "slow", conclusion: "pending", startedAt: null },
		]);
		expect(paginate).toHaveBeenCalledWith(
			"GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
			expect.objectContaining({ ref: "abc" }),
		);
	});

	it("keeps only the latest run of a check and reads started_at as epoch ms", async () => {
		const s = await snap({
			checks: [
				{
					id: 5,
					name: "codecov",
					conclusion: "success",
					started_at: "2026-01-01T00:00:00Z",
				},
				{
					id: 2,
					name: "codecov",
					conclusion: null,
					started_at: "2025-12-31T00:00:00Z",
				},
				{ id: 9, name: "lint", conclusion: "success", started_at: null },
			],
		});
		expect(s.checks).toEqual([
			{
				id: 5,
				name: "codecov",
				conclusion: "success",
				startedAt: Date.parse("2026-01-01T00:00:00Z"),
			},
			{ id: 9, name: "lint", conclusion: "success", startedAt: null },
		]);
	});

	it("keeps the latest run even when the API lists it last", async () => {
		const s = await snap({
			checks: [
				{ id: 2, name: "codecov", conclusion: "success" },
				{ id: 5, name: "codecov", conclusion: "in_progress" },
			],
		});
		expect(s.checks.map((c) => c.id)).toEqual([5]);
	});

	it("requests every paginated list with per_page 100", async () => {
		const { transport, paginate } = fixture();
		await buildSnapshot(transport, repo, 7, "maintainer");
		expect(paginate).toHaveBeenCalledTimes(3);
		for (const call of paginate.mock.calls) {
			expect(call[1]).toMatchObject({ per_page: 100 });
		}
	});

	it("caps body and diff with truncation flags and leaves exact-cap text alone", async () => {
		const s = await snap({
			body: "b".repeat(BODY_CAP + 50),
			diff: "d".repeat(DIFF_CAP + 50),
		});
		expect(s.body).toBe("b".repeat(BODY_CAP));
		expect(s.bodyTruncated).toBe(true);
		expect(s.diff).toBe("d".repeat(DIFF_CAP));
		expect(s.diffTruncated).toBe(true);
		const exact = await snap({
			body: "b".repeat(BODY_CAP),
			diff: "d".repeat(DIFF_CAP),
		});
		expect(exact.bodyTruncated).toBe(false);
		expect(exact.diffTruncated).toBe(false);
	});

	it("caps the file list and flags it", async () => {
		const file = (i: number) => ({
			filename: `f${i}`,
			status: "added",
			additions: 1,
			deletions: 0,
		});
		const many = await snap({
			files: Array.from({ length: FILES_CAP + 1 }, (_, i) => file(i)),
		});
		expect(many.files).toHaveLength(FILES_CAP);
		expect(many.filesTruncated).toBe(true);
		const exact = await snap({
			files: Array.from({ length: FILES_CAP }, (_, i) => file(i)),
		});
		expect(exact.filesTruncated).toBe(false);
	});

	it("parses linked issues from the full body before capping", async () => {
		const s = await snap({
			body: `${"x".repeat(BODY_CAP)}\nFixes #12, closes #3\nResolves #12`,
		});
		expect(s.bodyTruncated).toBe(true);
		expect(s.linkedIssues).toEqual([12, 3]);
	});

	it("returns an empty body and no linked issues for a null body", async () => {
		const s = await snap({ body: null });
		expect(s.body).toBe("");
		expect(s.linkedIssues).toEqual([]);
	});

	it("excludes labels and review bodies", async () => {
		const { transport, paginate } = fixture();
		const json = JSON.stringify(
			await buildSnapshot(transport, repo, 7, "maintainer"),
		);
		expect(json).not.toContain("castellan:merge");
		expect(json).not.toContain("SECRET");
		expect(paginate.mock.calls.map((c) => c[0]).join()).not.toMatch(
			/comments|labels/,
		);
	});
});

describe("codeRabbit state", () => {
	it("is null when CodeRabbit never reviewed", async () => {
		const s = await snap({ reviews: [review("bob", "APPROVED")] });
		expect(s.codeRabbit).toBeNull();
	});

	it("is not hidden by a later COMMENTED review", async () => {
		const s = await snap({
			reviews: [
				review("coderabbitai[bot]", "CHANGES_REQUESTED"),
				review("coderabbitai[bot]", "COMMENTED"),
			],
		});
		expect(s.codeRabbit).toBe("CHANGES_REQUESTED");
	});
});

describe("reviews", () => {
	it("keeps the commit id so approvals can be judged against the current head", async () => {
		const s = await snap({
			reviews: [review("bob", "APPROVED", "old"), review("eve", "APPROVED")],
		});
		const current = s.reviews.filter(
			(r) => r.state === "APPROVED" && r.commitId === s.headSha,
		);
		expect(current.map((r) => r.login)).toEqual(["eve"]);
	});
});

describe("guards", () => {
	it("throws when the head moves during the snapshot", async () => {
		await expect(snap({ heads: ["abc", "def"] })).rejects.toThrow(/head moved/);
	});

	it.each([{ state: "closed" }, { state: "open", merged: true }])(
		"throws unless the PR is open and unmerged (%o)",
		async (over) => {
			await expect(snap(over)).rejects.toThrow(/not open/);
		},
	);

	it("fails closed when a request is rejected", async () => {
		const { transport, request } = fixture();
		request.mockRejectedValue(new Error("406 diff too large"));
		await expect(
			buildSnapshot(transport, repo, 7, "maintainer"),
		).rejects.toThrow(/406/);
	});

	const failDiff = (
		request: ReturnType<typeof fixture>["request"],
		err: object,
	) => {
		const impl = request.getMockImplementation();
		request.mockImplementation(async (route, params) => {
			if (params.mediaType) throw Object.assign(new Error("diff failed"), err);
			return (impl as NonNullable<typeof impl>)(route, params);
		});
	};
	const tooLarge = {
		status: 406,
		response: { data: { errors: [{ field: "diff", code: "too_large" }] } },
	};

	it("treats a 406 too_large diff as an empty truncated diff that escalates", async () => {
		const { transport, request } = fixture({
			checks: [{ name: "lint", conclusion: "success" }],
		});
		failDiff(request, tooLarge);
		const s = await buildSnapshot(transport, repo, 7, "maintainer");
		expect(s.diff).toBe("");
		expect(s.diffTruncated).toBe(true);
		const r = await loadConfig("main", async () => "");
		if (!r.ok) throw new Error(r.error);
		const d = evaluate(s, r.config, ["lint"], {
			now: Date.now(),
			defaultBranch: "main",
			codeowners: [],
			bugIssues: [],
		});
		expect(d.outcome).toBe("escalate");
		expect(d.reasons.map((x) => x.rule)).toEqual(["diff_truncated"]);
	});

	it.each([
		{ status: 500 },
		{ status: 404 },
		{
			status: 406,
			response: { data: { errors: [{ code: "other" }] } },
		},
	])("still throws when the diff request fails with %o", async (err) => {
		const { transport, request } = fixture();
		failDiff(request, err);
		await expect(
			buildSnapshot(transport, repo, 7, "maintainer"),
		).rejects.toThrow(/diff failed/);
	});

	it("fails closed when a paginated fetch is rejected", async () => {
		const { transport, paginate } = fixture();
		paginate.mockRejectedValue(new Error("502"));
		await expect(
			buildSnapshot(transport, repo, 7, "maintainer"),
		).rejects.toThrow(/502/);
	});
});
