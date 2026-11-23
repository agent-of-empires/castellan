import { describe, expect, it, vi } from "vitest";
import { serializeBlock } from "../src/cache.js";
import type { GithubTransport } from "../src/github.js";
import type { MessagesClient } from "../src/llm.js";
import { evaluatePull, listWork, triageIssue } from "../src/pipeline.js";
import { MAX_THREAD_RERUNS } from "../src/threads.js";

const repo = { owner: "o", repo: "r" };
const COMMENT = "POST /repos/{owner}/{repo}/issues/{issue_number}/comments";
const APPROVE = "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews";
const STATUS = "POST /repos/{owner}/{repo}/statuses/{sha}";
const REVIEWERS =
	"POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers";
const PATCH_COMMENT =
	"PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}";

const verdict = { intent_match: true, new_behavior: false, reasons: [] };

type SnapshotFile = {
	filename: string;
	status: string;
	additions: number;
	deletions: number;
};

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
	/** A comment body to start from, as a head that already holds a block would. */
	stickyBody?: string;
	diff?: string;
	/** CODEOWNERS content; `yaml` stands in for it when unset. */
	codeowners?: string;
	files?: SnapshotFile[];
	/** Issue comments, e.g. castellan's own sticky comment. */
	comments?: { id: number; body: string; user: { login: string } }[];
	/** Thrown by the CODEOWNERS read instead of returning content. */
	codeownersError?: { status: number };
}

function world({
	yaml = "mode: enforce\ntrustedAuthors: [alice]",
	draft = false,
	state = "open",
	issue,
	checks = [{ name: "test", conclusion: "success" }],
	required = [],
	mergeable = true,
	stickyBody,
	diff = "diff --git a/src/a.ts b/src/a.ts",
	codeowners,
	files = [
		{
			filename: "src/a.ts",
			status: "modified",
			additions: 3,
			deletions: 1,
		},
	],
	comments = [],
	codeownersError,
}: World = {}) {
	/** Mutated by a test to move the PR to a new head between runs. */
	const headState = { head: "head1" };
	const posted = new Map<string, unknown>();
	let sticky: string | null = stickyBody ?? null;
	const request = vi.fn(
		async (route: string, params: Record<string, unknown>) => {
			if (route === STATUS) {
				posted.set(String(params.context), params);
				return { data: {} };
			}
			if (route === COMMENT || PATCH_COMMENT === route) {
				sticky = String(params.body ?? "");
				return { data: { id: 7, html_url: "https://github.com/o/r/pull/3#c" } };
			}
			if (route === "GET /repos/{owner}/{repo}/commits/{ref}/status") {
				return { data: { statuses: [...posted.values()] } };
			}
			if (route === "GET /repos/{owner}/{repo}") {
				return { data: { default_branch: "main" } };
			}
			if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
				const file = String(params.path);
				if (/CODEOWNERS$/.test(file)) {
					if (codeownersError !== undefined) throw codeownersError;
					if (codeowners !== undefined) return { data: codeowners };
				}
				if (yaml === null) throw { status: 404 };
				return { data: yaml };
			}
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
				if (params.mediaType) return { data: diff };
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
						head: { ref: "feat/x", sha: headState.head },
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
		if (route.endsWith("/comments")) {
			if (comments.length) return comments;
			if (sticky) {
				return [{ id: 7, user: { login: "castellan[bot]" }, body: sticky }];
			}
			return [];
		}
		if (route.endsWith("/files")) return files;
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
	/** The user message of the model call at `call`. */
	const sent = (call = 0) => {
		const args = create.mock.calls as unknown as
			| { messages?: { content?: string }[] }[][]
			| undefined;
		return args?.[call]?.[0]?.messages?.[0]?.content ?? "";
	};
	return { env, request, paginate, graphql, create, routes, sent, headState };
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
		expect(w.graphql).toHaveBeenCalledWith(
			expect.stringContaining("enablePullRequestAutoMerge"),
			expect.anything(),
		);
	});

	it("reads config at the base branch ref, not the stale base sha", async () => {
		const w = world();
		await evaluatePull(w.env, repo, 3);
		expect(w.request).toHaveBeenCalledWith(
			"GET /repos/{owner}/{repo}/contents/{path}",
			expect.objectContaining({ path: ".castellan.yml", ref: "main" }),
		);
	});

	it("names the CODEOWNERS team that owns the change on the brief", async () => {
		const w = world({ codeowners: "src/ @o/platform\n" });
		const r = await evaluatePull(w.env, repo, 3);
		expect(r.brief?.ownerTeam).toBe("platform");
	});

	it("carries the previous head's findings into the model input", async () => {
		const w = world({
			comments: [
				{
					id: 1,
					user: { login: "castellan[bot]" },
					body: `brief\n\n${serializeBlock({
						verdict: "escalate",
						headSha: "oldhead",
						promptHash: "old",
						model: "old-model",
						llm: {
							ok: true,
							verdict: {
								intent_match: true,
								new_behavior: false,
								reasons: [
									{ severity: "concern", text: "the retry cap is gone" },
								],
							},
							usage: { inputTokens: 1, outputTokens: 1 },
							costUsd: 0,
						},
					})}`,
				},
			],
		});
		await evaluatePull(w.env, repo, 3);
		expect(w.sent()).toContain("BEGIN previousFindings");
		expect(w.sent()).toContain("the retry cap is gone");
		expect(w.sent()).toContain("at oldhead");
	});

	it("carries findings forward after a head whose model run failed", async () => {
		const w = world({
			comments: [
				{
					id: 1,
					user: { login: "castellan[bot]" },
					body: `brief\n\n${serializeBlock({
						verdict: "escalate",
						headSha: "head1",
						promptHash: "old",
						model: "old-model",
						carry: {
							sha: "oldhead",
							reasons: [
								{ severity: "blocker", text: "the lock is never released" },
							],
						},
					})}`,
				},
			],
		});
		await evaluatePull(w.env, repo, 3);
		// The head has no llm part of its own, so the carried finding is what the
		// model sees, and it is written forward instead of being dropped.
		expect(w.sent()).toContain("the lock is never released");
		expect(w.sent()).toContain("at oldhead");
	});

	it("carries a finding across a head whose model run failed", async () => {
		const w = world({ yaml: "mode: shadow" });
		const body = () =>
			String(
				w.request.mock.calls
					.filter((c) => c[0] === COMMENT || c[0] === PATCH_COMMENT)
					.at(-1)?.[1]?.body,
			);
		w.create.mockResolvedValue({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						...verdict,
						reasons: [
							{
								severity: "blocker",
								text: "the lock is never released",
								path: "src/a.ts",
								line: 2,
							},
						],
					}),
				},
			],
			usage: { input_tokens: 1, output_tokens: 1 },
		});
		await evaluatePull(w.env, repo, 3);
		// An ok run stores its reasons in `llm`, so the block carries no second copy.
		expect(body()).not.toContain('"carry"');

		w.headState.head = "head2";
		w.create.mockRejectedValue(new Error("model down"));
		await evaluatePull(w.env, repo, 3);
		// The head with no model run writes the earlier finding forward.
		expect(body()).toContain('"carry"');

		w.headState.head = "head3";
		w.create.mockResolvedValue({
			content: [{ type: "text", text: JSON.stringify(verdict) }],
			usage: { input_tokens: 1, output_tokens: 1 },
		});
		await evaluatePull(w.env, repo, 3);
		expect(w.sent(w.create.mock.calls.length - 1)).toContain(
			"the lock is never released",
		);
	});

	it("still carries an earlier head's findings on a same-head re-run", async () => {
		const w = world({ yaml: "mode: shadow" });
		w.create.mockResolvedValue({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						intent_match: true,
						new_behavior: false,
						reasons: [{ severity: "concern", text: "the retry cap is gone" }],
					}),
				},
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		});
		await evaluatePull(w.env, repo, 3);
		w.graphql.mockResolvedValue({
			repository: {
				pullRequest: {
					reviewThreads: {
						pageInfo: { hasNextPage: false, endCursor: null },
						nodes: [
							{
								id: "T_1",
								isResolved: false,
								isOutdated: false,
								comments: {
									nodes: [
										{
											author: { __typename: "User", login: "someone" },
											path: "src/a.ts",
											line: 1,
											body: "please check this",
										},
									],
								},
							},
						],
					},
				},
			},
		});
		await evaluatePull(w.env, repo, 3);
		// A thread change re-runs the model on the same head; the earlier run's
		// findings must not disappear from the input just because the head matched.
		expect(w.sent(1)).toContain("BEGIN previousFindings");
		expect(w.sent(1)).toContain("the retry cap is gone");
	});

	it("names related open PRs even on a rule escalation in enforce", async () => {
		const w = world({ yaml: "mode: enforce\nlimits: { maxLines: 1 }" });
		w.graphql.mockResolvedValue({
			repository: {
				pullRequests: {
					nodes: [
						{
							number: 9,
							baseRefName: "main",
							files: { nodes: [{ path: "src/a.ts" }] },
						},
					],
				},
			},
		});
		const r = await evaluatePull(w.env, repo, 3);
		// The model never ran, and the brief a human reads still names the other PR.
		expect(w.create).not.toHaveBeenCalled();
		expect(r.brief?.related?.map((x) => x.number)).toEqual([9]);
		const body = w.request.mock.calls.find((c) => c[0] === COMMENT)?.[1]
			?.body as string;
		expect(body).toContain("#9");
	});

	it("gives the model the changed files as they read at the head", async () => {
		const w = world();
		await evaluatePull(w.env, repo, 3);
		expect(w.sent()).toContain("BEGIN files");
		expect(w.sent()).toContain("===== src/a.ts =====");
		expect(w.request).toHaveBeenCalledWith(
			"GET /repos/{owner}/{repo}/contents/{path}",
			expect.objectContaining({ path: "src/a.ts", ref: "head1" }),
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

	it("evaluates without an owner team when the CODEOWNERS read fails unprotected", async () => {
		// Without `teams.protected` the owner team only feeds a best effort review
		// request, so an unreadable CODEOWNERS must not fail the run.
		const w = world({ codeownersError: { status: 500 } });
		const r = await evaluatePull(w.env, repo, 3);
		expect(r).toMatchObject({ status: "acted" });
		expect(r.brief?.ownerTeam).toBeUndefined();
		expect(w.create).toHaveBeenCalled();
	});

	it("fails the run when the CODEOWNERS read fails under teams.protected", async () => {
		// The protected-paths rule reads CODEOWNERS, so an unreadable one has to
		// stay fail-closed rather than silently dropping the rule.
		const w = world({
			yaml: "teams: { protected: core }",
			codeownersError: { status: 500 },
		});
		await expect(evaluatePull(w.env, repo, 3)).rejects.toMatchObject({
			status: 500,
		});
		expect(w.create).not.toHaveBeenCalled();
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

	it("posts a model finding that lands on a diff line as an inline review comment", async () => {
		const w = world({
			yaml: "mode: enforce\nreview: { inline: true }\ntrustedAuthors: [alice]",
			diff: [
				"diff --git a/src/a.ts b/src/a.ts",
				"--- a/src/a.ts",
				"+++ b/src/a.ts",
				"@@ -1,2 +1,3 @@",
				" context",
				"+added",
			].join("\n"),
		});
		w.create.mockResolvedValue({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						intent_match: true,
						new_behavior: false,
						reasons: [
							{
								severity: "blocker",
								text: "no test covers this",
								path: "src/a.ts",
								line: 2,
							},
						],
					}),
				},
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		});
		const r = await evaluatePull(w.env, repo, 3);
		expect(r.brief?.inline).toEqual([{ index: 0, path: "src/a.ts", line: 2 }]);
		// A blocker in enforce asks for changes rather than only commenting.
		expect(w.request).toHaveBeenCalledWith(
			APPROVE,
			expect.objectContaining({
				event: "REQUEST_CHANGES",
				comments: [
					{
						path: "src/a.ts",
						line: 2,
						body: "no test covers this",
					},
				],
			}),
		);
	});

	it("gives the model the unresolved review threads and counts them in the brief", async () => {
		const w = world();
		w.graphql.mockResolvedValue({
			repository: {
				pullRequest: {
					reviewThreads: {
						pageInfo: { hasNextPage: false, endCursor: null },
						nodes: [
							{
								id: "T_1",
								isResolved: false,
								isOutdated: false,
								comments: {
									nodes: [
										{
											author: { __typename: "Bot", login: "coderabbitai" },
											path: "src/a.ts",
											line: 12,
											body: "the port is not recorded",
										},
									],
								},
							},
						],
					},
				},
			},
		});
		const r = await evaluatePull(w.env, repo, 3);
		expect(r.brief?.threads).toBe(1);
		expect(w.sent()).toContain("reviewThreads");
		expect(w.sent()).toContain("src/a.ts:12");
		const body = w.request.mock.calls.find((c) => c[0] === COMMENT)?.[1]
			?.body as string;
		expect(body).toContain("Unresolved review threads checked: 1");
	});

	it("does not read threads when the model is not going to run", async () => {
		const w = world({ yaml: "mode: enforce" });
		await evaluatePull(w.env, repo, 3);
		expect(w.graphql).not.toHaveBeenCalledWith(
			expect.stringContaining("reviewThreads"),
			expect.anything(),
		);
	});

	it("carries a finding past a head whose model run failed", async () => {
		const w = world();
		w.create.mockResolvedValueOnce({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						intent_match: true,
						new_behavior: false,
						reasons: [
							{
								severity: "blocker",
								text: "null deref",
								path: "src/a.ts",
								line: 12,
							},
						],
					}),
				},
			],
			usage: { input_tokens: 1, output_tokens: 1 },
		});
		await evaluatePull(w.env, repo, 3);
		// The next head's review fails, so its block publishes the carry instead of
		// an `llm` part; the head after that must still see what head A found.
		w.headState.head = "head2";
		w.create.mockRejectedValueOnce(new Error("down"));
		await evaluatePull(w.env, repo, 3);
		w.headState.head = "head3";
		await evaluatePull(w.env, repo, 3);
		const last = w.create.mock.calls.length - 1;
		expect(w.sent(last)).toContain("null deref");
		expect(w.sent(last)).toContain("at head1");
	});

	it("serves a same-head re-run from the cache, so no finding is restated", async () => {
		const w = world();
		await evaluatePull(w.env, repo, 3);
		await evaluatePull(w.env, repo, 3);
		expect(w.create).toHaveBeenCalledTimes(1);
		expect(w.sent()).not.toContain("An earlier automated review");
	});

	it("keeps the cached verdict when the thread read fails on a known head", async () => {
		const w = world({ yaml: "mode: shadow" });
		await evaluatePull(w.env, repo, 3);
		expect(w.create).toHaveBeenCalledTimes(1);
		w.graphql.mockRejectedValue(new Error("graphql down"));
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await evaluatePull(w.env, repo, 3);
		// A failed read is not "no threads": the stored verdict stands.
		expect(w.create).toHaveBeenCalledTimes(1);
	});

	it("escalates without a model call when threads fail and nothing is cached", async () => {
		const w = world({ yaml: "mode: shadow" });
		w.graphql.mockRejectedValue(new Error("graphql down"));
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const r = await evaluatePull(w.env, repo, 3);
		expect(w.create).not.toHaveBeenCalled();
		expect(r.brief?.outcome.reasons[0]?.rule).toBe("threads_unavailable");
	});

	it("bounds the model runs a head spends on thread changes", async () => {
		const w = world({ yaml: "mode: shadow" });
		const thread = (body: string) => ({
			repository: {
				pullRequest: {
					reviewThreads: {
						pageInfo: { hasNextPage: false, endCursor: null },
						nodes: [
							{
								id: "T_1",
								isResolved: false,
								isOutdated: false,
								comments: {
									nodes: [
										{
											author: { __typename: "User", login: "outsider" },
											path: "src/a.ts",
											line: 12,
											body,
										},
									],
								},
							},
						],
					},
				},
			},
		});
		w.graphql.mockResolvedValue(thread("first"));
		await evaluatePull(w.env, repo, 3);
		expect(w.create).toHaveBeenCalledTimes(1);
		// Each edit changes the key. Only MAX_THREAD_RERUNS edits may pay a model call.
		for (let i = 0; i < 6; i++) {
			w.graphql.mockResolvedValue(thread(`edit ${i}`));
			await evaluatePull(w.env, repo, 3);
		}
		expect(w.create).toHaveBeenCalledTimes(1 + MAX_THREAD_RERUNS);
		// Past the cap the stored verdict stands, so the brief must not claim a model
		// run read the threads that are there now.
		const brief = w.request.mock.calls
			.filter((c) => c[0] === COMMENT || c[0] === PATCH_COMMENT)
			.map((c) => String(c[1]?.body))
			.at(-1) as string;
		expect(brief).not.toContain("Unresolved review threads checked");
		expect(brief).toContain("used up its re-run budget");
	});

	it("counts the threads the reader capped out of the brief", async () => {
		const w = world({ yaml: "mode: shadow" });
		w.graphql.mockResolvedValue({
			repository: {
				pullRequest: {
					reviewThreads: {
						pageInfo: { hasNextPage: false, endCursor: null },
						nodes: Array.from({ length: 30 }, (_, i) => ({
							id: `T_${i}`,
							isResolved: false,
							isOutdated: false,
							comments: {
								nodes: [
									{
										author: { __typename: "User", login: `rev${i}` },
										path: "src/a.ts",
										line: 12,
										body: `finding ${i}`,
									},
								],
							},
						})),
					},
				},
			},
		});
		const r = await evaluatePull(w.env, repo, 3);
		// 25 reach the field, and the 5 the reader dropped are stated, not lost.
		expect(r.brief?.threads).toBe(25);
		expect(r.brief?.threadsDropped).toBe(5);
		const body = w.request.mock.calls.find((c) => c[0] === COMMENT)?.[1]
			?.body as string;
		expect(body).toContain("Unresolved review threads not sent: 5");
	});

	it("keeps a block written before threads existed when the read fails", async () => {
		const first = world({ yaml: "mode: shadow" });
		await evaluatePull(first.env, repo, 3);
		const body = first.request.mock.calls.find((c) => c[0] === COMMENT)?.[1]
			?.body as string;
		// An older block has no `threads` key at all.
		const old = body.replace(/,"threads":"[^"]*"/, "");
		expect(old).not.toContain('"threads"');
		const w = world({ yaml: "mode: shadow", stickyBody: old });
		w.graphql.mockRejectedValue(new Error("graphql down"));
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await evaluatePull(w.env, repo, 3);
		expect(w.create).not.toHaveBeenCalled();
	});
});

describe("file context", () => {
	const CONTENTS = "GET /repos/{owner}/{repo}/contents/{path}";

	it("reads the changed files with the most churn, skipping removed, unchanged and generated ones", async () => {
		const w = world({
			// A high line limit keeps the model running, so the file reads happen.
			yaml: "mode: shadow\nlimits: { maxLines: 5000 }",
			files: [
				{
					filename: "src/tiny.ts",
					status: "modified",
					additions: 1,
					deletions: 0,
				},
				{
					filename: "pnpm-lock.yaml",
					status: "modified",
					additions: 900,
					deletions: 100,
				},
				{
					filename: "src/big.ts",
					status: "modified",
					additions: 200,
					deletions: 100,
				},
				{
					filename: "src/gone.ts",
					status: "removed",
					additions: 0,
					deletions: 400,
				},
				{
					filename: "src/logo.png",
					status: "modified",
					additions: 0,
					deletions: 0,
				},
				{
					filename: "src/small.ts",
					status: "modified",
					additions: 3,
					deletions: 0,
				},
			],
		});
		await evaluatePull(w.env, repo, 3);
		const candidates = new Set([
			"src/tiny.ts",
			"pnpm-lock.yaml",
			"src/big.ts",
			"src/gone.ts",
			"src/logo.png",
			"src/small.ts",
		]);
		const read = w.request.mock.calls
			.filter((c) => c[0] === CONTENTS)
			.map((c) => (c[1] as { path: string }).path)
			// The config and CODEOWNERS reads share this route.
			.filter((p) => candidates.has(p));
		// Removed, binary and lockfile paths never spend an attempt, and the rest go
		// by churn, so the 6-attempt budget lands on the files with the most change.
		expect(read).toEqual(["src/big.ts", "src/small.ts", "src/tiny.ts"]);
	});
});

describe("asking for a reviewer", () => {
	it("asks once per head, including after the block is read back", async () => {
		const w = world({
			yaml: "mode: enforce\nlimits: { maxLines: 1 }\nreviewers: { team: platform, users: [bob] }",
		});
		await evaluatePull(w.env, repo, 3);
		// The second run reads its own block back, as a sweep on the same head would.
		await evaluatePull(w.env, repo, 3);
		const asked = w.request.mock.calls.filter((c) => c[0] === REVIEWERS);
		// Both halves landed, so neither is asked again.
		expect(asked).toHaveLength(2);
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
		expect(w.graphql).not.toHaveBeenCalledWith(
			expect.stringContaining("enablePullRequestAutoMerge"),
			expect.anything(),
		);
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

describe("triageIssue label filter", () => {
	it("a labeled event for another label starts no triage and no model call", async () => {
		const w = world();
		w.env.transport.graphql = vi.fn() as never;
		expect(await triageIssue(w.env, repo, 5, { label: "bug" })).toEqual({
			ok: true,
			skipped: "other label",
		});
		expect(w.env.transport.graphql).not.toHaveBeenCalled();
	});

	it("a labeled event for needs-triage triages", async () => {
		const w = world();
		w.env.transport.graphql = vi.fn(async () => ({
			repository: { issue: { id: "I", labels: { nodes: [] } } },
		})) as never;
		expect(
			await triageIssue(w.env, repo, 5, { label: "needs-triage" }),
		).toEqual({ ok: true, skipped: "no needs-triage label" });
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
