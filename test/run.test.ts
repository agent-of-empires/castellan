import { describe, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import type { MessagesClient } from "../src/llm.js";
import { dryRun, failed, runForIssue, runForPr, sweep } from "../src/run.js";

const repo = { owner: "o", repo: "r" };
const author = { login: "castellan[bot]" };
const COMMENT = "POST /repos/{owner}/{repo}/issues/{issue_number}/comments";
const APPROVE = "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews";

interface World {
	config?: string | null;
	draft?: boolean;
	files?: { filename: string; additions: number; deletions: number }[];
	login?: string;
}

function fake(w: World = {}) {
	let sticky: string | null = null;
	const files = w.files ?? [
		{ filename: "src/a.ts", additions: 2, deletions: 1 },
	];
	const request = vi.fn(
		async (
			route: string,
			p: { path?: string; mediaType?: object; body?: string } = {},
		) => {
			if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
				if (p.path === ".castellan.yml" && w.config != null) {
					return { data: w.config };
				}
				throw Object.assign(new Error("nf"), { status: 404 });
			}
			if (route === "GET /repos/{owner}/{repo}") {
				return { data: { default_branch: "main" } };
			}
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
				if (p.mediaType) return { data: "+a" };
				return {
					data: {
						state: "open",
						merged: false,
						draft: w.draft ?? false,
						title: "fix: a",
						body: "Closes #5",
						node_id: "PR_1",
						auto_merge: null,
						user: { login: w.login ?? "alice", type: "User" },
						base: { ref: "main", sha: "base1" },
						head: { ref: "fix-a", sha: "head1" },
					},
				};
			}
			if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}") {
				return {
					data: {
						title: "t",
						body: "the issue",
						labels: [{ name: "bug" }],
					},
				};
			}
			if (route === COMMENT) {
				sticky = p.body ?? null;
				return { data: { id: 7, html_url: "https://x/c" } };
			}
			return { data: { id: 7, html_url: "https://x/c" } };
		},
	);
	const paginate = vi.fn(async (route: string) => {
		if (route.endsWith("/files")) return files;
		if (route.endsWith("/comments") && sticky) {
			return [{ id: 7, user: { login: "castellan[bot]" }, body: sticky }];
		}
		if (route === "GET /repos/{owner}/{repo}/pulls") {
			return [
				{ number: 1, draft: false },
				{ number: 2, draft: true },
			];
		}
		if (route === "GET /repos/{owner}/{repo}/issues") {
			return [{ number: 9 }, { number: 10, pull_request: {} }];
		}
		return [];
	});
	const graphql = vi.fn(async () => ({}));
	const transport = {
		request,
		paginate,
		graphql,
	} as unknown as GithubTransport;
	const routes = () => request.mock.calls.map((c) => c[0]);
	return { transport, request, graphql, routes };
}

const llm = (verdict: object) => {
	const create = vi.fn(async () => ({
		content: [{ type: "text", text: JSON.stringify(verdict) }],
		usage: { input_tokens: 10, output_tokens: 5 },
	}));
	return {
		create,
		deps: { client: { messages: { create } } as unknown as MessagesClient },
	};
};
const merge = { intent_match: true, new_behavior: false, reasons: [] };

describe("runForPr", () => {
	it("fails closed on an invalid config without writing", async () => {
		const f = fake({ config: "mode: nope" });
		const r = await runForPr({ transport: f.transport, repo, author }, 3);
		expect(r.status).toBe("config_error");
		expect(failed({ kind: "pr", number: 3, result: r })).toBe(true);
		expect(f.routes()).not.toContain(COMMENT);
	});

	it("skips a draft without calling the model or writing", async () => {
		const f = fake({ draft: true });
		const m = llm(merge);
		const r = await runForPr(
			{ transport: f.transport, repo, author, llm: m.deps },
			3,
		);
		expect(r).toMatchObject({ status: "skipped" });
		expect(m.create).not.toHaveBeenCalled();
		expect(f.routes()).not.toContain(COMMENT);
	});

	it("escalates on rules alone and never calls the model", async () => {
		const f = fake({
			files: [{ filename: ".github/x.yml", additions: 1, deletions: 0 }],
		});
		const m = llm(merge);
		const r = await runForPr(
			{ transport: f.transport, repo, author, llm: m.deps },
			3,
		);
		expect(r).toMatchObject({
			status: "done",
			brief: { outcome: { verdict: "escalate" }, source: "skipped" },
		});
		expect(m.create).not.toHaveBeenCalled();
		expect(f.routes()).toContain(COMMENT);
	});

	it("shadow posts a merge brief but never approves", async () => {
		const f = fake();
		const r = await runForPr(
			{ transport: f.transport, repo, author, llm: llm(merge).deps },
			3,
		);
		expect(r).toMatchObject({
			status: "done",
			brief: { outcome: { verdict: "merge" }, source: "llm" },
			act: { approved: false, queued: false },
		});
		expect(f.routes()).not.toContain(APPROVE);
	});

	it("enforce approves, and the mode override wins over the config", async () => {
		const f = fake({ config: "mode: shadow" });
		const r = await runForPr(
			{
				transport: f.transport,
				repo,
				author,
				llm: llm(merge).deps,
				mode: "enforce",
			},
			3,
		);
		expect(f.routes()).toContain(APPROVE);
		expect(r).toMatchObject({ act: { approved: true, queued: true } });
	});

	it("reuses the cached review for the same head", async () => {
		const f = fake();
		const m = llm(merge);
		const deps = { transport: f.transport, repo, author, llm: m.deps };
		await runForPr(deps, 3);
		const again = await runForPr(deps, 3);
		expect(m.create).toHaveBeenCalledTimes(1);
		expect(again).toMatchObject({ brief: { source: "cache" } });
	});
});

describe("dryRun", () => {
	it("prints the brief and makes no write, even in enforce", async () => {
		const f = fake();
		const printed: string[] = [];
		const deps = dryRun(
			{
				transport: f.transport,
				repo,
				author,
				llm: llm(merge).deps,
				mode: "enforce",
			},
			(b) => printed.push(b),
		);
		const r = await runForPr(deps, 3);
		expect(r).toMatchObject({ status: "done", act: { approved: false } });
		expect(printed.join("")).toContain("Castellan brief");
		const writes = f.routes().filter((x) => !x.startsWith("GET "));
		expect(writes).toEqual([]);
		expect(f.graphql).not.toHaveBeenCalled();
	});
});

describe("runForIssue and sweep", () => {
	it("triages from the default branch config; off skips", async () => {
		const f = fake({ config: "mode: off" });
		const r = await runForIssue({ transport: f.transport, repo, author }, 4);
		expect(r).toEqual({
			status: "triaged",
			triage: { ok: true, skipped: "off" },
		});
	});

	it("sweeps open non-draft PRs and labeled issues, not PRs listed as issues", async () => {
		const f = fake({ config: "mode: off" });
		const items = await sweep({ transport: f.transport, repo, author });
		expect(items.map((i) => `${i.kind}${i.number}`)).toEqual(["pr1", "issue9"]);
	});
});
