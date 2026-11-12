import { describe, expect, it, vi } from "vitest";
import { act } from "../src/act.js";
import type { Brief } from "../src/comment.js";
import { type Config, loadConfig } from "../src/config.js";
import type { GithubTransport } from "../src/github.js";
import type { Context } from "../src/rules.js";
import type { Snapshot } from "../src/snapshot.js";

const APPROVE = "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews";
const STATUS = "POST /repos/{owner}/{repo}/statuses/{sha}";
const MERGE = "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge";
const COMMENT = "POST /repos/{owner}/{repo}/issues/{issue_number}/comments";

const repo = { owner: "o", repo: "r" };
const author = { login: "castellan[bot]" };
const commentUrl = "https://github.com/o/r/pull/3#issuecomment-7";

const load = async (yaml: string): Promise<Config> => {
	const r = await loadConfig("base", async () => yaml);
	if (!r.ok) throw new Error(r.error);
	return r.config;
};

const snapshot = (paths: string[] = ["src/a.ts"]) =>
	({
		headSha: "head1",
		files: paths.map((path) => ({
			path,
			status: "modified",
			additions: 1,
			deletions: 0,
		})),
	}) as Snapshot;

const ctx: Context = {
	now: 0,
	defaultBranch: "main",
	codeowners: [],
	bugIssues: [],
};

const brief = (verdict: "merge" | "escalate" = "merge"): Brief => ({
	outcome: { verdict, reasons: [] },
	key: {
		headSha: "head1",
		model: "m",
		promptHash: "p".repeat(12),
	} as Brief["key"],
	checks: [],
	source: "skipped",
});

interface World {
	head?: string;
	state?: string;
	autoMerge?: object | null;
	reviews?: unknown[];
	reviewError?: Error;
	graphqlError?: Error;
}

function fake({
	head = "head1",
	state = "open",
	autoMerge = null,
	reviews = [],
	reviewError,
	graphqlError,
}: World = {}) {
	const request = vi.fn(async (route: string, _params?: unknown) => {
		if (route.startsWith("GET /repos/{owner}/{repo}/pulls/")) {
			return {
				data: {
					state,
					merged: false,
					node_id: "PR_1",
					auto_merge: autoMerge,
					head: { sha: head },
				},
			};
		}
		if (route === APPROVE && reviewError) throw reviewError;
		return { data: { id: 7, html_url: commentUrl } };
	});
	const paginate = vi.fn(async (route: string) =>
		route.endsWith("/reviews") ? reviews : [],
	);
	const graphql = vi.fn(async () => {
		if (graphqlError) throw graphqlError;
		return {};
	});
	const transport = {
		request,
		paginate,
		graphql,
	} as unknown as GithubTransport;
	const routes = () => request.mock.calls.map((c) => c[0]);
	const sent = (route: string) =>
		request.mock.calls.filter((c) => c[0] === route).map((c) => c[1]);
	return { transport, request, paginate, graphql, routes, sent };
}

const run = async (
	yaml: string,
	w: World = {},
	over: { files?: string[]; verdict?: "merge" | "escalate" } = {},
) => {
	const f = fake(w);
	const result = await act(f.transport, repo, {
		pullNumber: 3,
		snapshot: snapshot(over.files),
		config: await load(yaml),
		ctx,
		brief: brief(over.verdict),
		author,
	});
	return { ...f, result };
};

describe("modes", () => {
	it("off does nothing", async () => {
		const { request, graphql, paginate, result } = await run("mode: off");
		expect(request).not.toHaveBeenCalled();
		expect(graphql).not.toHaveBeenCalled();
		expect(paginate).not.toHaveBeenCalled();
		expect(result.skipped).toBe("mode_off");
	});

	it("shadow comments and sets status only", async () => {
		const { routes, graphql, result } = await run("mode: shadow");
		expect(routes()).toContain(STATUS);
		expect(routes()).not.toContain(APPROVE);
		expect(graphql).not.toHaveBeenCalled();
		expect(result).toEqual({ approved: false, queued: false });
	});

	it("enforce approves on the head sha and queues a squash auto-merge", async () => {
		const { request, graphql, result } = await run("mode: enforce");
		expect(request).toHaveBeenCalledWith(
			APPROVE,
			expect.objectContaining({ commit_id: "head1", event: "APPROVE" }),
		);
		expect(graphql).toHaveBeenCalledWith(
			expect.stringContaining("mergeMethod: SQUASH"),
			{ id: "PR_1", oid: "head1" },
		);
		expect(result).toEqual({ approved: true, queued: true });
	});
});

describe("enforce guards", () => {
	it("never approves or queues an escalate verdict", async () => {
		const { routes, graphql, result } = await run(
			"mode: enforce",
			{},
			{ verdict: "escalate" },
		);
		expect(routes()).not.toContain(APPROVE);
		expect(graphql).not.toHaveBeenCalled();
		expect(result.skipped).toBe("not_merge");
	});

	it("refuses a merge that touches a protected path", async () => {
		const { request, routes, graphql, result } = await run(
			"mode: enforce\npaths:\n  protected: [infra/]",
			{},
			{ files: ["infra/main.tf"] },
		);
		expect(routes()).not.toContain(APPROVE);
		expect(graphql).not.toHaveBeenCalled();
		expect(result.skipped).toBe("not_merge");
		expect(request).toHaveBeenCalledWith(
			STATUS,
			expect.objectContaining({ state: "pending" }),
		);
	});

	it("refuses a merge owned by the protected team", async () => {
		const f = fake();
		const result = await act(f.transport, repo, {
			pullNumber: 3,
			snapshot: snapshot(["core/x.ts"]),
			config: await load("mode: enforce\nteams:\n  protected: o/core"),
			ctx: { ...ctx, codeowners: [{ pattern: "core/", owners: ["@o/core"] }] },
			brief: brief(),
			author,
		});
		expect(f.routes()).not.toContain(APPROVE);
		expect(f.graphql).not.toHaveBeenCalled();
		expect(result.skipped).toBe("not_merge");
	});

	it("skips approval and queue when the head moved", async () => {
		const { routes, graphql, result } = await run("mode: enforce", {
			head: "head2",
		});
		expect(routes()).not.toContain(APPROVE);
		expect(graphql).not.toHaveBeenCalled();
		expect(result.skipped).toBe("stale_head");
	});
});

describe("idempotence", () => {
	it("does not approve or queue again on the same head", async () => {
		const { routes, graphql, result } = await run("mode: enforce", {
			autoMerge: { merge_method: "squash" },
			reviews: [
				{
					user: { login: "castellan[bot]" },
					state: "APPROVED",
					commit_id: "head1",
				},
			],
		});
		expect(routes()).not.toContain(APPROVE);
		expect(graphql).not.toHaveBeenCalled();
		expect(result).toEqual({ approved: true, queued: true });
	});

	it("approves again when the old approval was on an earlier head", async () => {
		const { routes } = await run("mode: enforce", {
			reviews: [
				{
					user: { login: "castellan[bot]" },
					state: "APPROVED",
					commit_id: "old",
				},
			],
		});
		expect(routes()).toContain(APPROVE);
	});
});

describe("more mode and guard cases", () => {
	it("off does nothing even for an escalate verdict", async () => {
		const { request, graphql, paginate } = await run(
			"mode: off",
			{},
			{ verdict: "escalate" },
		);
		expect(request).not.toHaveBeenCalled();
		expect(graphql).not.toHaveBeenCalled();
		expect(paginate).not.toHaveBeenCalled();
	});

	it("shadow with escalate sets a success status and takes no action", async () => {
		const { request, routes, graphql } = await run(
			"mode: shadow",
			{},
			{ verdict: "escalate" },
		);
		expect(request).toHaveBeenCalledWith(
			STATUS,
			expect.objectContaining({
				state: "success",
				description: expect.stringMatching(/^shadow: would escalate/),
			}),
		);
		expect(routes()).not.toContain(APPROVE);
		expect(graphql).not.toHaveBeenCalled();
	});

	it("shadow with a protected path escalates and takes no action", async () => {
		const { request, routes, graphql } = await run(
			"mode: shadow\npaths:\n  protected: [infra/]",
			{},
			{ files: ["infra/main.tf"] },
		);
		expect(request).toHaveBeenCalledWith(
			STATUS,
			expect.objectContaining({
				state: "success",
				description: expect.stringMatching(/^shadow: would escalate/),
			}),
		);
		expect(routes()).not.toContain(APPROVE);
		expect(graphql).not.toHaveBeenCalled();
	});

	it.each([".castellan.yml", ".github/workflows/ci.yml", "CODEOWNERS"])(
		"refuses a merge that touches %s",
		async (file) => {
			const { routes, graphql, result } = await run(
				"mode: enforce",
				{},
				{ files: [file] },
			);
			expect(routes()).not.toContain(APPROVE);
			expect(graphql).not.toHaveBeenCalled();
			expect(result.skipped).toBe("not_merge");
		},
	);

	it("does not act on a brief for a different head", async () => {
		const f = fake();
		const b = brief();
		const result = await act(f.transport, repo, {
			pullNumber: 3,
			snapshot: snapshot(),
			config: await load("mode: enforce"),
			ctx,
			brief: { ...b, key: { ...b.key, headSha: "other" } },
			author,
		});
		expect(f.request).not.toHaveBeenCalled();
		expect(result.skipped).toBe("stale_head");
	});

	it("reports a closed PR as not_open", async () => {
		const { routes, graphql, result } = await run("mode: enforce", {
			state: "closed",
		});
		expect(routes()).not.toContain(APPROVE);
		expect(graphql).not.toHaveBeenCalled();
		expect(result.skipped).toBe("not_open");
	});
});

describe("queue failures", () => {
	it("merges directly with the sha pinned on a clean status error", async () => {
		const { sent, result } = await run("mode: enforce", {
			graphqlError: new Error("Pull request is in clean status"),
		});
		expect(sent(MERGE)).toEqual([
			expect.objectContaining({ merge_method: "squash", sha: "head1" }),
		]);
		expect(result).toEqual({ approved: true, queued: true });
	});

	it("escalates status and comment on any other queue error", async () => {
		const { sent, routes, result } = await run("mode: enforce", {
			graphqlError: new Error("Auto merge is not allowed for this repository"),
		});
		expect(routes()).not.toContain(MERGE);
		expect(
			sent(STATUS).map((p) => (p as { state: string } | undefined)?.state),
		).toEqual(["success", "pending"]);
		const bodies = sent(COMMENT).map(
			(p) => (p as { body: string } | undefined)?.body,
		);
		expect(bodies.at(-1)).toContain("Auto merge is not allowed");
		expect(bodies.at(-1)).toContain("**Verdict: escalate**");
		expect(result).toEqual({
			approved: true,
			queued: false,
			skipped: "queue_failed",
		});
	});

	it("escalates without queuing when the review POST fails with 422", async () => {
		const { sent, graphql, result } = await run("mode: enforce", {
			reviewError: new Error(
				"Unprocessable Entity: Can not approve your own pull request",
			),
		});
		expect(graphql).not.toHaveBeenCalled();
		expect(sent(STATUS).at(-1)).toEqual(
			expect.objectContaining({ state: "pending" }),
		);
		expect(result).toEqual({
			approved: false,
			queued: false,
			skipped: "queue_failed",
		});
	});
});
