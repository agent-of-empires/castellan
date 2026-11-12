import { describe, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import type { MessagesClient } from "../src/llm.js";
import { evaluatePull, listWork, triageIssue } from "../src/pipeline.js";

const repo = { owner: "o", repo: "r" };
const COMMENT = "POST /repos/{owner}/{repo}/issues/{issue_number}/comments";
const APPROVE = "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews";
const STATUS = "POST /repos/{owner}/{repo}/statuses/{sha}";

const verdict = { intent_match: true, new_behavior: false, reasons: [] };

interface World {
	yaml?: string | null;
	draft?: boolean;
	state?: string;
	issue?: object;
	checks?: {
		name: string;
		conclusion: string | null;
		started_at?: string;
	}[];
	required?: string[];
	mergeable?: boolean | null;
}

function world({
	yaml = "mode: enforce\ntrustedAuthors: [alice]",
	draft = false,
	state = "open",
	issue,
	checks = [{ name: "test", conclusion: "success" }],
	required = [],
	mergeable = true,
}: World = {}) {
	const posted = new Map<string, unknown>();
	const request = vi.fn(
		async (route: string, params: Record<string, unknown>) => {
			if (route === STATUS) {
				posted.set(String(params.context), params);
				return { data: {} };
			}
			if (route === "GET /repos/{owner}/{repo}/commits/{ref}/status") {
				return { data: { statuses: [...posted.values()] } };
			}
			if (route === "GET /repos/{owner}/{repo}") {
				return { data: { default_branch: "main" } };
			}
			if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
				if (yaml === null) throw { status: 404 };
				return { data: yaml };
			}
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
				if (params.mediaType)
					return { data: "diff --git a/src/a.ts b/src/a.ts" };
				return {
					data: {
						title: "feat: x",
						body: "Closes #4",
						user: { login: "alice" },
						state,
						merged: false,
						draft,
						mergeable,
						node_id: "PR_1",
						auto_merge: null,
						base: { ref: "main", sha: "base1" },
						head: { ref: "feat/x", sha: "head1" },
					},
				};
			}
			if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}") {
				return {
					data: issue ?? {
						state: "open",
						title: "t",
						body: "issue body",
						labels: [],
					},
				};
			}
			return { data: { id: 7, html_url: "https://github.com/o/r/pull/3#c" } };
		},
	);
	const paginate = vi.fn(async (route: string): Promise<unknown[]> => {
		if (route.endsWith("/files")) {
			return [
				{
					filename: "src/a.ts",
					status: "modified",
					additions: 3,
					deletions: 1,
				},
			];
		}
		if (route.endsWith("/check-runs")) {
			return checks;
		}
		if (route.endsWith("/rules/branches/{branch}")) {
			return [
				{
					type: "required_status_checks",
					parameters: {
						required_status_checks: required.map((context) => ({ context })),
					},
				},
			];
		}
		return [];
	});
	const graphql = vi.fn(async () => ({}));
	const transport = {
		request,
		paginate,
		graphql,
	} as unknown as GithubTransport;
	const create = vi.fn(async () => ({
		content: [{ type: "text", text: JSON.stringify(verdict) }],
		usage: { input_tokens: 10, output_tokens: 5 },
	}));
	const env = {
		transport,
		login: "castellan[bot]",
		llm: { client: { messages: { create } } as unknown as MessagesClient },
	};
	const routes = () => request.mock.calls.map((c) => c[0]);
	return { env, request, paginate, graphql, create, routes };
}

describe("evaluatePull", () => {
	it("posts no status when an unchanged PR is evaluated again", async () => {
		const w = world();
		await evaluatePull(w.env, repo, 3);
		const count = () => w.routes().filter((r) => r === STATUS).length;
		expect(count()).toBe(1);
		await evaluatePull(w.env, repo, 3);
		expect(count()).toBe(1);
	});

	it("posts no waiting status twice for the same wait", async () => {
		const w = world({ checks: [{ name: "test", conclusion: null }] });
		await evaluatePull(w.env, repo, 3);
		await evaluatePull(w.env, repo, 3);
		expect(w.routes().filter((r) => r === STATUS)).toHaveLength(1);
	});

	it("approves and queues a merge verdict in enforce mode", async () => {
		const w = world();
		expect(await evaluatePull(w.env, repo, 3)).toMatchObject({
			status: "acted",
		});
		expect(w.create).toHaveBeenCalledTimes(1);
		expect(w.routes()).toContain(COMMENT);
		expect(w.routes()).toContain(STATUS);
		expect(w.request).toHaveBeenCalledWith(
			APPROVE,
			expect.objectContaining({ commit_id: "head1", event: "APPROVE" }),
		);
		expect(w.graphql).toHaveBeenCalledTimes(1);
	});

	it("reads config at the base branch ref, not the stale base sha", async () => {
		const w = world();
		await evaluatePull(w.env, repo, 3);
		expect(w.request).toHaveBeenCalledWith(
			"GET /repos/{owner}/{repo}/contents/{path}",
			expect.objectContaining({ path: ".castellan.yml", ref: "main" }),
		);
	});

	it("reads CODEOWNERS at the base branch ref", async () => {
		const w = world({ yaml: "teams: { protected: core }" });
		await evaluatePull(w.env, repo, 3);
		expect(w.request).toHaveBeenCalledWith(
			"GET /repos/{owner}/{repo}/contents/{path}",
			expect.objectContaining({ path: ".github/CODEOWNERS", ref: "main" }),
		);
	});

	it("posts nothing for a skipped PR and never calls the model", async () => {
		const w = world({ draft: true });
		expect(await evaluatePull(w.env, repo, 3)).toMatchObject({
			status: "skipped",
		});
		expect(w.routes()).not.toContain(COMMENT);
		expect(w.create).not.toHaveBeenCalled();
	});

	it("ignores a closed PR", async () => {
		const w = world({ state: "closed" });
		expect(await evaluatePull(w.env, repo, 3)).toMatchObject({
			status: "closed",
		});
		expect(w.create).not.toHaveBeenCalled();
	});

	it("escalates on an invalid config in shadow mode, with no model call or approval", async () => {
		const w = world({ yaml: "mode: nonsense" });
		expect(await evaluatePull(w.env, repo, 3)).toMatchObject({
			status: "acted",
		});
		const body = w.request.mock.calls.find((c) => c[0] === COMMENT)?.[1]
			?.body as string;
		expect(body).toContain("Verdict: escalate");
		expect(w.create).not.toHaveBeenCalled();
		expect(w.routes()).not.toContain(APPROVE);
	});

	it("runs the model on a rule escalation in shadow, as advice only", async () => {
		const w = world({ yaml: "mode: shadow" });
		await evaluatePull(w.env, repo, 3);
		expect(w.create).toHaveBeenCalledOnce();
		const body = w.request.mock.calls.find((c) => c[0] === COMMENT)?.[1]
			?.body as string;
		expect(body).toContain("**Verdict: escalate** (shadow)");
		expect(body).toContain("advisory, rules decided the verdict");
		expect(
			w.request.mock.calls.find((c) => c[0] === STATUS)?.[1],
		).toMatchObject({ state: "success" });
	});

	it("keeps the rule verdict and a shadow status when the model call fails", async () => {
		const w = world({ yaml: "mode: shadow" });
		w.create.mockRejectedValue(new Error("down"));
		const r = await evaluatePull(w.env, repo, 3);
		const reasons = r.brief?.outcome.reasons ?? [];
		expect(reasons.length).toBeGreaterThan(0);
		expect(reasons.some((x) => x.rule.startsWith("llm_"))).toBe(false);
		expect(r.brief?.reviewError).toBe("sdk_error");
		expect(
			w.request.mock.calls.find((c) => c[0] === STATUS)?.[1],
		).toMatchObject({
			state: "success",
			description: expect.stringMatching(/^shadow: would escalate \(.+\)$/),
		});
	});

	it("logs the failure detail when the model call fails", async () => {
		const w = world({ yaml: "mode: shadow" });
		w.create.mockRejectedValue(new Error("AccessDeniedException: no access"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await evaluatePull(w.env, repo, 3);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith("model review failed", {
			error: "sdk_error",
			detail: expect.stringContaining("AccessDeniedException"),
		});
		warn.mockRestore();
	});

	it("leaves the reasons unchanged when the model vetoes a rule escalation in shadow", async () => {
		const base = world({ yaml: "mode: shadow" });
		const expected = (await evaluatePull(base.env, repo, 3)).brief?.outcome
			.reasons;
		const w = world({ yaml: "mode: shadow" });
		w.create.mockResolvedValue({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						intent_match: false,
						new_behavior: true,
						reasons: [{ severity: "blocker", text: "bad" }],
					}),
				},
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		});
		const r = await evaluatePull(w.env, repo, 3);
		expect(r.brief?.outcome.reasons).toEqual(expected);
		expect(r.brief?.review?.verdict.intent_match).toBe(false);
	});

	it("does not run the model on a rule escalation in enforce", async () => {
		const w = world({ yaml: "mode: enforce" });
		await evaluatePull(w.env, repo, 3);
		expect(w.create).not.toHaveBeenCalled();
		const body = w.request.mock.calls.find((c) => c[0] === COMMENT)?.[1]
			?.body as string;
		expect(body).toContain("Model: not run (rules decided)");
	});

	it("fails closed when the model is unavailable", async () => {
		const w = world();
		w.create.mockRejectedValue(new Error("down"));
		await evaluatePull(w.env, repo, 3);
		expect(w.routes()).not.toContain(APPROVE);
	});
});

describe("mode override", () => {
	it("wins over the config in both directions", async () => {
		const shadow = world();
		await evaluatePull({ ...shadow.env, mode: "shadow" }, repo, 3);
		expect(shadow.routes()).toContain(COMMENT);
		expect(shadow.routes()).not.toContain(APPROVE);

		const enforce = world({ yaml: "mode: shadow\ntrustedAuthors: [alice]" });
		await evaluatePull({ ...enforce.env, mode: "enforce" }, repo, 3);
		expect(enforce.routes()).toContain(APPROVE);
	});

	it("Env.mode off overrides triage.enabled true", async () => {
		const w = world({ yaml: "mode: shadow\ntriage: { enabled: true }" });
		expect(await triageIssue({ ...w.env, mode: "off" }, repo, 5)).toEqual({
			ok: true,
			skipped: "off",
		});
	});

	it("triage.enabled false skips triage while PRs are still evaluated", async () => {
		const w = world({
			yaml: "mode: shadow\ntriage: { enabled: false }\ntrustedAuthors: [alice]",
		});
		expect(await triageIssue(w.env, repo, 5)).toEqual({
			ok: true,
			skipped: "off",
		});
		await evaluatePull(w.env, repo, 3);
		expect(w.routes()).toContain(COMMENT);
	});

	it("keeps the PR gate in shadow while triage is enabled", async () => {
		const w = world({
			yaml: "mode: shadow\ntriage: { enabled: true }\ntrustedAuthors: [alice]",
		});
		await evaluatePull(w.env, repo, 3);
		expect(w.routes()).toContain(COMMENT);
		expect(w.routes()).not.toContain(APPROVE);
		const statuses = w.request.mock.calls.filter(([r]) => r === STATUS);
		expect(statuses.length).toBeGreaterThan(0);
		for (const [, p] of statuses) {
			expect((p as { description: string }).description).toMatch(/^shadow:/);
		}
	});

	it("also applies to the fallback config of an invalid file", async () => {
		const w = world({ yaml: "mode: nonsense" });
		const r = await evaluatePull({ ...w.env, mode: "enforce" }, repo, 3);
		// still escalates (config_invalid), so nothing is approved
		expect(r).toMatchObject({ status: "acted" });
		expect(w.routes()).not.toContain(APPROVE);
	});
});

describe("mode off", () => {
	it("exits before the snapshot, team lookup and checks", async () => {
		const w = world({ yaml: "mode: off\nteams:\n  maintainers: m" });
		expect(await evaluatePull(w.env, repo, 3)).toEqual({ status: "skipped" });
		expect(w.paginate).not.toHaveBeenCalled();
		expect(w.routes()).not.toContain(STATUS);
		expect(w.routes()).not.toContain(
			"GET /orgs/{org}/teams/{team_slug}/memberships/{username}",
		);
		expect(w.create).not.toHaveBeenCalled();
	});
});

describe("waiting for CI", () => {
	const statusBody = (w: ReturnType<typeof world>) =>
		w.request.mock.calls.find((c) => c[0] === STATUS)?.[1];
	const writes = (w: ReturnType<typeof world>) =>
		w.routes().filter((r) => r.startsWith("POST") && r !== STATUS);

	it("posts only a pending status when no check run exists yet", async () => {
		const w = world({ checks: [], required: ["test"] });
		expect(await evaluatePull(w.env, repo, 3)).toEqual({ status: "waiting" });
		expect(w.create).not.toHaveBeenCalled();
		expect(writes(w)).toEqual([]);
		expect(w.routes()).not.toContain(
			"PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
		);
		expect(statusBody(w)).toMatchObject({
			sha: "head1",
			state: "pending",
			description: "castellan: waiting for CI",
		});
	});

	it("waits on a queued optional check, with a shadow description in shadow", async () => {
		const w = world({
			yaml: "mode: shadow",
			checks: [
				{ name: "test", conclusion: "success" },
				{ name: "docs", conclusion: null },
			],
		});
		expect(await evaluatePull(w.env, repo, 3)).toEqual({ status: "waiting" });
		expect(statusBody(w)).toMatchObject({
			state: "pending",
			description: "shadow: waiting for CI",
		});
	});

	it("writes nothing in a dry run", async () => {
		const w = world({ checks: [], required: ["test"] });
		expect(await evaluatePull(w.env, repo, 3, { dryRun: true })).toEqual({
			status: "waiting",
		});
		expect(w.routes()).not.toContain(STATUS);
	});

	it("escalates a merge conflict instead of waiting", async () => {
		const w = world({ checks: [], required: ["test"], mergeable: false });
		const r = await evaluatePull(w.env, repo, 3);
		expect(r.status).toBe("acted");
		expect(r.brief?.outcome.reasons.map((x) => x.rule)).toEqual([
			"merge_conflict",
		]);
	});

	it("escalates a settled PR with a failed required check", async () => {
		const w = world({
			checks: [{ name: "test", conclusion: "failure" }],
			required: ["test"],
		});
		const r = await evaluatePull(w.env, repo, 3);
		expect(r.brief?.outcome.reasons).toEqual([
			{ rule: "required_check", text: "required check test did not pass" },
		]);
	});
});

describe("stale required check", () => {
	const STARTED = "2026-01-01T00:00:00Z";
	const at = (minutes: number) => Date.parse(STARTED) + minutes * 60_000;
	const stale = () =>
		world({
			yaml: "mode: shadow",
			checks: [
				{ name: "test", conclusion: "in_progress", started_at: STARTED },
			],
			required: ["test"],
		});

	it("posts one status across sweeps while the check stays stale", async () => {
		vi.useFakeTimers();
		try {
			const w = stale();
			vi.setSystemTime(at(61));
			await evaluatePull(w.env, repo, 3);
			vi.setSystemTime(at(91));
			await evaluatePull(w.env, repo, 3);
			expect(w.routes().filter((r) => r === STATUS)).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("waits at exactly the limit and escalates one millisecond later", async () => {
		vi.useFakeTimers();
		try {
			const w = stale();
			vi.setSystemTime(at(60));
			expect(await evaluatePull(w.env, repo, 3)).toEqual({ status: "waiting" });
			vi.setSystemTime(at(60) + 1);
			const r = await evaluatePull(w.env, repo, 3);
			expect(r.brief?.outcome.reasons.map((x) => x.rule)).toEqual([
				"required_check_stale",
			]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("fail closed", () => {
	it("sets a pending status and rethrows when a step after the snapshot throws", async () => {
		const w = world();
		const base = w.paginate.getMockImplementation();
		w.paginate.mockImplementation(async (route: string) => {
			if (route.includes("/rules/branches/")) throw new Error("boom");
			return (base ? base(route) : []) as unknown[];
		});
		await expect(evaluatePull(w.env, repo, 3)).rejects.toThrow("boom");
		expect(w.request).toHaveBeenCalledWith(
			STATUS,
			expect.objectContaining({
				sha: "head1",
				context: "castellan",
				state: "pending",
				description: "castellan: internal error",
			}),
		);
		expect(w.routes()).not.toContain(APPROVE);
	});

	it("posts the internal error status once when the same PR fails twice", async () => {
		const w = world();
		const base = w.paginate.getMockImplementation();
		w.paginate.mockImplementation(async (route: string) => {
			if (route.includes("/rules/branches/")) throw new Error("boom");
			return (base ? base(route) : []) as unknown[];
		});
		await expect(evaluatePull(w.env, repo, 3)).rejects.toThrow("boom");
		await expect(evaluatePull(w.env, repo, 3)).rejects.toThrow("boom");
		expect(w.routes().filter((r) => r === STATUS)).toHaveLength(1);
	});

	it("sets a pending status and rethrows when the team lookup throws", async () => {
		const w = world({ yaml: "mode: enforce\nteams:\n  maintainers: m" });
		const base = w.request.getMockImplementation();
		w.request.mockImplementation(async (route, params) => {
			if (route.includes("/teams/")) throw new Error("teams down");
			return (base ? base(route, params) : { data: {} }) as never;
		});
		await expect(evaluatePull(w.env, repo, 3)).rejects.toThrow("teams down");
		expect(w.request).toHaveBeenCalledWith(
			STATUS,
			expect.objectContaining({
				sha: "head1",
				state: "pending",
				description: "castellan: internal error",
			}),
		);
		expect(w.routes()).not.toContain(COMMENT);
	});

	it("also covers an act failure", async () => {
		const w = world();
		const base = w.request.getMockImplementation();
		w.request.mockImplementation(async (route, params) => {
			if (route === COMMENT) throw new Error("comment down");
			return (base ? base(route, params) : { data: {} }) as never;
		});
		await expect(evaluatePull(w.env, repo, 3)).rejects.toThrow("comment down");
		expect(
			w.request.mock.calls.filter(
				([r, p]) =>
					r === STATUS &&
					(p as { description?: string }).description ===
						"castellan: internal error",
			),
		).toHaveLength(1);
	});

	it("still rethrows the original error if the status write fails", async () => {
		const w = world();
		const base = w.request.getMockImplementation();
		w.request.mockImplementation(async (route, params) => {
			if (route === COMMENT) throw new Error("comment down");
			if (route === STATUS) throw new Error("status down");
			return (base ? base(route, params) : { data: {} }) as never;
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(evaluatePull(w.env, repo, 3)).rejects.toThrow("comment down");
	});
});

describe("dryRun", () => {
	it("returns the brief and writes nothing", async () => {
		const w = world();
		const res = await evaluatePull(w.env, repo, 3, { dryRun: true });
		expect(res.status).toBe("dry_run");
		expect(res.brief?.outcome.verdict).toBe("merge");
		expect(res.act).toBeUndefined();
		for (const r of [COMMENT, STATUS, APPROVE]) {
			expect(w.routes()).not.toContain(r);
		}
		expect(w.graphql).not.toHaveBeenCalled();
	});

	it("does not set a failure status either", async () => {
		const w = world();
		w.create.mockRejectedValue(new Error("down"));
		const res = await evaluatePull(w.env, repo, 3, { dryRun: true });
		expect(res.brief?.outcome.verdict).toBe("escalate");
		expect(w.routes()).not.toContain(STATUS);
	});
});

describe("triageIssue", () => {
	it("skips pull requests and closed issues", async () => {
		const pr = world({
			issue: { state: "open", pull_request: {}, labels: [] },
		});
		expect(await triageIssue(pr.env, repo, 5)).toBe("closed");
		const closed = world({ issue: { state: "closed", labels: [] } });
		expect(await triageIssue(closed.env, repo, 5)).toBe("closed");
	});

	it("runs triage; a needs-triage label is required", async () => {
		const w = world();
		w.env.transport.graphql = vi.fn(async () => ({
			repository: { issue: { id: "I", labels: { nodes: [] } } },
		})) as never;
		expect(await triageIssue(w.env, repo, 5)).toEqual({
			ok: true,
			skipped: "no needs-triage label",
		});
	});
});

describe("listWork", () => {
	it("lists open PRs and needs-triage issues, dropping PRs from the issue list", async () => {
		const w = world();
		w.paginate.mockImplementation(async (route: string) =>
			route.endsWith("/pulls")
				? [{ number: 1 }, { number: 2 }]
				: [{ number: 8 }, { number: 9, pull_request: {} }],
		);
		expect(await listWork(w.env, repo)).toEqual({ pulls: [1, 2], issues: [8] });
		expect(w.paginate).toHaveBeenCalledWith(
			"GET /repos/{owner}/{repo}/issues",
			expect.objectContaining({ labels: "needs-triage", state: "open" }),
		);
	});
});
