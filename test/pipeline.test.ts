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
}

function world({
	yaml = "mode: enforce\ntrustedAuthors: [alice]",
	draft = false,
	state = "open",
	issue,
}: World = {}) {
	const request = vi.fn(
		async (route: string, params: Record<string, unknown>) => {
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
			return [{ name: "test", conclusion: "success" }];
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
	it("approves and queues a merge verdict in enforce mode", async () => {
		const w = world();
		expect(await evaluatePull(w.env, repo, 3)).toBe("acted");
		expect(w.create).toHaveBeenCalledTimes(1);
		expect(w.routes()).toContain(COMMENT);
		expect(w.routes()).toContain(STATUS);
		expect(w.request).toHaveBeenCalledWith(
			APPROVE,
			expect.objectContaining({ commit_id: "head1", event: "APPROVE" }),
		);
		expect(w.graphql).toHaveBeenCalledTimes(1);
	});

	it("reads config from the base sha", async () => {
		const w = world();
		await evaluatePull(w.env, repo, 3);
		expect(w.request).toHaveBeenCalledWith(
			"GET /repos/{owner}/{repo}/contents/{path}",
			expect.objectContaining({ path: ".castellan.yml", ref: "base1" }),
		);
	});

	it("posts nothing for a skipped PR and never calls the model", async () => {
		const w = world({ draft: true });
		expect(await evaluatePull(w.env, repo, 3)).toBe("skipped");
		expect(w.routes()).not.toContain(COMMENT);
		expect(w.create).not.toHaveBeenCalled();
	});

	it("ignores a closed PR", async () => {
		const w = world({ state: "closed" });
		expect(await evaluatePull(w.env, repo, 3)).toBe("closed");
		expect(w.create).not.toHaveBeenCalled();
	});

	it("escalates on an invalid config in shadow mode, with no model call or approval", async () => {
		const w = world({ yaml: "mode: nonsense" });
		expect(await evaluatePull(w.env, repo, 3)).toBe("acted");
		const body = w.request.mock.calls.find((c) => c[0] === COMMENT)?.[1]
			?.body as string;
		expect(body).toContain("Verdict: escalate");
		expect(w.create).not.toHaveBeenCalled();
		expect(w.routes()).not.toContain(APPROVE);
	});

	it("fails closed when the model is unavailable", async () => {
		const w = world();
		w.create.mockRejectedValue(new Error("down"));
		await evaluatePull(w.env, repo, 3);
		expect(w.routes()).not.toContain(APPROVE);
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
